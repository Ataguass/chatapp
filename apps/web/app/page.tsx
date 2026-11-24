"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { io, type Socket } from "socket.io-client";
import type { ConversationPage, ConversationSummary, MessageDeletedEvent, MessagePage, MessageSyncPage, PublicMessage, PublicUser } from "@messaging/contracts";
import { ChatDialog } from "./chat-dialog";
import { ChatSettings, type ProfileFields } from "./chat-settings";
import { CallHistory } from "./call-history";
import { ConversationDetails, InvitationDialog } from "./conversation-details";
import { StoriesDialog } from "./stories";
import { RecoveryDialog } from "./account-security";
import { CallPanel, useDirectCall } from "./direct-call";
import { mergeMessages } from "../lib/message-history";
import { api } from "../lib/client-api";
import { Avatar, Icon } from "./ui";

const noMessages: PublicMessage[] = [];
type AuthMode = "login" | "register";
type ModalMode = "chat" | "group" | null;
type Workspace = "chats" | "calls" | "settings";
const navigation = [
  { view: "chats", label: "Chats", icon: "message" },
  { view: "calls", label: "Calls", icon: "phone" },
  { view: "settings", label: "Settings", icon: "settings" },
] as const;
const conversationLink = /^#chat\/([a-f0-9-]{36})$/i;

function conversationName(conversation: ConversationSummary, userId: string) {
  if (conversation.type === "group") return conversation.title || "Untitled group";
  return conversation.participants.find(person => person.id !== userId)?.displayName ?? "Deleted account";
}

function conversationSubtitle(conversation: ConversationSummary, userId: string) {
  if (conversation.type === "group") return `${conversation.participants.length} members`;
  const peer = conversation.participants.find(person => person.id !== userId);
  return peer ? `@${peer.username}` : "Read-only conversation";
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function AuthScreen({ onAuthenticated, notice }: { onAuthenticated: (user: PublicUser) => void; notice: string }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recovered, setRecovered] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, username, password, displayName }),
      });
      const payload = await response.json() as PublicUser & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not sign in");
      onAuthenticated(payload);
    } catch (caught) {
      setError(caught instanceof Error ? authError(caught.message) : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-screen">
    <section className="auth-story">
      <div className="brand brand-light"><span className="brand-mark"><Icon name="message" size={19} /></span><span>chatapp</span></div>
      <div className="story-copy"><h1>Private messaging</h1><p>Chats, stories, and calls with the people you choose.</p></div>
      <div className="story-orbit orbit-one" /><div className="story-orbit orbit-two" />
    </section>
    <section className="auth-panel">
      <div className="auth-form-wrap">
        <div className="auth-heading"><span className="mobile-auth-brand">Chatapp</span><h2>{mode === "login" ? "Sign in to Chatapp" : "Create your account"}</h2>{mode === "register" && <p>Choose a username your friends can find.</p>}</div>
        {(recovered || notice) && <p className="dialog-feedback" role="status">{recovered ? "Password reset. Sign in with your new password, then generate new recovery codes in Settings." : notice}</p>}
        <form className="auth-form" onSubmit={submit}>
          {mode === "register" && <label>Display name<input autoComplete="name" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="What should we call you?" maxLength={100} /></label>}
          <label>Username<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} placeholder="your_username" minLength={3} maxLength={32} required /></label>
          <label>Password<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={event => setPassword(event.target.value)} placeholder={mode === "register" ? "At least 12 characters" : undefined} minLength={12} maxLength={128} required /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button auth-submit" disabled={busy}>{busy ? <span className="spinner" /> : null}{mode === "login" ? "Sign in" : "Create account"}</button>
        </form>
        {mode === "login" && <p className="auth-switch"><button type="button" onClick={() => setRecovering(true)}>Forgot password?</button></p>}
        <p className="auth-switch">{mode === "login" ? "New around here?" : "Already have an account?"} <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "Create an account" : "Sign in"}</button></p>
      </div>
    </section>
    {recovering && <RecoveryDialog initialUsername={username} onClose={() => setRecovering(false)} onRecovered={name => {
      setUsername(name); setPassword(""); setError(""); setRecovering(false); setRecovered(true);
    }} />}
  </main>;
}

function authError(code: string) {
  const messages: Record<string, string> = {
    invalid_credentials: "That username and password don't match.",
    username_taken: "That username is already taken.",
    auth_rate_limited: "Too many attempts. Wait a few minutes and try again.",
    auth_temporarily_unavailable: "Sign-in is temporarily unavailable. Try again shortly.",
    invalid_username: "Use 3–32 letters, numbers, or underscores.",
    invalid_password: "Choose a password with at least 12 characters.",
    conversation_closed: "This chat is read-only because the other account was deleted.",
    conversation_access_denied: "You no longer have access to this conversation.",
    messaging_blocked: "Messaging is unavailable in this chat.",
    reply_target_not_found: "That message is no longer available. Cancel the reply and try again.",
    attachment_too_large: "This file exceeds the upload limit for its type.",
    unsupported_media_type: "Choose an image, MP4 video, MP3/WAV audio file, or PDF.",
    media_signature_mismatch: "The file contents don't match the selected file type.",
    service_unavailable: "The chat service is unavailable right now.",
  };
  return messages[code] ?? "We couldn't complete that request. Check your details and try again.";
}

