"use client";

import { useEffect, useState } from "react";
import type { CallKind, DirectCallRecord } from "@messaging/contracts";
import { api } from "../lib/client-api";
import { Avatar, Icon } from "./ui";

type CallPage = { calls: DirectCallRecord[]; nextCursor: string | null };

export function CallHistory({ userId, contactName, online, calling, onOpenChat, onCall }: {
  userId: string;
  contactName: (id: string) => string | undefined;
  online: boolean;
  calling: boolean;
  onOpenChat: (id: string) => void;
  onCall: (id: string, kind: CallKind) => void;
}) {
  const [rows, setRows] = useState<DirectCallRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "missed">("all");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setBusy(true); setError("");
    void api<CallPage>("calls/history", { signal }).then(result => {
      if (!signal.aborted) { setRows(result.calls); setCursor(result.nextCursor); }
    }).catch(() => {
      if (!signal.aborted) setError("Call history couldn't load.");
    }).finally(() => { if (!signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [calling, refresh, userId]);

  async function loadMore() {
    if (!cursor || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api<CallPage>(`calls/history?cursor=${encodeURIComponent(cursor)}`);
      setRows(current => [...current, ...result.calls.filter(row => !current.some(item => item.id === row.id))]);
      setCursor(result.nextCursor);
    } catch { setError("More calls couldn't load."); }
    finally { setBusy(false); }
  }

  const missed = (row: DirectCallRecord) => row.recipientId === userId && !row.acceptedAt && !!row.endedAt;
  const filtered = filter === "missed" ? rows.filter(missed) : rows;

  return <div className="workspace-body">
    <header className="workspace-heading"><span className="workspace-heading-icon"><Icon name="phone" /></span><h1>Calls</h1><p>Your voice and video call history.</p></header>
    <div className="account-tabs" aria-label="Filter calls">
      <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All calls</button>
      <button type="button" aria-pressed={filter === "missed"} onClick={() => setFilter("missed")}>Missed</button>
    </div>
    {error && <p className="workspace-feedback" role="alert">{error} <button className="text-button" type="button" onClick={() => setRefresh(value => value + 1)}>Try again</button></p>}
    <section className="workspace-card call-records" aria-label="Call history" aria-busy={busy}>
      {!filtered.length && <div className="workspace-empty"><Icon name="history" size={28} /><strong>{busy ? "Loading calls…" : filter === "missed" ? "No missed calls" : "No calls yet"}</strong>
        {!busy && filter === "all" && <p>Open a direct chat to start a voice or video call.</p>}</div>}
      {filtered.map(row => {
        const name = contactName(row.conversationId);
        const status = missed(row) ? "Missed" : !row.endedAt ? row.acceptedAt ? "In progress" : "Ringing" :
          row.endReason === "offline" ? "Offline" : row.endReason === "declined" ? "Declined" :
          row.endReason === "no_answer" ? "No answer" : row.acceptedAt ? (row.callerId === userId ? "Outgoing" : "Incoming") : "Ended";
        return <div className="workspace-row call-record" key={row.id}>
          <Avatar name={name ?? "Contact"} />
          <div className="workspace-row-copy"><strong>{name ?? "Chat contact"}</strong><span className={status === "Missed" ? "is-missed" : undefined}>
            {status} · {row.kind === "video" ? "Video" : "Voice"} · <time dateTime={row.startedAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(row.startedAt))}</time>
          </span></div>
          {name && <div className="workspace-row-actions">
            <button className="icon-button chat-tool" type="button" aria-label={`Open chat with ${name}`} title="Open chat" onClick={() => onOpenChat(row.conversationId)}><Icon name="message" size={18} /></button>
            <button className="icon-button chat-tool" type="button" aria-label={`Call ${name} again`} title={online ? "Call again" : "Connect to place a call"} disabled={!online || calling} onClick={() => onCall(row.conversationId, row.kind)}><Icon name={row.kind === "video" ? "video" : "phone"} size={18} /></button>
          </div>}
        </div>;
      })}
    </section>
    {cursor && <button className="quiet-button" type="button" disabled={busy} onClick={() => void loadMore()}>Load older calls</button>}
  </div>;
}
