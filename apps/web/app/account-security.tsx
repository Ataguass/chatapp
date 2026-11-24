"use client";

import { useState, type FormEvent } from "react";
import { ChatDialog } from "./chat-dialog";

function accountError(code: string) {
  switch (code) {
    case "invalid_current_password": return "That password doesn't match your account.";
    case "invalid_recovery_credentials": return "The username or recovery code isn't valid.";
    case "invalid_password": return "Use at least 12 characters and no more than 128 bytes.";
    case "password_unchanged": return "Choose a password you haven't been using.";
    case "username_confirmation_required": return "Type your username exactly as it appears above.";
    case "auth_rate_limited": return "Too many attempts. Wait a few minutes and try again.";
    case "account_changed_retry": return "Your account changed during this request. Try again.";
    case "unauthorized": return "Sign in again to continue.";
    default: return "Couldn't complete that request. Try again shortly.";
  }
}

async function submitAccount(method: "POST" | "DELETE", body: Record<string, string>, query = "") {
  try {
    const response = await fetch(`/api/session${query}`, { method,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) return { error: "", data: response.status === 204 ? null : await response.json() };
    const data = await response.json().catch(() => null);
    return { error: accountError(data?.error ?? ""), data: null };
  } catch {
    return { error: "Couldn't reach Chatapp. Check your connection and try again.", data: null };
  }
}

export function RecoveryDialog({ initialUsername, onClose, onRecovered }: {
  initialUsername: string; onClose: () => void; onRecovered: (username: string) => void;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (password !== confirm) { setError("The new passwords don't match."); return; }
    setBusy(true);
    setError("");
    const result = await submitAccount("POST", { action: "reset_password", username, code, password });
    setBusy(false);
    if (result.error) setError(result.error);
    else onRecovered(username.trim().toLowerCase());
  }

  return <ChatDialog title="Reset password" onClose={() => { if (!busy) onClose(); }}>
    <p className="dialog-description">Enter a recovery code saved from Settings. A reset signs out every device and invalidates the rest of your codes.</p>
    <form className="account-form" onSubmit={reset} aria-busy={busy}>
      <label>Username<input autoComplete="username" required maxLength={32} value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label>Recovery code<input autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={100} value={code} onChange={event => setCode(event.target.value)} /></label>
      <label>New password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button" disabled={busy}>{busy ? "Resetting…" : "Reset password"}</button>
    </form>
  </ChatDialog>;
}

export function AccountSecurity({ username, onDeleted, onPasswordChanged }: { username: string; onDeleted: () => void; onPasswordChanged: () => void }) {
  const [action, setAction] = useState<"codes" | "delete" | "password" | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  function choose(next: typeof action) {
    setAction(next); setPassword(""); setConfirmation(""); setNewPassword(""); setCodes([]); setStatus("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || busy) return;
    if (action === "password" && newPassword !== confirmation) {
      setStatus("The new passwords don't match.");
      return;
    }
    setBusy(true);
    setStatus("");
    const result = action === "delete"
      ? await submitAccount("DELETE", { username: confirmation, password }, "?account=1")
      : await submitAccount("POST", action === "password"
        ? { action: "change_password", currentPassword: password, newPassword }
        : { action: "recovery_codes", password });
    setBusy(false);
    setPassword("");
    if (result.error) { setStatus(result.error); return; }
    if (action === "delete") { onDeleted(); return; }
    if (action === "password") { onPasswordChanged(); return; }
    if (Array.isArray(result.data?.codes)) {
      setCodes(result.data.codes);
      setAction(null);
    }
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setStatus("Codes copied. Store them somewhere private.");
    } catch { setStatus("Couldn't copy the codes. You can select and copy them manually."); }
  }

  return <>
    <section aria-labelledby="change-password-title">
      <h3 id="change-password-title">Password</h3>
      <button className="quiet-button" type="button" disabled={busy} onClick={() => choose("password")}>Change password</button>
    </section>
    <section aria-labelledby="recovery-codes-title">
      <h3 id="recovery-codes-title">Account recovery</h3>
      <p className="dialog-description">Generate backup codes before you lose access to your password.</p>
      <button className="quiet-button" type="button" disabled={busy} onClick={() => choose("codes")}>Generate recovery codes</button>
      {!!codes.length && <div className="account-confirm">
        <p>Save these codes now. Chatapp only shows them once. A password reset cancels all remaining codes.</p>
        <ul className="recovery-code-list" aria-label="Recovery codes">{codes.map(code => <li key={code}><code>{code}</code></li>)}</ul>
        <div className="dialog-actions"><button className="quiet-button" type="button" onClick={() => void copyCodes()}>Copy codes</button>
          <button className="quiet-button" type="button" onClick={() => choose(null)}>Done</button></div>
      </div>}
    </section>
    <section aria-labelledby="delete-account-title">
      <h3 id="delete-account-title">Delete account</h3>
      <p className="dialog-description">Permanently remove your profile, messages, and uploads. Other people keep their own messages.</p>
      <button className="danger-button" type="button" disabled={busy} onClick={() => choose("delete")}>Delete account</button>
    </section>
    {action && <form className="account-form account-confirm" onSubmit={submit} aria-busy={busy}>
      <p>{action === "codes" ? "Generating codes replaces any previously saved codes." : action === "password"
        ? "Changing your password signs out all devices and invalidates recovery codes."
        : "This cannot be undone. Type your username and enter your password to confirm."}</p>
      {action === "delete" && <label>Type {username}<input autoComplete="off" spellCheck={false} required maxLength={32} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      <label>Current password<input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></label>
      {action === "password" && <>
        <label>New password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={newPassword} onChange={event => setNewPassword(event.target.value)} /></label>
        <label>Confirm new password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      </>}
      <div className="dialog-actions">
        <button className="quiet-button" type="button" disabled={busy} onClick={() => choose(null)}>Cancel</button>
        <button className={action === "delete" ? "danger-button" : "primary-button"} disabled={busy || !password || (action === "delete" && confirmation !== username)}>
          {busy ? "Working…" : action === "delete" ? "Permanently delete account" : action === "password" ? "Save new password" : "Replace recovery codes"}
        </button>
      </div>
    </form>}
    {status && <p className="dialog-feedback" role="status">{status}</p>}
  </>;
}
