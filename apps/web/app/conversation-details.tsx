"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ConversationSummary, PublicUser } from "@messaging/contracts";
import { api } from "../lib/client-api";
import { ChatDialog } from "./chat-dialog";
import { Avatar } from "./ui";

type Member = { user: PublicUser; role: "owner" | "admin" | "member" };
type Invite = { id: string; expiresAt: string; maxUses: number; useCount: number; revokedAt: string | null };

export function ConversationDetails({ conversation, userId, onClose, onUpdated, onLeft }: {
  conversation: ConversationSummary;
  userId: string;
  onClose: () => void;
  onUpdated: (conversation: ConversationSummary) => void;
  onLeft: () => void;
}) {
  const path = `conversations/${conversation.id}`;
  const group = conversation.type === "group";
  const peer = conversation.participants.find(person => person.id !== userId);
  const [settings, setSettings] = useState<{ pushMuted: boolean } | null>(null);
  const [title, setTitle] = useState(conversation.title ?? "");
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteLink, setInviteLink] = useState("");
  const [search, setSearch] = useState("");
  const [people, setPeople] = useState<PublicUser[]>([]);
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const [confirmLabel, setConfirmLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const role = members.find(member => member.user.id === userId)?.role;
  const manages = role === "owner" || role === "admin";

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void api<{ pushMuted: boolean }>(`${path}/settings`, { signal })
      .then(value => { if (!signal.aborted) setSettings(value); })
      .catch(() => { if (!signal.aborted) setError("Couldn't load conversation settings."); });
    if (group) void api<Member[]>(`${path}/members`, { signal })
      .then(value => { if (!signal.aborted) setMembers(value); })
      .catch(() => { if (!signal.aborted) setError("Couldn't load group members."); });
    return () => controller.abort();
  }, [group, path, revision]);

  useEffect(() => {
    if (!manages) return;
    const controller = new AbortController();
    void api<Invite[]>(`${path}/invites`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setInvites(value); })
      .catch(() => { if (!controller.signal.aborted) setError("Couldn't load group invitations."); });
    return () => controller.abort();
  }, [manages, path, revision]);

  useEffect(() => {
    if (!manages || search.trim().length < 2) { setPeople([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<PublicUser[]>(`users/search?q=${encodeURIComponent(search.trim())}`, { signal: controller.signal })
        .then(value => { if (!controller.signal.aborted) setPeople(value); })
        .catch(() => { if (!controller.signal.aborted) setError("Couldn't search for accounts."); });
    }, 220);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [manages, search]);

  async function run(action: () => Promise<void>, fallback: string) {
    if (busy) return;
    setBusy(true); setError(""); setFeedback("");
    try { await action(); }
    catch { setError(fallback); }
    finally { setBusy(false); }
  }

  function confirm(label: string, action: () => Promise<void>) {
    setPending(() => action);
    setConfirmLabel(label);
  }

  return <ChatDialog title={group ? "Group details" : "Chat details"} onClose={() => { if (!busy) onClose(); }}>
    <div className="dialog-content-stack" aria-busy={busy}>
      <div className="profile-summary"><Avatar name={group ? conversation.title ?? "Group" : peer?.displayName ?? "Deleted account"} size="lg" /><div>
        <h3>{group ? conversation.title : peer?.displayName ?? "Deleted account"}</h3>
        <p>{group ? `${conversation.participants.length} members` : peer ? `@${peer.username}` : "Read-only chat"}</p>
      </div></div>
      {settings && <label className="account-toggle"><input type="checkbox" checked={settings.pushMuted} disabled={busy} onChange={event => {
        const muted = event.target.checked;
        void run(async () => {
          const next = await api<{ pushMuted: boolean }>(`${path}/settings`, {
            method: "PATCH", body: JSON.stringify({ pushMuted: muted }),
          });
          setSettings(next); setFeedback(muted ? "Conversation muted." : "Conversation unmuted.");
        }, "Couldn't update notifications.");
      }} /> Mute notifications for this chat</label>}
      {group && <>
        {manages && <form className="account-form" onSubmit={event => {
          event.preventDefault();
          void run(async () => {
            onUpdated(await api<ConversationSummary>(path, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) }));
            setFeedback("Group name saved.");
          }, "Couldn't rename the group.");
        }}><label>Group name<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required /></label>
          <button type="submit" className="quiet-button" disabled={busy || !title.trim() || title.trim() === conversation.title}>Save group name</button>
        </form>}
        <section aria-label="Group members"><h3>Members</h3>
          {members.map(member => <div className="workspace-row" key={member.user.id}>
            <Avatar name={member.user.displayName} size="sm" />
            <div className="workspace-row-copy"><strong>{member.user.displayName}{member.user.id === userId ? " · You" : ""}</strong><span>{member.role} · @{member.user.username}</span></div>
            {member.user.id !== userId && member.role !== "owner" && (role === "owner" || role === "admin" && member.role === "member") && <div className="workspace-row-actions group-actions">
              {role === "owner" && <button className="quiet-button" type="button" disabled={busy} onClick={() => void run(async () => {
                await api(`${path}/members/${member.user.id}/role`, { method: "PATCH", body: JSON.stringify({ role: member.role === "admin" ? "member" : "admin" }) });
                setRevision(value => value + 1);
              }, "Couldn't update the member’s role.")}>{member.role === "admin" ? "Remove admin access" : "Make admin"}</button>}
              <button className="quiet-button" type="button" disabled={busy} onClick={() => confirm(`Remove ${member.user.displayName} from the group?`, async () => {
                await api(`${path}/members/${member.user.id}`, { method: "DELETE" });
                setRevision(value => value + 1);
              })}>Remove</button>
              {role === "owner" && <button className="quiet-button" type="button" disabled={busy} onClick={() => confirm(`Transfer ownership to ${member.user.displayName}?`, async () => {
                await api(`${path}/transfer-ownership`, { method: "POST", body: JSON.stringify({ userId: member.user.id }) });
                setRevision(value => value + 1);
              })}>Transfer ownership</button>}
            </div>}
          </div>)}
        </section>
        {manages && <>
          <div className="account-form"><label>Add a member by username<input value={search} onChange={event => setSearch(event.target.value)} /></label>
            {people.filter(person => !members.some(member => member.user.id === person.id)).map(person => <div className="workspace-row" key={person.id}>
              <div className="workspace-row-copy"><strong>{person.displayName}</strong><span>@{person.username}</span></div>
              <button type="button" className="quiet-button" disabled={busy} onClick={() => void run(async () => {
                await api(`${path}/members`, { method: "POST", body: JSON.stringify({ userIds: [person.id] }) });
                setSearch(""); setRevision(value => value + 1);
              }, "Couldn't add the member.")}>Add</button>
            </div>)}
          </div>
          <section aria-label="Invite links"><h3>Invite links</h3>
            <button type="button" className="quiet-button" disabled={busy} onClick={() => void run(async () => {
              const invite = await api<{ token: string }>(`${path}/invites`, { method: "POST", body: "{}" });
              const url = new URL(window.location.href);
              url.hash = `join/${invite.token}`;
              setInviteLink(url.href); setRevision(value => value + 1);
            }, "Couldn't create an invite.")}>Create an invite link</button>
            {inviteLink && <div className="account-form invite-link">
              <label>New invite link<input value={inviteLink} readOnly onFocus={event => event.target.select()} /></label>
              <button type="button" className="quiet-button" onClick={() => void navigator.clipboard?.writeText(inviteLink)
                .then(() => setFeedback("Invite link copied."), () => setFeedback("Select and copy the invite link."))}>Copy link</button>
            </div>}
            {invites.filter(invite => !invite.revokedAt && invite.useCount < invite.maxUses && new Date(invite.expiresAt) > new Date()).map(invite => <div className="workspace-row" key={invite.id}>
              <span className="workspace-row-copy"><strong>Expires {new Date(invite.expiresAt).toLocaleDateString()}</strong><span>{invite.useCount} of {invite.maxUses} used</span></span>
              <button type="button" className="quiet-button" disabled={busy} onClick={() => confirm("Revoke this invite link?", async () => {
                await api(`${path}/invites/${invite.id}`, { method: "DELETE" });
                setInviteLink(""); setRevision(value => value + 1);
              })}>Revoke</button>
            </div>)}
          </section>
        </>}
        {role && role !== "owner" && <button className="danger-button" type="button" disabled={busy} onClick={() => confirm("Leave this group?", async () => {
          await api(`${path}/leave`, { method: "POST" });
          onLeft();
        })}>Leave group</button>}
      </>}
      {!group && peer && <button className="danger-button" type="button" disabled={busy} onClick={() => confirm(`Block ${peer.displayName}?`, async () => {
        await api(`users/${peer.id}/block`, { method: "POST" });
        onClose();
      })}>Block account</button>}
      {pending && <div className="account-confirm">
        <p>{confirmLabel}</p>
        <div className="dialog-actions"><button className="quiet-button" type="button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
          <button className="danger-button" type="button" disabled={busy} onClick={() => void run(async () => {
            await pending(); setPending(null);
          }, "Couldn't complete this change.")}>Confirm</button></div>
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {feedback && <p className="dialog-feedback" role="status">{feedback}</p>}
    </div>
  </ChatDialog>;
}

