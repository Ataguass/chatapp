"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import type { ConversationSummary, PublicMessage, PublicUser } from "@messaging/contracts";

type MessagePage = { messages: PublicMessage[]; nextCursor: string | null };
type AuthMode = "login" | "register";
type ModalMode = "chat" | "group" | null;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/backend/${path.replace(/^\//, "")}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? `request_failed_${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part.charAt(0).toUpperCase()).join("") || "?";
}

function colorIndex(name: string) {
  return [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6;
}

function Avatar({ name, size = "md", online = false }: { name: string; size?: "sm" | "md" | "lg"; online?: boolean }) {
  return <span className={`avatar avatar-${size} avatar-tone-${colorIndex(name)}`} role="img" aria-label={online ? `${name}, online` : name}>
    {initials(name)}{online && <i className="online-dot" aria-hidden="true" />}
  </span>;
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  const paths: Record<string, ReactNode> = {
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.2 4.2" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    send: <><path d="m21 3-7.2 18-3.6-7.2L3 10.2 21 3Z" /><path d="M10.2 13.8 15 9" /></>,
    paperclip: <><path d="m8.5 12.5 7-7a4 4 0 0 1 5.7 5.7l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2" /></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></>,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    back: <><path d="m15 18-6-6 6-6" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M20 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
    message: <><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" /></>,
  };
  return <svg {...common}>{paths[name] ?? paths.message}</svg>;
}

function conversationName(conversation: ConversationSummary, userId: string) {
  if (conversation.type === "group") return conversation.title || "Untitled group";
  return conversation.participants.find(person => person.id !== userId)?.displayName ?? "Conversation";
}

function conversationSubtitle(conversation: ConversationSummary, userId: string) {
  if (conversation.type === "group") return `${conversation.participants.length} members`;
  return `@${conversation.participants.find(person => person.id !== userId)?.username ?? "member"}`;
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: PublicUser) => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      <div className="story-copy">
        <span className="eyebrow">YOUR PEOPLE, IN ONE PLACE</span>
        <h1>Good conversations<br />make the day.</h1>
        <p>A quieter space for the people and moments that matter.</p>
      </div>
      <div className="story-note"><div className="note-avatars"><Avatar name="Maya Chen" size="sm" /><Avatar name="Noah James" size="sm" /><Avatar name="Aisha Khan" size="sm" /></div><span>Private chats. Your own little corner.</span></div>
      <div className="story-orbit orbit-one" /><div className="story-orbit orbit-two" />
    </section>
    <section className="auth-panel">
      <div className="auth-form-wrap">
        <div className="auth-heading"><span className="eyebrow">WELCOME {mode === "login" ? "BACK" : "ABOARD"}</span><h2>{mode === "login" ? "Sign in to chat" : "Create your account"}</h2><p>{mode === "login" ? "Pick up where your conversations left off." : "Choose a username your friends can find."}</p></div>
        <form className="auth-form" onSubmit={submit}>
          {mode === "register" && <label>Display name<input autoComplete="name" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="What should we call you?" maxLength={100} /></label>}
          <label>Username<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} placeholder="your_username" minLength={3} maxLength={32} required /></label>
          <label>Password<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters" minLength={12} maxLength={128} required /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button auth-submit" disabled={busy}>{busy ? <span className="spinner" /> : null}{mode === "login" ? "Sign in" : "Create account"}</button>
        </form>
        <p className="auth-switch">{mode === "login" ? "New around here?" : "Already have an account?"} <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "Create an account" : "Sign in"}</button></p>
        <p className="auth-privacy">Your conversations are private to you and the people in them.</p>
      </div>
    </section>
  </main>;
}

