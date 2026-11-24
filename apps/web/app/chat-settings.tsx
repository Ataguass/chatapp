"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { AccountDevice, PublicUser } from "@messaging/contracts";
import { api } from "../lib/client-api";
import { ChatDialog } from "./chat-dialog";
import { AccountSecurity } from "./account-security";
import { Avatar, Icon } from "./ui";

type Section = "Profile" | "Privacy" | "Notifications" | "Devices";
type BlockPage = { users: PublicUser[]; nextCursor: string | null };
export type ProfileFields = { displayName: string; bio: string | null; avatarUrl: string | null };
const sections: Section[] = ["Profile", "Privacy", "Notifications", "Devices"];

export function ChatSettings({ user, compact, onDensityChange, onSave, onSignOut, onDeleted, onPasswordChanged }: {
  user: PublicUser;
  compact: boolean;
  onDensityChange: (value: boolean) => void;
  onSave: (values: ProfileFields) => Promise<void>;
  onSignOut: (everywhere: boolean) => Promise<void>;
  onDeleted: () => void;
  onPasswordChanged: () => void;
}) {
  const [section, setSection] = useState<Section>("Profile");
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio ?? "");
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null);
  const [blocks, setBlocks] = useState<BlockPage>({ users: [], nextCursor: null });
  const [devices, setDevices] = useState<AccountDevice[]>([]);
  const [revokeDevice, setRevokeDevice] = useState<AccountDevice | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  useEffect(() => {
    if (section === "Profile") return;
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    const request = section === "Privacy"
      ? api<BlockPage>("users/me/blocks", { signal }).then(result => { if (!signal.aborted) setBlocks(result); })
      : section === "Notifications"
        ? api<{ pushEnabled: boolean }>("push/preferences", { signal }).then(result => { if (!signal.aborted) setPushEnabled(result.pushEnabled); })
        : api<AccountDevice[]>("users/me/devices", { signal }).then(result => { if (!signal.aborted) setDevices(result); });
    void request.catch(() => { if (!signal.aborted) setError(`Couldn't load ${section.toLowerCase()} settings.`); })
      .finally(() => { if (!signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [section, revision]);

  async function run(action: () => Promise<void>, fallback: string) {
    if (busy) return;
    setBusy(true); setError(""); setFeedback("");
    try { await action(); }
    catch (caught) { setError(caught instanceof Error && caught.message === "invalid_avatar_url" ? "Use an HTTPS link for the profile photo." : fallback); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!displayName.trim()) return;
    await run(async () => {
      await onSave({ displayName: displayName.trim(), bio: bio.trim() || null, avatarUrl: avatarUrl.trim() || null });
      setFeedback("Profile saved.");
    }, "Couldn't save your profile.");
  }

  return <div className="workspace-body settings-body">
    <header className="workspace-heading"><span className="workspace-heading-icon"><Icon name="settings" /></span><h1>Settings</h1><p>Manage your profile, privacy, notifications, and devices.</p></header>
    <div className="account-tabs" aria-label="Settings sections">
      {sections.map(tab => <button type="button" key={tab} aria-pressed={tab === section} disabled={busy} onClick={() => {
        setSection(tab); setLoading(tab !== "Profile"); setError(""); setFeedback(""); setConfirmSignOut(false);
      }}>{tab}</button>)}
    </div>
    {feedback && <p className="workspace-feedback" role="status">{feedback}</p>}
    {error && <p className="workspace-feedback is-error" role="alert">{error} {section !== "Profile" && <button type="button" className="text-button" onClick={() => { setError(""); setRevision(value => value + 1); }}>Refresh</button>}</p>}
    {section === "Profile" && <>
      <div className="workspace-card workspace-settings-card">
        <div className="profile-summary"><Avatar name={user.displayName} size="lg" /><div><h2>{user.displayName}</h2><p>@{user.username}</p></div></div>
        <form className="account-form" onSubmit={save} aria-busy={busy}>
          <label>Display name<input autoComplete="name" value={displayName} maxLength={100} required onChange={event => setDisplayName(event.target.value)} /></label>
          <label>Bio<textarea value={bio} maxLength={500} rows={3} onChange={event => setBio(event.target.value)} /></label>
          <label>Profile photo URL<input type="url" autoComplete="url" value={avatarUrl} placeholder="https://…" maxLength={2048} onChange={event => setAvatarUrl(event.target.value)} /></label>
          <button className="primary-button" disabled={busy || !displayName.trim()}>{busy ? "Saving…" : "Save profile"}</button>
        </form>
      </div>
      <div className="workspace-card workspace-settings-card"><h2>Appearance</h2><label className="account-toggle"><input type="checkbox" checked={compact} onChange={event => onDensityChange(event.target.checked)} /> Compact messages</label></div>
    </>}
    {section === "Privacy" && <>
      <section className="workspace-card workspace-settings-card" aria-label="Blocked accounts" aria-busy={loading}>
        <h2>Blocked accounts</h2>
        {!blocks.users.length && <p>{loading ? "Loading blocked accounts…" : "You haven’t blocked anyone."}</p>}
        {blocks.users.map(person => <div className="workspace-row" key={person.id}><Avatar name={person.displayName} size="sm" /><div className="workspace-row-copy"><strong>{person.displayName}</strong><span>@{person.username}</span></div>
          <button type="button" className="quiet-button" disabled={busy} onClick={() => void run(async () => {
            await api(`users/${person.id}/block`, { method: "DELETE" });
            setBlocks(current => ({ ...current, users: current.users.filter(item => item.id !== person.id) }));
            setFeedback(`Unblocked ${person.displayName}.`);
          }, "Couldn't unblock that account.")}>Unblock</button></div>)}
        {blocks.nextCursor && <button type="button" className="quiet-button" disabled={busy || loading} onClick={() => void run(async () => {
          const result = await api<BlockPage>(`users/me/blocks?cursor=${encodeURIComponent(blocks.nextCursor!)}`);
          setBlocks(current => ({ users: [...current.users, ...result.users], nextCursor: result.nextCursor }));
        }, "Couldn't load more accounts.")}>Show more</button>}
      </section>
      <div className="workspace-card workspace-settings-card account-settings">
        <AccountSecurity username={user.username} onDeleted={onDeleted} onPasswordChanged={onPasswordChanged} />
      </div>
    </>}
    {section === "Notifications" && <section className="workspace-card workspace-settings-card" aria-label="Notifications" aria-busy={loading || busy}>
      <h2>Message notifications</h2>
      <label className="account-toggle"><input type="checkbox" checked={pushEnabled === true} disabled={loading || busy || pushEnabled === null} onChange={event => {
        const checked = event.target.checked;
        void run(async () => {
          const result = await api<{ pushEnabled: boolean }>("push/preferences", { method: "PATCH", body: JSON.stringify({ pushEnabled: checked }) });
          setPushEnabled(result.pushEnabled); setFeedback("Notification preference saved.");
        }, "Couldn't update notifications.");
      }} /> Allow push notifications</label>
      <p>This preference applies across your devices. You can mute individual conversations from the chat header.</p>
    </section>}
    {section === "Devices" && <section className="workspace-card workspace-settings-card" aria-label="Connected devices" aria-busy={loading || busy}>
      <h2>Connected devices</h2>
      {!devices.length && <p>{loading ? "Loading devices…" : "No devices to show."}</p>}
      {devices.map(device => <div className="workspace-row" key={device.id}><span className="device-symbol"><Icon name="shield" size={18} /></span><div className="workspace-row-copy"><strong>{device.deviceName}{device.current ? " · This device" : ""}</strong><span>{device.platform} · Active {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(device.lastSeenAt))}</span></div>
        {!device.current && <button type="button" className="quiet-button" disabled={busy} onClick={() => setRevokeDevice(device)}>Sign out device</button>}</div>)}
      <div className="dialog-actions">
        <button className="quiet-button" type="button" disabled={busy} onClick={() => void run(() => onSignOut(false), "Couldn't sign out.")}>Sign out</button>
        <button className="quiet-button" type="button" disabled={busy} onClick={() => setConfirmSignOut(true)}>Sign out on all devices</button>
      </div>
    </section>}
    {revokeDevice && <ChatDialog title="Sign out this device?" onClose={() => { if (!busy) setRevokeDevice(null); }}>
      <p className="dialog-description">{revokeDevice.deviceName} will need to sign in again.</p>
      <div className="dialog-actions"><button className="quiet-button" type="button" disabled={busy} onClick={() => setRevokeDevice(null)}>Cancel</button>
        <button className="danger-button" type="button" disabled={busy} onClick={() => void run(async () => {
          await api(`users/me/devices/${revokeDevice.id}`, { method: "DELETE" });
          setDevices(current => current.filter(item => item.id !== revokeDevice.id));
          setRevokeDevice(null); setFeedback("Device signed out.");
        }, "Couldn't sign out that device.")}>Sign out device</button></div>
    </ChatDialog>}
    {confirmSignOut && <ChatDialog title="Sign out everywhere?" onClose={() => { if (!busy) setConfirmSignOut(false); }}>
      <p className="dialog-description">Every device, including this one, will need to sign in again.</p>
      <div className="dialog-actions"><button className="quiet-button" type="button" disabled={busy} onClick={() => setConfirmSignOut(false)}>Cancel</button>
        <button className="danger-button" type="button" disabled={busy} onClick={() => void run(() => onSignOut(true), "Couldn't sign out every device.")}>Sign out everywhere</button></div>
    </ChatDialog>}
  </div>;
}