type InvitePreview = { title: string; expiresAt: string; joined: boolean; canJoin: boolean };
function invitationToken(value: string) {
  const input = value.trim();
  if (/^[a-z\d_-]{43}$/i.test(input)) return input;
  try { return /^#join\/([a-z\d_-]{43})$/i.exec(new URL(input).hash)?.[1] ?? ""; }
  catch { return ""; }
}

export function InvitationDialog({ initialToken, onClose, onJoined }: {
  initialToken: string; onClose: () => void; onJoined: (chat: ConversationSummary) => void;
}) {
  const [input, setInput] = useState(initialToken);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const token = invitationToken(input);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || busy) return;
    setBusy(true); setError("");
    try {
      const init = { method: "POST", body: JSON.stringify({ token }) };
      if (!preview) setPreview(await api<InvitePreview>("conversations/invites/preview", init));
      else onJoined((await api<{ conversation: ConversationSummary }>("conversations/invites/redeem", init)).conversation);
    } catch (caught) {
      setError(caught instanceof Error && caught.message === "invite_unavailable" ? "This invitation has expired or is no longer available." : "Couldn't open this invitation.");
    } finally { setBusy(false); }
  }
  return <ChatDialog title="Join a group" onClose={() => { if (!busy) onClose(); }}>
    <form className="account-form" onSubmit={submit} aria-busy={busy}>
      <label>Invite link or code<input value={input} onChange={event => { setInput(event.target.value); setPreview(null); setError(""); }} autoComplete="off" required /></label>
      {preview && <div className="account-confirm"><strong>{preview.title}</strong><p>{preview.joined ? "You’re already a member." : !preview.canJoin ? "This group is full." : `Invitation expires ${new Date(preview.expiresAt).toLocaleDateString()}.`}</p></div>}
      {error && <p role="alert" className="form-error">{error}</p>}
      <button className="primary-button" disabled={!token || busy || preview?.canJoin === false}>{busy ? "Checking…" : preview?.joined ? "Open group" : preview ? "Join group" : "Preview invitation"}</button>
    </form>
  </ChatDialog>;
}