function authError(code: string) {
  const messages: Record<string, string> = {
    invalid_credentials: "That username and password don't match.",
    username_taken: "That username is already taken.",
    invalid_username: "Use 3–32 letters, numbers, or underscores.",
    invalid_password: "Choose a password with at least 12 characters.",
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
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState("");
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [modal, setModal] = useState<ModalMode>(null);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const [socketOnline, setSocketOnline] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const mainContentRef = useRef<HTMLElement>(null);
  const conversationsRef = useRef(conversations);
  const selectedRef = useRef(selectedId);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);

  const selected = conversations.find(item => item.id === selectedId) ?? null;
  const visibleConversations = useMemo(() => conversations.filter(conversation =>
    conversationName(conversation, user?.id ?? "").toLowerCase().includes(sidebarQuery.trim().toLowerCase()) ||
    conversationSubtitle(conversation, user?.id ?? "").toLowerCase().includes(sidebarQuery.trim().toLowerCase()),
  ), [conversations, sidebarQuery, user?.id]);

  const loadConversations = useCallback(async () => {
    const rows = await api<ConversationSummary[]>("conversations");
    setConversations(rows);
    setSelectedId(current => current && rows.some(row => row.id === current) ? current : rows[0]?.id ?? null);
    return rows;
  }, []);

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
    if (!user) return;
    let active = true;
    let socket: Socket | null = null;
    let socketRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    void loadConversations().catch(error => setNotice(error instanceof Error ? authError(error.message) : "Couldn't load chats."));
    fetch("/api/socket-token", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("unauthorized");
      return response.json() as Promise<{ accessToken: string; accessExpiresAt: number }>;
    }).then(({ accessToken, accessExpiresAt }) => {
      if (!active) return;
      const currentSocket = io(process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://127.0.0.1:4080", {
        auth: { token: accessToken },
        reconnection: true,
        reconnectionDelayMax: 5000,
      });
      socket = currentSocket;
      socketRef.current = currentSocket;
      currentSocket.on("connect", () => {
        setSocketOnline(true);
        for (const conversation of conversationsRef.current) currentSocket.emit("conversation:join", { conversationId: conversation.id });
      });
      currentSocket.on("disconnect", () => setSocketOnline(false));
      currentSocket.on("message:new", (message: PublicMessage) => {
        if (selectedRef.current === message.conversationId) {
          setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]);
          void api("conversations/" + message.conversationId + "/read", {
            method: "POST", body: JSON.stringify({ messageId: message.id }),
          }).catch(() => undefined);
        } else {
          setUnread(current => ({ ...current, [message.conversationId]: (current[message.conversationId] ?? 0) + 1 }));
        }
        setPreviews(current => ({ ...current, [message.conversationId]: message.content || message.attachment?.fileName || "Attachment" }));
      });
      const refreshSocketSession = async () => {
        try {
          const response = await fetch("/api/socket-token?refresh=1", { cache: "no-store" });
          if (!response.ok) throw new Error("session_refresh_failed");
          const next = await response.json() as { accessToken: string; accessExpiresAt: number };
          if (!active || !socket) return;
          socket.auth = { token: next.accessToken };
          socket.disconnect();
          socket.connect();
          scheduleSocketRefresh(next.accessExpiresAt);
        } catch {
          if (active) socketRefreshTimer = setTimeout(() => void refreshSocketSession(), 30_000);
        }
      };
      const scheduleSocketRefresh = (expiry: number) => {
        if (socketRefreshTimer) clearTimeout(socketRefreshTimer);
        const delay = Math.max(30_000, expiry - Date.now() - 60_000);
        socketRefreshTimer = setTimeout(() => void refreshSocketSession(), delay);
      };
      scheduleSocketRefresh(accessExpiresAt);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (socketRefreshTimer) clearTimeout(socketRefreshTimer);
      socket?.disconnect();
      socketRef.current = null;
      setSocketOnline(false);
    };
  }, [loadConversations, user]);

  useEffect(() => {
    if (!user || !selectedId) { setMessages([]); return; }
    let active = true;
    const socket = socketRef.current;
    socket?.emit("conversation:join", { conversationId: selectedId });
    void api<MessagePage>(`conversations/${selectedId}/messages?limit=50`).then(page => {
      if (!active) return;
      setMessages(page.messages);
      const last = page.messages.at(-1);
      if (last) void api(`conversations/${selectedId}/read`, { method: "POST", body: JSON.stringify({ messageId: last.id }) }).catch(() => undefined);
    }).catch(error => { if (active) setNotice(error instanceof Error ? authError(error.message) : "Couldn't load messages."); });
    setUnread(current => ({ ...current, [selectedId]: 0 }));
    return () => { active = false; };
  }, [selectedId, user]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages]);

  async function startConversation(person: PublicUser) {
    setWorking(true);
    try {
      const conversation = await api<ConversationSummary>("conversations/direct", {
        method: "POST", body: JSON.stringify({ userId: person.id }),
      });
      setConversations(current => current.some(item => item.id === conversation.id) ? current : [conversation, ...current]);
      setSelectedId(conversation.id);
      setMobileChatOpen(true);
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
      setConversations(current => [conversation, ...current.filter(item => item.id !== conversation.id)]);
      setSelectedId(conversation.id);
      setMobileChatOpen(true);
      setModal(null);
      socketRef.current?.emit("conversation:join", { conversationId: conversation.id });
    } catch (error) { setNotice(error instanceof Error ? authError(error.message) : "Couldn't create the group."); }
    finally { setWorking(false); }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId || !draft.trim() || working) return;
    const content = draft.trim();
    setDraft("");
    setWorking(true);
    try {
      const message = await api<PublicMessage>(`conversations/${selectedId}/messages`, {
        method: "POST", body: JSON.stringify({ clientMessageId: crypto.randomUUID(), content }),
      });
      setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]);
      setPreviews(current => ({ ...current, [selectedId]: message.content }));
    } catch (error) {
      setDraft(content);
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
        headers: { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name), "X-Client-Message-Id": crypto.randomUUID() },
        body: file,
      });
      const payload = await response.json() as PublicMessage & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "upload_failed");
      setMessages(current => current.some(item => item.id === payload.id) ? current : [...current, payload]);
      setPreviews(current => ({ ...current, [selectedId]: file.name }));
    } catch (error) { setNotice(error instanceof Error ? authError(error.message) : "File couldn't be uploaded."); }
    finally { setWorking(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function logout() {
    await fetch("/api/session", { method: "DELETE" }).catch(() => undefined);
    socketRef.current?.disconnect();
    setUser(null); setConversations([]); setSelectedId(null); setMessages([]); setMobileChatOpen(false);
  }

  function selectConversation(conversationId: string) {
    setSelectedId(conversationId);
    setUnread(current => ({ ...current, [conversationId]: 0 }));
    setMobileChatOpen(true);
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
  }

  if (!authChecked) return <main className="boot-screen"><span className="brand-mark"><Icon name="message" /></span><span className="spinner spinner-dark" /></main>;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;

  return <main className={`messenger ${mobileChatOpen ? "mobile-chat-open" : ""}`}>
    <a className="skip-link" href="#main-content" onClick={event => {
      if (window.matchMedia("(max-width: 680px)").matches && !mobileChatOpen) {
        event.preventDefault();
        setMobileChatOpen(true);
        setTimeout(() => mainContentRef.current?.focus(), 0);
      }
    }}>Skip to conversation</a>
    <aside className="chat-sidebar">
      <div className="sidebar-top">
        <a className="brand" href="#home" aria-label="Chatapp home"><span className="brand-mark"><Icon name="message" size={19} /></span><span>chatapp</span></a>
        <button className="icon-button user-menu" type="button" title="Sign out" aria-label="Sign out" onClick={logout}><Avatar name={user.displayName} size="sm" /></button>
      </div>
      <div className="sidebar-greeting"><span>YOUR INBOX</span><h1>Messages</h1></div>
      <div className="sidebar-actions">
        <label className="search-box"><Icon name="search" size={18} /><input value={sidebarQuery} onChange={event => setSidebarQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></label>
        <button className="icon-button new-chat-button" type="button" aria-label="Start a new chat" title="Start a new chat" onClick={() => setModal("chat")}><Icon name="plus" /></button>
      </div>
      <div className="inbox-tabs"><span className="active-tab">All chats <b>{conversations.length}</b></span><button type="button" onClick={() => setModal("group")}><Icon name="users" size={16} /> New group</button></div>
      <div className="conversation-list" role="list" aria-label="Conversations">
        {visibleConversations.map(conversation => {
          const name = conversationName(conversation, user.id);
          const preview = previews[conversation.id] ?? (conversation.type === "group" ? "Group conversation" : "Start a conversation");
          return <button className={`conversation-row ${selectedId === conversation.id ? "selected" : ""}`} key={conversation.id} type="button" role="listitem" onClick={() => selectConversation(conversation.id)}>
            <Avatar name={name} size="lg" />
            <span className="conversation-copy"><span className="conversation-title">{name}</span><span className="conversation-preview">{preview}</span></span>
            <span className="conversation-meta">{unread[conversation.id] ? <b className="unread-count">{unread[conversation.id]}</b> : null}</span>
          </button>;
        })}
        {!visibleConversations.length && <div className="empty-list"><span className="empty-icon"><Icon name="search" size={22} /></span><strong>{sidebarQuery ? "No matches" : "Your chats will show up here"}</strong><p>{sidebarQuery ? "Try another name or username." : "Start a chat and say hello."}</p>{!sidebarQuery && <button type="button" className="text-button" onClick={() => setModal("chat")}>Find someone <span>→</span></button>}</div>}
      </div>
      <div className="sidebar-bottom"><div className={`connection-indicator ${socketOnline ? "is-online" : ""}`}><span />{socketOnline ? "Connected" : "Reconnecting…"}</div><span className="sidebar-user">Signed in as <strong>{user.displayName}</strong></span></div>
    </aside>

    <section ref={mainContentRef} className={`chat-panel ${selected ? "has-chat" : ""}`} aria-label="Conversation" id="main-content" tabIndex={-1}>
      {selected ? <>
        <header className="chat-header">
          <button className="icon-button mobile-back" type="button" aria-label="Back to chats" onClick={() => setMobileChatOpen(false)}><Icon name="back" /></button>
          <Avatar name={conversationName(selected, user.id)} size="md" />
          <div className="chat-heading"><h2>{conversationName(selected, user.id)}</h2><span>{conversationSubtitle(selected, user.id)}</span></div>
          <div className="header-tools"><span className={`connection-indicator header-connection ${socketOnline ? "is-online" : ""}`}><span />{socketOnline ? "Live" : "Offline"}</span><button className="icon-button" type="button" title="Sign out" aria-label="Sign out" onClick={logout}><Icon name="logout" /></button></div>
        </header>
        {notice && <div className="notice-bar" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}><Icon name="close" size={16} /></button></div>}
        <div className="message-scroll">
          <div className="chat-date"><span>THIS IS THE START OF YOUR STORY</span></div>
          {messages.map(message => {
            const mine = message.senderId === user.id;
            return <article className={`message-line ${mine ? "mine" : "theirs"}`} key={message.id}>
              {!mine && <Avatar name={selected.type === "group" ? selected.participants.find(person => person.id === message.senderId)?.displayName ?? "Member" : conversationName(selected, user.id)} size="sm" />}
              <div className="message-stack">
                {!mine && selected.type === "group" && <span className="message-author">{selected.participants.find(person => person.id === message.senderId)?.displayName ?? "Member"}</span>}
                <div className="message-bubble">
                  {message.content && <p>{message.content}</p>}
                  {message.attachment && <a className="attachment-card" href={`/api/backend${message.attachment.downloadPath.replace(/^\/v1/, "")}`} target="_blank" rel="noreferrer"><span className="attachment-icon"><Icon name={message.type === "image" ? "image" : "paperclip"} /></span><span><strong>{message.attachment.fileName}</strong><small>{message.attachment.contentType} · {formatBytes(message.attachment.sizeBytes)}</small></span></a>}
                  <span className="message-time">{timeLabel(message.createdAt)}{mine && <span className="message-check" aria-label="sent">✓</span>}</span>
                </div>
              </div>
            </article>;
          })}
          <div ref={bottomRef} />
        </div>
        <form className="composer" onSubmit={sendMessage}>
          <input ref={fileRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,audio/mpeg,audio/wav,application/pdf" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void uploadFile(file); }} />
          <button className="icon-button attach-button" type="button" aria-label="Attach a file" title="Attach a file" disabled={working} onClick={() => fileRef.current?.click()}><Icon name="paperclip" /></button>
          <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={handleComposerKey} placeholder="Write a message…" aria-label="Write a message" maxLength={4000} rows={1} />
          <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
          <button className="send-button" type="submit" aria-label="Send message" title="Send message" disabled={!draft.trim() || working}><Icon name="send" size={18} /></button>
        </form>
      </> : <div className="welcome-panel">
        <div className="welcome-art"><span className="welcome-orbit" /><span className="welcome-card card-a"><Avatar name="Maya Chen" size="sm" /><i /></span><span className="welcome-card card-b"><Avatar name="Noah James" size="sm" /><i /><i /></span><span className="welcome-center"><Icon name="message" size={32} /></span></div>
        <span className="eyebrow">A LITTLE SPACE FOR YOUR PEOPLE</span><h2>Make room for<br />good conversations.</h2><p>Pick a chat from the list or start a new one. Your messages stay between you and the people in them.</p><button className="primary-button" type="button" onClick={() => setModal("chat")}><Icon name="plus" size={18} /> Start a conversation</button>
      </div>}
    </section>

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
    if (value.length < 2) { setPeople([]); setError(""); return; }
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

  useEffect(() => {
    function escape(event: globalThis.KeyboardEvent) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  function toggle(person: PublicUser) {
    setPicked(current => current.some(item => item.id === person.id) ? current.filter(item => item.id !== person.id) : [...current, person]);
  }

  function keepFocusInDialog(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )].filter(control => control.offsetParent !== null);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="people-modal" role="dialog" aria-modal="true" aria-labelledby="people-modal-title" onKeyDown={keepFocusInDialog}>
      <div className="modal-head"><div><span className="eyebrow">{mode === "chat" ? "START SOMETHING NEW" : "BRING YOUR PEOPLE TOGETHER"}</span><h2 id="people-modal-title">{mode === "chat" ? "Find a person" : "Create a group"}</h2></div><button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button></div>
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
  </div>;
}