export default function Home() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timelines, setTimelines] = useState<Record<string, PublicMessage[]>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState("");
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [modal, setModal] = useState<ModalMode>(null);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const [accountNotice, setAccountNotice] = useState("");
  const [socketOnline, setSocketOnline] = useState(false);
  const [liveSocket, setLiveSocket] = useState<Socket | null>(null);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>("chats");
  const [compact, setCompact] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedMessages, setSelectedMessages] = useState<string[]>([]);
  const [deleteTargets, setDeleteTargets] = useState<PublicMessage[]>([]);
  const [messageAction, setMessageAction] = useState<PublicMessage | null>(null);
  const [replyTarget, setReplyTarget] = useState<PublicMessage | null>(null);
  const [forwardTargets, setForwardTargets] = useState<PublicMessage[]>([]);
  const [forwardDestination, setForwardDestination] = useState("");
  const [forwardError, setForwardError] = useState("");
  const [editTarget, setEditTarget] = useState<PublicMessage | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [actionError, setActionError] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [storiesOpen, setStoriesOpen] = useState(false);
  const [invitation, setInvitation] = useState<string | null>(null);
  const [olderCursors, setOlderCursors] = useState<Record<string, string | null>>({});
  const [olderLoading, setOlderLoading] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const syncCursors = useRef(new Map<string, string>());
  const hiddenMessages = useRef(new Map<string, Set<string>>());
  const forwardAttempts = useRef(new Map<string, string>());
  const mainContentRef = useRef<HTMLElement>(null);
  const conversationsLoading = useRef<Map<string, ConversationSummary> | null>(null);
  const selectedRef = useRef(selectedId);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{ id: string; height: number; top: number } | null>(null);
  const followTail = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const visibleChatRef = useRef<string | null>(null);
  const userId = user?.id;
  const call = useDirectCall(liveSocket, userId, setNotice);
  const messages = selectedId ? timelines[selectedId] ?? noMessages : noMessages;

  useEffect(() => {
    selectedRef.current = selectedId;
    visibleChatRef.current = workspace === "chats" && (mobileChatOpen || !window.matchMedia("(max-width: 760px)").matches)
      ? selectedId : null;
  }, [mobileChatOpen, selectedId, workspace]);

  useEffect(() => {
    function readLocation() {
      const hash = window.location.hash;
      const direct = conversationLink.exec(hash);
      const invite = /^#join\/([a-z\d_-]{43})$/i.exec(hash);
      setWorkspace(hash === "#calls" ? "calls" : hash === "#settings" ? "settings" : "chats");
      setMobileChatOpen(Boolean(direct));
      if (direct) setSelectedId(direct[1].toLowerCase());
      if (invite) setInvitation(invite[1]);
    }
    readLocation();
    window.addEventListener("hashchange", readLocation);
    return () => window.removeEventListener("hashchange", readLocation);
  }, []);

  const selected = conversations.find(item => item.id === selectedId) ?? null;
  const visibleConversations = useMemo(() => conversations.filter(conversation =>
    conversationName(conversation, user?.id ?? "").toLowerCase().includes(sidebarQuery.trim().toLowerCase()) ||
    conversationSubtitle(conversation, user?.id ?? "").toLowerCase().includes(sidebarQuery.trim().toLowerCase()),
  ), [conversations, sidebarQuery, user?.id]);

  const addConversation = useCallback((conversation: ConversationSummary) => {
    conversationsLoading.current?.set(conversation.id, conversation);
    setConversations(current => current.some(row => row.id === conversation.id)
      ? current.map(row => row.id === conversation.id ? conversation : row) : [conversation, ...current]);
  }, []);

  const addMessages = useCallback((conversationId: string, incoming: PublicMessage[]) => {
    if (!incoming.length) return;
    setTimelines(current => {
      const hidden = hiddenMessages.current.get(conversationId);
      const updated = mergeMessages(current[conversationId] ?? [], incoming.filter(message => !hidden?.has(message.id)));
      const byId = new Map(updated.map(message => [message.id, message]));
      return { ...current, [conversationId]: updated.map(message => {
        if (!message.replyToMessageId) return message;
        if (hidden?.has(message.replyToMessageId)) return { ...message, replyTo: null };
        const target = byId.get(message.replyToMessageId);
        return target ? { ...message, replyTo: { id: target.id, senderId: target.senderId, content: target.content,
          deletedAt: target.deletedAt } } : message;
      }) };
    });
  }, []);

  const removeHidden = useCallback((conversationId: string, ids: string[]) => {
    if (!ids.length) return;
    const hidden = hiddenMessages.current.get(conversationId) ?? new Set<string>();
    ids.forEach(id => hidden.add(id));
    hiddenMessages.current.set(conversationId, hidden);
    setTimelines(current => ({ ...current, [conversationId]: (current[conversationId] ?? []).filter(item => !hidden.has(item.id))
      .map(item => item.replyToMessageId && hidden.has(item.replyToMessageId) ? { ...item, replyTo: null } : item) }));
    setReplyTarget(current => current && current.conversationId === conversationId && hidden.has(current.id) ? null : current);
  }, []);

  const clearAccount = useCallback((feedback = "") => {
    syncCursors.current.clear(); hiddenMessages.current.clear(); forwardAttempts.current.clear();
    setUser(null); setConversations([]); setSelectedId(null); setTimelines({}); setUnread({});
    setDraft(""); setNotice(""); setSidebarQuery(""); setModal(null); setMobileChatOpen(false); setWorkspace("chats"); setOlderCursors({});
    setStoriesOpen(false); setInvitation(null);
    window.history.replaceState(null, "", window.location.pathname + window.location.search + "#chats");
    setAccountNotice(feedback);
  }, []);

  useEffect(() => {
    try { setCompact(localStorage.getItem("chatapp.compactMessages") === "1"); } catch { /* Storage may be disabled. */ }
  }, []);

  function changeDensity(value: boolean) {
    setCompact(value);
    try { localStorage.setItem("chatapp.compactMessages", value ? "1" : "0"); } catch { /* Storage may be disabled. */ }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/session", { cache: "no-store" }).then(async response => {
      if (!response.ok) return null;
      return response.json() as Promise<PublicUser>;
    }).then(value => { if (active && value) setUser(value); })
      .catch(() => undefined)
      .finally(() => { if (active) setAuthChecked(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    let socket: Socket | null = null;
    let socketRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    async function loadConversations() {
      const additions = new Map<string, ConversationSummary>();
      conversationsLoading.current = additions;
      try {
        const rows: ConversationSummary[] = [];
        let cursor: string | null = null;
        do {
          const page: ConversationPage = await api<ConversationPage>(`conversations/page?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          if (!active || conversationsLoading.current !== additions) return;
          rows.push(...page.conversations);
          cursor = page.nextCursor;
        } while (cursor);
        if (!active || conversationsLoading.current !== additions) return;
        const newChats = [...additions.values()].reverse();
        const chats = [...newChats, ...rows.filter(row => !additions.has(row.id))];
        setConversations(chats);
        setSelectedId(current => current && chats.some(row => row.id === current) ? current : chats[0]?.id ?? null);
        if (socket?.connected) {
          for (const chat of chats) socket.emit("conversation:join", { conversationId: chat.id });
        }
      } catch (error) {
        if (active && conversationsLoading.current === additions) {
          setNotice(error instanceof Error ? authError(error.message) : "Couldn't load chats.");
        }
      } finally {
        if (conversationsLoading.current === additions) conversationsLoading.current = null;
      }
    }
    void loadConversations();
    fetch("/api/socket-token", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("unauthorized");
      return response.json() as Promise<{ accessToken: string; accessExpiresAt: number }>;
    }).then(({ accessToken, accessExpiresAt }) => {
      if (!active) return;
      const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL ??
        (process.env.NODE_ENV === "production" ? window.location.origin : "http://127.0.0.1:4080");
      const currentSocket = io(socketUrl, {
        auth: { token: accessToken },
        autoConnect: false,
        reconnection: true,
        reconnectionDelayMax: 5000,
      });
      socket = currentSocket;
      socketRef.current = currentSocket;
      setLiveSocket(currentSocket);
      currentSocket.on("connect", () => {
        setSocketOnline(true);
        setConnectionVersion(version => version + 1);
        void loadConversations();
      });
      currentSocket.on("disconnect", (reason: string) => {
        setSocketOnline(false);
        if (reason !== "io server disconnect" || !active) return;
        void fetch("/api/session", { cache: "no-store" }).then(response => {
          if (active && response.status === 401) clearAccount("Your session ended. Sign in again to continue.");
        }).catch(() => undefined);
      });
      currentSocket.on("conversation:created", addConversation);
      currentSocket.on("conversation:invalidated", ({ conversationId }: { conversationId: string }) => {
        syncCursors.current.delete(conversationId);
        setTimelines(current => ({ ...current, [conversationId]: [] }));
        setUnread(current => ({ ...current, [conversationId]: 0 }));
        if (selectedRef.current === conversationId) setConnectionVersion(version => version + 1);
        void loadConversations();
      });
      currentSocket.on("message:new", (message: PublicMessage) => {
        addMessages(message.conversationId, [message]);
        if (visibleChatRef.current === message.conversationId && document.visibilityState === "visible") {
          void api("conversations/" + message.conversationId + "/read", {
            method: "POST", body: JSON.stringify({ messageId: message.id }),
          }).catch(() => undefined);
        } else if (message.senderId !== userId) {
          setUnread(current => ({ ...current, [message.conversationId]: (current[message.conversationId] ?? 0) + 1 }));
        }
      });
      currentSocket.on("message:deleted", (event: MessageDeletedEvent) => {
        setTimelines(current => {
          const timeline = current[event.conversationId];
          if (!timeline?.some(message => message.id === event.messageId)) return current;
          return { ...current, [event.conversationId]: timeline.map(message => message.id === event.messageId
            ? { ...message, content: "", attachment: null, reactions: [], deletedAt: event.deletedAt }
            : message.replyTo?.id === event.messageId
              ? { ...message, replyTo: { ...message.replyTo, content: "", deletedAt: event.deletedAt } } : message) };
        });
      });
      currentSocket.on("message:updated", ({ message }: { message: PublicMessage }) => addMessages(message.conversationId, [message]));
      currentSocket.on("message:hidden", ({ conversationId, messageIds }: { conversationId: string; messageIds: string[] }) =>
        removeHidden(conversationId, messageIds));
      currentSocket.on("group:updated", ({ conversation }: { conversation: ConversationSummary }) => addConversation(conversation));
      currentSocket.on("group:member_added", () => void loadConversations());
      currentSocket.on("group:member_removed", ({ conversationId, userId: removed }: { conversationId: string; userId: string }) => {
        if (removed === userId) {
          syncCursors.current.delete(conversationId);
          setTimelines(current => ({ ...current, [conversationId]: [] }));
        }
        void loadConversations();
      });
      let refreshingSocket = false;
      const refreshSocketSession = async () => {
        if (refreshingSocket || !active) return;
        refreshingSocket = true;
        if (socketRefreshTimer) clearTimeout(socketRefreshTimer);
        try {
          const response = await fetch("/api/socket-token", { method: "POST", cache: "no-store" });
          if (!response.ok) throw new Error("session_refresh_failed");
          const next = await response.json() as { accessToken: string; accessExpiresAt: number };
          if (!active || !socket) return;
          socket.auth = { token: next.accessToken };
          if (socket.connected) {
            const result = await socket.timeout(4000).emitWithAck("session:authenticate", next.accessToken).catch(() => null);
            if (!active) return;
            if (!result?.ok) { socket.disconnect(); socket.connect(); }
          } else socket.connect();
          scheduleSocketRefresh(next.accessExpiresAt);
        } catch {
          if (active) socketRefreshTimer = setTimeout(() => void refreshSocketSession(), 30_000);
        } finally { refreshingSocket = false; }
      };
      const scheduleSocketRefresh = (expiry: number) => {
        if (socketRefreshTimer) clearTimeout(socketRefreshTimer);
        const delay = Math.max(30_000, expiry - Date.now() - 60_000);
        socketRefreshTimer = setTimeout(() => void refreshSocketSession(), delay);
      };
      currentSocket.on("connect_error", (error: Error) => {
        if (error.message === "unauthorized") void refreshSocketSession();
      });
      scheduleSocketRefresh(accessExpiresAt);
      currentSocket.connect();
    }).catch(() => undefined);
    return () => {
      active = false;
      conversationsLoading.current = null;
      if (socketRefreshTimer) clearTimeout(socketRefreshTimer);
      socket?.disconnect();
      socketRef.current = null;
      setLiveSocket(null);
      setSocketOnline(false);
    };
  }, [addConversation, addMessages, clearAccount, removeHidden, userId]);

  useEffect(() => {
    if (!userId || !selectedId || workspace !== "chats") { setHistoryLoading(false); return; }
    const controller = new AbortController();
    const { signal } = controller;
    const id = selectedId;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    async function refreshHistory() {
      attempts++;
      setHistoryLoading(true);
      try {
        const socket = socketRef.current;
        if (socket?.connected) {
          const result = await socket.timeout(5000).emitWithAck("conversation:join", { conversationId: id });
          if (!result.ok) throw new Error(result.error);
        }
        if (signal.aborted) return;
        const savedCursor = syncCursors.current.get(id);
        let cursor: string;
        if (savedCursor === undefined) {
          const baseline = await api<MessageSyncPage>(`conversations/${id}/sync`, { signal });
          const page = await api<MessagePage>(`conversations/${id}/messages?limit=50`, { signal });
          if (signal.aborted) return;
          cursor = baseline.cursor;
          addMessages(id, page.messages);
          setOlderCursors(current => ({ ...current, [id]: page.nextCursor }));
        } else cursor = savedCursor;
        while (!signal.aborted) {
          const changes: MessageSyncPage = await api<MessageSyncPage>(`conversations/${id}/sync?after=${encodeURIComponent(cursor)}`, { signal });
          if (signal.aborted) return;
          removeHidden(id, changes.removedMessageIds);
          addMessages(id, changes.messages);
          syncCursors.current.set(id, changes.cursor);
          if (!changes.hasMore) break;
          if (changes.cursor === cursor) throw new Error("invalid_sync_cursor");
          cursor = changes.cursor;
        }
      } catch (error) {
        if (signal.aborted) return;
        const code = error instanceof Error ? error.message : "";
        if (code === "conversation_access_denied" || code === "messaging_blocked") {
          syncCursors.current.delete(id);
          setTimelines(current => ({ ...current, [id]: [] }));
          setNotice("You no longer have access to messages in this chat.");
        } else if (socketRef.current?.connected) {
          if (attempts < 3) retryTimer = setTimeout(() => void refreshHistory(), 1500 * attempts);
          else setNotice("Couldn't load messages. Select this chat to retry.");
        }
      } finally { if (!signal.aborted) setHistoryLoading(false); }
    }
    void refreshHistory();
    setUnread(current => ({ ...current, [selectedId]: 0 }));
    return () => { controller.abort(); clearTimeout(retryTimer); };
  }, [addMessages, connectionVersion, removeHidden, selectedId, userId, workspace]);

  const newestMessageId = messages.at(-1)?.id;
  useEffect(() => {
    if (!userId || !selectedId || !newestMessageId || workspace !== "chats" ||
        (!mobileChatOpen && window.matchMedia("(max-width: 760px)").matches)) return;
    const markRead = () => {
      if (document.visibilityState !== "visible") return;
      void api(`conversations/${selectedId}/read`, { method: "POST", body: JSON.stringify({ messageId: newestMessageId }) }).catch(() => undefined);
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => document.removeEventListener("visibilitychange", markRead);
  }, [mobileChatOpen, newestMessageId, selectedId, userId, workspace]);

  useEffect(() => {
    setSelecting(false); setSelectedMessages([]); setDeleteTargets([]); setMessageAction(null);
    setReplyTarget(null); setForwardTargets([]); setEditTarget(null); setDetailsOpen(false); setDraft("");
    followTail.current = true;
  }, [selectedId, userId]);

  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    const scroller = scrollRef.current;
    if (scroller && anchor?.id === selectedId) {
      scroller.scrollTop = anchor.top + scroller.scrollHeight - anchor.height;
      scrollAnchor.current = null;
    }
  }, [messages, selectedId]);

  useEffect(() => {
    if (followTail.current) bottomRef.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }, [mobileChatOpen, newestMessageId, selectedId, workspace]);

  function navigate(view: Workspace, conversationId?: string) {
    const hash = conversationId ? `#chat/${conversationId}` : `#${view}`;
    if (window.location.hash !== hash) window.location.hash = hash;
    setWorkspace(view);
    setMobileChatOpen(Boolean(conversationId));
  }

  async function loadOlder() {
    const id = selectedId;
    if (!id || olderLoading) return;
    const before = olderCursors[id];
    if (!before) return;
    setOlderLoading(true);
    try {
      const page = await api<MessagePage>(`conversations/${id}/messages?before=${encodeURIComponent(before)}`);
      const scroller = scrollRef.current;
      if (scroller && selectedRef.current === id) scrollAnchor.current = { id, top: scroller.scrollTop, height: scroller.scrollHeight };
      addMessages(id, page.messages);
      setOlderCursors(current => ({ ...current, [id]: page.nextCursor }));
    } catch { setNotice("Couldn't load older messages."); }
    finally { setOlderLoading(false); }
  }

  async function startConversation(person: PublicUser) {
    setWorking(true);
    try {
      const conversation = await api<ConversationSummary>("conversations/direct", {
        method: "POST", body: JSON.stringify({ userId: person.id }),
      });
      addConversation(conversation);
      setSelectedId(conversation.id);
      navigate("chats", conversation.id);
      setModal(null);
      socketRef.current?.emit("conversation:join", { conversationId: conversation.id });
    } catch (error) { setNotice(error instanceof Error ? authError(error.message) : "Couldn't start that chat."); }
    finally { setWorking(false); }
  }

  async function createGroup(title: string, people: PublicUser[]) {
    setWorking(true);
    try {
      const conversation = await api<ConversationSummary>("conversations/groups", {
        method: "POST", body: JSON.stringify({ title, userIds: people.map(person => person.id) }),
      });
      addConversation(conversation);
      setSelectedId(conversation.id);
      navigate("chats", conversation.id);
      setModal(null);
      socketRef.current?.emit("conversation:join", { conversationId: conversation.id });
    } catch (error) { setNotice(error instanceof Error ? authError(error.message) : "Couldn't create the group."); }
    finally { setWorking(false); }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId || !draft.trim() || working) return;
    const content = draft.trim();
    const conversationId = selectedId;
    const replyToMessageId = replyTarget?.id;
    setWorking(true);
    try {
      const message = await api<PublicMessage>(`conversations/${conversationId}/messages`, {
        method: "POST", body: JSON.stringify({ clientMessageId: crypto.randomUUID(), content, replyToMessageId }),
      });
      addMessages(conversationId, [message]);
      if (selectedRef.current === conversationId) {
        setDraft(current => current.trim() === content ? "" : current);
        setReplyTarget(current => current?.id === replyToMessageId ? null : current);
      }
    } catch (error) {
      setNotice(error instanceof Error ? authError(error.message) : "Message couldn't be sent.");
    } finally { setWorking(false); }
  }

  async function uploadFile(file: File) {
    if (!selectedId || working) return;
    const supported = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "audio/mpeg", "audio/wav", "application/pdf"]);
    if (!supported.has(file.type)) { setNotice("That file type isn't supported yet."); return; }
    setWorking(true);
    setNotice("");
    try {
      const response = await fetch(`/api/backend/conversations/${selectedId}/attachments`, {
        method: "POST",
        headers: { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name), "X-Client-Message-Id": crypto.randomUUID(),
          ...(replyTarget ? { "X-Reply-To-Message-Id": replyTarget.id } : {}) },
        body: file,
      });
      const payload = await response.json() as PublicMessage & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "upload_failed");
      addMessages(selectedId, [payload]);
      if (selectedRef.current === selectedId) setReplyTarget(null);
    } catch (error) { setNotice(error instanceof Error ? authError(error.message) : "File couldn't be uploaded."); }
    finally { setWorking(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function logout(everywhere: boolean) {
    const response = await fetch(everywhere ? "/api/session?all=1" : "/api/session", { method: "DELETE" });
    if (!response.ok) throw new Error("sign_out_failed");
    socketRef.current?.disconnect();
    clearAccount();
  }

  async function saveProfile(values: ProfileFields) {
    const profile = await api<PublicUser>("users/me", { method: "PATCH", body: JSON.stringify(values) });
    setUser(profile);
  }

  function toggleMessage(id: string) {
    setSelectedMessages(current => current.includes(id) ? current.filter(value => value !== id) :
      current.length >= 100 ? current : [...current, id]);
  }

  const pickedMessages = messages.filter(message => selectedMessages.includes(message.id) && !message.deletedAt);

  async function copySelected() {
    const text = pickedMessages.map(message => message.content).filter(Boolean).join("\n");
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setNotice("Selected text copied."); }
    catch { setNotice("Couldn't copy text. Check your browser permissions."); }
  }

  async function deleteMessages(scope: "mine" | "everyone") {
    if (working || !deleteTargets.length || !selectedId) return;
    if (scope === "everyone" && deleteTargets.some(message => message.senderId !== userId)) return;
    setWorking(true);
    setActionError("");
    if (scope === "mine") {
      try {
        const result = await api<{ messageIds: string[] }>(`conversations/${selectedId}/messages/hide`, {
          method: "POST", body: JSON.stringify({ messageIds: deleteTargets.map(message => message.id) }),
        });
        removeHidden(selectedId, result.messageIds);
        setSelectedMessages(current => current.filter(id => !result.messageIds.includes(id)));
        setDeleteTargets([]);
        setNotice(result.messageIds.length === 1 ? "Message removed from your view." : "Messages removed from your view.");
      } catch { setActionError("Couldn't delete the selected messages. Try again."); }
      finally { setWorking(false); }
      return;
    }
    const results = await Promise.allSettled(deleteTargets.map(async message => {
      const deleted = await api<PublicMessage>(`conversations/${message.conversationId}/messages/${message.id}`, { method: "DELETE" });
      addMessages(message.conversationId, [deleted]);
      return message.id;
    }));
    const removed = new Set(results.flatMap(result => result.status === "fulfilled" ? [result.value] : []));
    const failed = results.length - removed.size;
    setSelectedMessages(current => current.filter(id => !removed.has(id)));
    setDeleteTargets([]);
    setWorking(false);
    setNotice(failed ? `${removed.size} deleted. ${failed} couldn't be deleted. Try again.` :
      removed.size === 1 ? "Message deleted." : `${removed.size} messages deleted.`);
  }

  function chooseReply(message: PublicMessage) {
    setReplyTarget(message); setMessageAction(null); setSelecting(false); setSelectedMessages([]);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function openForward(targets: PublicMessage[]) {
    setForwardTargets(targets); setMessageAction(null); setForwardDestination(""); setForwardError("");
    forwardAttempts.current.clear();
  }

  async function forwardMessages(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working || !forwardDestination || !forwardTargets.length) return;
    setWorking(true); setForwardError("");
    const count = forwardTargets.length;
    try {
      for (const message of forwardTargets) {
        const key = `${forwardDestination}:${message.id}`;
        const clientMessageId = forwardAttempts.current.get(key) ?? crypto.randomUUID();
        forwardAttempts.current.set(key, clientMessageId);
        const copy = await api<PublicMessage>(`conversations/${message.conversationId}/messages/${message.id}/forward`, {
          method: "POST", body: JSON.stringify({ conversationId: forwardDestination, clientMessageId }),
        });
        addMessages(forwardDestination, [copy]);
      }
      setForwardTargets([]); setSelecting(false); setSelectedMessages([]);
      setNotice(count === 1 ? "Message forwarded." : `${count} messages forwarded.`);
    } catch { setForwardError("Couldn't finish forwarding. Retrying to this chat keeps copies already sent."); }
    finally { setWorking(false); }
  }

  async function saveEditedMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editTarget || !editDraft.trim() || working) return;
    setWorking(true); setActionError("");
    try {
      const updated = await api<PublicMessage>(`conversations/${editTarget.conversationId}/messages/${editTarget.id}`, {
        method: "PUT", body: JSON.stringify({ content: editDraft.trim() }),
      });
      addMessages(updated.conversationId, [updated]);
      setEditTarget(null);
    } catch { setActionError("Couldn't save this edit. Try again."); }
    finally { setWorking(false); }
  }

  function selectConversation(conversationId: string) {
    if (selectedId === conversationId) setConnectionVersion(version => version + 1);
    setSelectedId(conversationId);
    setUnread(current => ({ ...current, [conversationId]: 0 }));
    navigate("chats", conversationId);
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing &&
        !window.matchMedia("(pointer: coarse)").matches) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
  }

  if (!authChecked) return <main className="boot-screen"><span className="brand-mark"><Icon name="message" /></span><span className="spinner spinner-dark" /></main>;
  if (!user) return <AuthScreen notice={accountNotice} onAuthenticated={profile => { setAccountNotice(""); setUser(profile); }} />;

  const callConversation = call.view && conversations.find(row => row.id === call.view?.conversationId);
  const callName = callConversation ? conversationName(callConversation, user.id) : "Chat contact";
  const closedChat = selected?.type === "direct" && selected.participants.length < 2;

  return <main className={`messenger workspace-${workspace}${mobileChatOpen ? " mobile-chat-open" : ""}${compact ? " compact-messages" : ""}`}>
    <a className="skip-link" href="#main-content" onClick={event => {
      event.preventDefault();
      if (workspace === "chats" && !mobileChatOpen && window.matchMedia("(max-width: 760px)").matches) {
        document.getElementById("inbox-content")?.focus();
      } else mainContentRef.current?.focus();
    }}>Skip to main content</a>
    <div className="workspace-rail">
      <a className="rail-brand brand-mark" href="#chats" aria-label="Chatapp"><Icon name="message" size={20} /></a>
      <nav className="workspace-nav" aria-label="Chatapp">
        {navigation.map(item => <a className="workspace-nav-link" key={item.view} href={`#${item.view}`}
          aria-current={workspace === item.view ? "page" : undefined} onClick={event => {
            event.preventDefault(); navigate(item.view);
          }}><Icon name={item.icon} size={21} /><span>{item.label}</span></a>)}
      </nav>
      <button className="icon-button rail-profile" type="button" aria-label="Open profile settings" title="Open profile settings" onClick={() => navigate("settings")}><Avatar name={user.displayName} src={user.avatarUrl} size="sm" /></button>
    </div>
    {workspace === "chats" && <aside className="chat-sidebar" id="inbox-content" tabIndex={-1} aria-label="Chats">
      <div className="sidebar-top">
        <div className="inbox-heading"><h1>Chats</h1><span className="inbox-count" aria-label={`${conversations.length} chats`}>{conversations.length}</span></div>
        <button className="icon-button new-chat-button" type="button" aria-label="Start a new chat" title="Start a new chat" onClick={() => setModal("chat")}><Icon name="plus" /></button>
      </div>
      <div className="sidebar-actions">
        <label className="search-box"><Icon name="search" size={18} /><input value={sidebarQuery} onChange={event => setSidebarQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></label>
      </div>
      <div className="inbox-tabs">
        <button type="button" onClick={() => setModal("group")}><Icon name="users" size={17} /> New group</button>
        <button type="button" onClick={() => setStoriesOpen(true)}><Icon name="story" size={17} /> Stories</button>
        <button type="button" onClick={() => setInvitation("")}>Join group</button>
      </div>
      <div className="conversation-list" role="list" aria-label="Conversations">
        {visibleConversations.map(conversation => {
          const name = conversationName(conversation, user.id);
          const latest = timelines[conversation.id]?.at(-1);
          const preview = latest?.deletedAt ? "Message deleted" : latest?.content || latest?.attachment?.fileName ||
            (conversation.type === "group" ? "Group conversation" : "Start a conversation");
          return <div role="listitem" key={conversation.id}><button className={`conversation-row ${selectedId === conversation.id ? "selected" : ""}`} type="button"
            aria-current={selectedId === conversation.id ? "true" : undefined} onClick={() => selectConversation(conversation.id)}>
            <Avatar name={name} size="lg" />
            <span className="conversation-copy"><span className="conversation-title">{name}</span><span className="conversation-preview">{preview}</span></span>
            <span className="conversation-meta">{latest && <time dateTime={latest.createdAt}>{timeLabel(latest.createdAt)}</time>}{unread[conversation.id] ? <b className="unread-count" aria-label={`${unread[conversation.id]} unread`}>{unread[conversation.id]}</b> : null}</span>
          </button></div>;
        })}
        {!visibleConversations.length && <div className="empty-list"><span className="empty-icon"><Icon name="search" size={22} /></span><strong>{sidebarQuery ? "No matches" : "Your chats will show up here"}</strong><p>{sidebarQuery ? "Try another name or username." : "Start a chat and say hello."}</p>{!sidebarQuery && <button type="button" className="text-button" onClick={() => setModal("chat")}>Find someone <span>→</span></button>}</div>}
      </div>
      <div className="sidebar-bottom"><div className={`connection-indicator ${socketOnline ? "is-online" : ""}`}><span />{socketOnline ? "Connected" : "Reconnecting…"}</div><span className="sidebar-user">Signed in as <strong>{user.displayName}</strong></span></div>
    </aside>}

    <section ref={mainContentRef} className={workspace === "chats" ? `chat-panel ${selected ? "has-chat" : ""}` : "workspace-panel"} aria-label={workspace === "chats" ? "Conversation" : workspace === "calls" ? "Calls" : "Settings"} id="main-content" tabIndex={-1}>
      {workspace === "calls" ? <CallHistory userId={user.id} online={socketOnline} calling={!!call.view}
        contactName={id => { const chat = conversations.find(row => row.id === id); return chat && chat.participants.length > 1 ? conversationName(chat, user.id) : undefined; }}
        onOpenChat={selectConversation} onCall={(id, kind) => void call.start(id, kind)} />
      : workspace === "settings" ? <ChatSettings user={user} compact={compact} onDensityChange={changeDensity} onSave={saveProfile} onSignOut={logout}
        onDeleted={() => clearAccount("Your account was deleted.")} onPasswordChanged={() => clearAccount("Password changed. Sign in again to continue.")} />
      : selected ? <>
        <header className="chat-header">
          <button className="icon-button mobile-back" type="button" aria-label="Back to chats" onClick={() => { navigate("chats"); requestAnimationFrame(() => document.getElementById("inbox-content")?.focus()); }}><Icon name="back" /></button>
          <Avatar name={conversationName(selected, user.id)} size="md" />
          <div className="chat-heading"><h2>{conversationName(selected, user.id)}</h2><span>{conversationSubtitle(selected, user.id)}</span></div>
          <div className="header-tools">
            <span className={`connection-indicator header-connection ${socketOnline ? "is-online" : ""}`}><span />{socketOnline ? historyLoading ? "Catching up…" : "Live" : "Offline"}</span>
            {selected.type === "direct" && !closedChat && <>
              <button className="icon-button chat-tool" type="button" aria-label="Voice call" title="Voice call" disabled={!socketOnline || !!call.view} onClick={() => void call.start(selected.id, "voice")}><Icon name="phone" /></button>
              <button className="icon-button chat-tool" type="button" aria-label="Video call" title="Video call" disabled={!socketOnline || !!call.view} onClick={() => void call.start(selected.id, "video")}><Icon name="video" /></button>
            </>}
            <button className="icon-button chat-tool" type="button" aria-label="Select messages" title="Select messages" aria-pressed={selecting} disabled={!messages.some(message => !message.deletedAt)} onClick={() => { setSelecting(!selecting); setSelectedMessages([]); }}><Icon name="select" /></button>
            <button className="icon-button chat-tool details-button" type="button" aria-label="Conversation details" title="Conversation details" onClick={() => setDetailsOpen(true)}><Icon name="more" /></button>
          </div>
        </header>
        {selecting && <div className="message-selection" aria-label="Message selection actions">
          <span role="status">{pickedMessages.length} selected</span>
          <button className="quiet-button" type="button" disabled={pickedMessages.length !== 1 || !!closedChat} onClick={() => chooseReply(pickedMessages[0])}>Reply</button>
          <button className="quiet-button" type="button" disabled={!pickedMessages.length || working} onClick={() => openForward(pickedMessages)}>Forward</button>
          <button className="quiet-button copy-selection" type="button" disabled={!pickedMessages.some(message => message.content)} onClick={() => void copySelected()}>Copy</button>
          <button className="danger-button" type="button" disabled={!pickedMessages.length || working} onClick={() => { setActionError(""); setDeleteTargets(pickedMessages); }}>Delete</button>
          <button className="quiet-button" type="button" onClick={() => { setSelecting(false); setSelectedMessages([]); }}>Done</button>
        </div>}
        <div ref={scrollRef} className="message-scroll" tabIndex={0} aria-label="Messages" aria-busy={historyLoading || olderLoading} onScroll={event => {
          const list = event.currentTarget;
          followTail.current = list.scrollHeight - list.scrollTop - list.clientHeight < 96;
        }}>
          {!!olderCursors[selected.id] && <div className="chat-date"><button className="quiet-button" type="button" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? "Loading…" : "Load earlier messages"}</button></div>}
          {!messages.length && !historyLoading && <div className="chat-date"><span>No messages yet</span></div>}
          {!!messages.length && <div className="message-spacer" aria-hidden="true" />}
          {messages.map(message => {
            const mine = message.senderId === user.id;
            const checked = selectedMessages.includes(message.id);
            return <article className={`message-line ${mine ? "mine" : "theirs"}${checked ? " message-selected" : ""}`} key={message.id}>
              {selecting && !message.deletedAt && <label className="message-checkbox"><input type="checkbox" checked={checked} onChange={() => toggleMessage(message.id)} aria-label={`Select message at ${timeLabel(message.createdAt)}`} /></label>}
              {!selecting && !message.deletedAt && <button className="icon-button message-menu" type="button" title="Message actions"
                aria-label={`Message actions at ${timeLabel(message.createdAt)}`} disabled={working} onClick={() => setMessageAction(message)}><Icon name="more" size={17} /></button>}
              {!mine && <Avatar name={selected.type === "group" ? selected.participants.find(person => person.id === message.senderId)?.displayName ?? "Member" : conversationName(selected, user.id)} size="sm" />}
              <div className="message-stack">
                {!mine && selected.type === "group" && <span className="message-author">{selected.participants.find(person => person.id === message.senderId)?.displayName ?? "Member"}</span>}
                <div className="message-bubble">
                  {!message.deletedAt && message.forwarded && <span className="forwarded-label"><Icon name="forward" size={13} /> Forwarded</span>}
                  {!message.deletedAt && message.replyTo && <blockquote className="message-reply">
                    <strong>{message.replyTo.senderId === user.id ? "You" : selected.participants.find(person => person.id === message.replyTo?.senderId)?.displayName ?? "Message"}</strong>
                    <span>{message.replyTo.deletedAt ? "Message deleted" : message.replyTo.content || "Attachment"}</span>
                  </blockquote>}
                  {message.deletedAt ? <em>Message deleted</em> : message.content && <p>{message.content}</p>}
                  {message.attachment && <a className="attachment-card" href={`/api/backend${message.attachment.downloadPath.replace(/^\/v1/, "")}`} target="_blank" rel="noreferrer"><span className="attachment-icon"><Icon name={message.type === "image" ? "image" : "paperclip"} /></span><span><strong>{message.attachment.fileName}</strong><small>{message.attachment.contentType} · {formatBytes(message.attachment.sizeBytes)}</small></span></a>}
                  <span className="message-time">{message.editedAt && !message.deletedAt && <span>Edited</span>}{timeLabel(message.createdAt)}{mine && <span className="message-check" aria-label="Sent">✓</span>}</span>
                </div>
              </div>
            </article>;
          })}
          <div ref={bottomRef} />
        </div>
        {closedChat ? <p className="chat-closed">This chat is read-only.</p> : <form className="composer" onSubmit={sendMessage}>
          {replyTarget && <div className="composer-reply"><div><strong>Replying to {replyTarget.senderId === user.id ? "yourself" : selected.participants.find(person => person.id === replyTarget.senderId)?.displayName ?? "a message"}</strong><span>{replyTarget.content || replyTarget.attachment?.fileName || "Message"}</span></div>
            <button className="icon-button" type="button" aria-label="Cancel reply" onClick={() => setReplyTarget(null)}><Icon name="close" size={17} /></button></div>}
          <input ref={fileRef} className="visually-hidden" type="file" tabIndex={-1} aria-hidden="true" accept="image/jpeg,image/png,image/webp,video/mp4,audio/mpeg,audio/wav,application/pdf" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void uploadFile(file); }} />
          <button className="icon-button attach-button" type="button" aria-label="Attach a file" title="Attach a file" disabled={working} onClick={() => fileRef.current?.click()}><Icon name="paperclip" /></button>
          <textarea ref={composerRef} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={handleComposerKey} placeholder="Write a message…" aria-label="Write a message" maxLength={4000} rows={1} />
          <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
          <button className="send-button" type="submit" aria-label="Send message" title="Send message" disabled={!draft.trim() || working}><Icon name="send" size={18} /></button>
        </form>}
      </> : <div className="welcome-panel">
        <div className="welcome-art"><span className="welcome-center"><Icon name="message" size={32} /></span></div>
        <h2>No chat selected</h2><p>Choose a conversation or start a new one.</p><button className="primary-button" type="button" onClick={() => setModal("chat")}><Icon name="plus" size={18} /> Start a chat</button>
      </div>}
    </section>

    {notice && <div className="app-toast" role="status"><span>{notice}</span><button className="icon-button" type="button" aria-label="Dismiss message" onClick={() => setNotice("")}><Icon name="close" size={16} /></button></div>}
    {call.view && <CallPanel key={call.view.callId} call={call.view} name={callName} onAccept={() => void call.accept()} onEnd={call.end} />}
    {detailsOpen && selected && <ConversationDetails conversation={selected} userId={user.id} onClose={() => setDetailsOpen(false)}
      onUpdated={addConversation} onLeft={() => { setDetailsOpen(false); setConversations(current => current.filter(item => item.id !== selected.id)); setSelectedId(null); navigate("chats"); }} />}
    {storiesOpen && <StoriesDialog userId={user.id} onClose={() => setStoriesOpen(false)} />}
    {invitation !== null && <InvitationDialog initialToken={invitation} onClose={() => { setInvitation(null); navigate("chats"); }}
      onJoined={chat => { addConversation(chat); setInvitation(null); selectConversation(chat.id); }} />}
    {messageAction && <ChatDialog title="Message actions" onClose={() => setMessageAction(null)}>
      <div className="action-stack">
        {!closedChat && <button className="quiet-button" type="button" onClick={() => chooseReply(messageAction)}><Icon name="reply" size={17} /> Reply</button>}
        <button className="quiet-button" type="button" onClick={() => openForward([messageAction])}><Icon name="forward" size={17} /> Forward</button>
        {messageAction.senderId === user.id && !!messageAction.content && <button className="quiet-button" type="button" onClick={() => {
          setEditDraft(messageAction.content); setEditTarget(messageAction); setActionError(""); setMessageAction(null);
        }}><Icon name="edit" size={17} /> Edit</button>}
        <button className="danger-button" type="button" onClick={() => { setActionError(""); setDeleteTargets([messageAction]); setMessageAction(null); }}><Icon name="trash" size={17} /> Delete</button>
      </div>
    </ChatDialog>}
    {!!forwardTargets.length && <ChatDialog title={forwardTargets.length === 1 ? "Forward message" : `Forward ${forwardTargets.length} messages`} onClose={() => { if (!working) setForwardTargets([]); }}>
      <form className="account-form" aria-busy={working} onSubmit={forwardMessages}>
        <label>Send to<select value={forwardDestination} onChange={event => setForwardDestination(event.target.value)} disabled={working} required>
          <option value="">Choose a chat</option>{conversations.filter(chat => chat.type === "group" || chat.participants.length > 1).map(chat => <option key={chat.id} value={chat.id}>{conversationName(chat, user.id)}</option>)}
        </select></label>
        {forwardError && <p className="form-error" role="alert">{forwardError}</p>}
        <button className="primary-button" disabled={!forwardDestination || working}>{working ? "Forwarding…" : "Forward"}</button>
      </form>
    </ChatDialog>}
    {editTarget && <ChatDialog title="Edit message" onClose={() => { if (!working) setEditTarget(null); }}>
      <form className="account-form" aria-busy={working} onSubmit={saveEditedMessage}>
        <label>Message<textarea autoFocus rows={4} value={editDraft} onChange={event => setEditDraft(event.target.value)} maxLength={4000} required /></label>
        {actionError && <p className="form-error" role="alert">{actionError}</p>}
        <button className="primary-button" disabled={!editDraft.trim() || working}>{working ? "Saving…" : "Save changes"}</button>
      </form>
    </ChatDialog>}
    {!!deleteTargets.length && <ChatDialog title={deleteTargets.length === 1 ? "Delete message?" : `Delete ${deleteTargets.length} messages?`} onClose={() => { if (!working) setDeleteTargets([]); }}>
      <p className="dialog-description">Delete from your own history{deleteTargets.every(message => message.senderId === user.id) ? " or remove messages you sent for everyone in this chat" : ""}.</p>
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      <div className="dialog-actions"><button className="quiet-button" type="button" disabled={working} onClick={() => setDeleteTargets([])}>Cancel</button>
        <button className="quiet-button" type="button" disabled={working} onClick={() => void deleteMessages("mine")}>Delete for me</button>
        {deleteTargets.every(message => message.senderId === user.id) && <button className="danger-button" type="button" disabled={working} onClick={() => void deleteMessages("everyone")}>{working ? "Deleting…" : "Delete for everyone"}</button>}</div>
    </ChatDialog>}
    {modal && <PeopleModal mode={modal} onClose={() => setModal(null)} onStart={startConversation} onCreateGroup={createGroup} busy={working} />}
  </main>;
}

function formatBytes(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function PeopleModal({ mode, onClose, onStart, onCreateGroup, busy }: {
  mode: Exclude<ModalMode, null>;
  onClose: () => void;
  onStart: (person: PublicUser) => void;
  onCreateGroup: (title: string, people: PublicUser[]) => void;
  busy: boolean;
}) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<PublicUser[]>([]);
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) { setPeople([]); setSearching(false); setError(""); return; }
    let active = true;
    const timer = setTimeout(() => {
      setSearching(true);
      void api<PublicUser[]>(`users/search?q=${encodeURIComponent(value)}`).then(results => {
        if (active) { setPeople(results); setError(""); }
      }).catch(caught => { if (active) setError(caught instanceof Error ? authError(caught.message) : "Search isn't available."); })
        .finally(() => { if (active) setSearching(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);

  function toggle(person: PublicUser) {
    setPicked(current => current.some(item => item.id === person.id) ? current.filter(item => item.id !== person.id) : [...current, person]);
  }

  return <ChatDialog title={mode === "chat" ? "Find a person" : "Create a group"} onClose={() => { if (!busy) onClose(); }}>
    <section className="people-modal-content">
      {mode === "group" && <label className="group-title-field">Group name<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} placeholder="Weekend plans" /></label>}
      <label className="search-box modal-search"><Icon name="search" size={18} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by username" aria-label="Search by username" /></label>
      <p className="field-hint">Enter at least 2 letters of a username.</p>
      {picked.length > 0 && <div className="selected-people" aria-label="Selected members">{picked.map(person => <button type="button" key={person.id} onClick={() => toggle(person)}>{person.displayName}<span>×</span></button>)}</div>}
      <div className="people-results" aria-live="polite">
        {searching && <div className="search-state"><span className="spinner spinner-dark" /> Searching…</div>}
        {error && <p className="form-error">{error}</p>}
        {!searching && query.trim().length >= 2 && !people.length && !error && <div className="search-state">No people found for that username.</div>}
        {people.map(person => {
          const isPicked = picked.some(item => item.id === person.id);
          return <button key={person.id} className={`person-row ${isPicked ? "picked" : ""}`} type="button" onClick={() => mode === "chat" ? onStart(person) : toggle(person)} disabled={busy}>
            <Avatar name={person.displayName} size="md" /><span className="person-copy"><strong>{person.displayName}</strong><small>@{person.username}</small></span><span className="person-action">{mode === "chat" ? "Message" : isPicked ? "Selected" : "Add"}</span>
          </button>;
        })}
      </div>
      {mode === "group" && <div className="modal-footer"><span>{picked.length} member{picked.length === 1 ? "" : "s"} selected</span><button className="primary-button" type="button" disabled={busy || !title.trim() || !picked.length} onClick={() => onCreateGroup(title.trim(), picked)}>{busy ? "Creating…" : "Create group"}</button></div>}
    </section>
  </ChatDialog>;
}
