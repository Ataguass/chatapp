"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PublicStory, PublicUser, StoryPrivacy, StoryVisibility } from "@messaging/contracts";
import { api } from "../lib/client-api";
import { ChatDialog } from "./chat-dialog";
import { Avatar, Icon } from "./ui";

type Feed = { stories: PublicStory[]; nextCursor: string | null };
const audiences: { value: StoryVisibility; label: string }[] = [
  { value: "connections", label: "Connections" }, { value: "everyone", label: "Everyone on Chatapp" },
  { value: "selected", label: "Selected accounts" }, { value: "excluded", label: "Connections except selected accounts" },
];

export function StoriesDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [feed, setFeed] = useState<Feed>({ stories: [], nextCursor: null });
  const [mode, setMode] = useState<"feed" | "new" | "privacy">("feed");
  const [selected, setSelected] = useState<PublicStory | null>(null);
  const [viewers, setViewers] = useState<{ user: PublicUser; viewedAt: string }[] | null>(null);
  const [viewerCursor, setViewerCursor] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [privacy, setPrivacy] = useState<StoryPrivacy | null>(null);
  const [chosen, setChosen] = useState<Record<string, PublicUser>>({});
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<PublicUser[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const storyKey = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void api<Feed>("stories/feed", { signal }).then(value => { if (!signal.aborted) setFeed(value); })
      .catch(() => { if (!signal.aborted) setError("Couldn't load stories."); })
      .finally(() => { if (!signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (mode !== "privacy") return;
    const controller = new AbortController();
    const { signal } = controller;
    void api<StoryPrivacy>("stories/privacy", { signal }).then(value => { if (!signal.aborted) setPrivacy(value); })
      .catch(() => { if (!signal.aborted) setError("Couldn't load story privacy."); });
    return () => controller.abort();
  }, [mode]);

  useEffect(() => {
    if (mode !== "privacy" || query.trim().length < 2) { setFound([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<PublicUser[]>(`users/search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal })
        .then(value => { if (!controller.signal.aborted) setFound(value); })
        .catch(() => { if (!controller.signal.aborted) setError("Couldn't search for accounts."); });
    }, 220);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [mode, query]);

  async function run(action: () => Promise<void>, fallback: string) {
    if (busy) return;
    setBusy(true); setError(""); setFeedback("");
    try { await action(); }
    catch { setError(fallback); }
    finally { setBusy(false); }
  }

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() && !file) return;
    await run(async () => {
      const clientId = storyKey.current ??= crypto.randomUUID();
      const story = file
        ? await api<PublicStory>("stories/media", { method: "POST", headers: {
          "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name), "X-Client-Message-Id": clientId,
        }, body: file })
        : await api<PublicStory>("stories", { method: "POST", body: JSON.stringify({ clientId, text }) });
      setFeed(current => ({ ...current, stories: [story, ...current.stories.filter(item => item.id !== story.id)] }));
      setMode("feed"); setText(""); setFile(null); storyKey.current = null;
      setFeedback("Story posted.");
    }, "Couldn't post the story. Check the file type or size.");
  }

  function open(story: PublicStory) {
    void run(async () => {
      const fresh = await api<PublicStory>(`stories/${story.id}`);
      if (fresh.author.id !== userId) {
        await api(`stories/${story.id}/views`, { method: "POST" });
        setFeed(current => ({ ...current, stories: current.stories.map(item => item.id === story.id ? { ...item, viewed: true } : item) }));
      }
      setSelected(fresh); setViewers(null); setViewerCursor(null); setConfirmDelete(false);
    }, "This story is no longer available.");
  }

  function loadViewers() {
    if (!selected) return;
    void run(async () => {
      const result = await api<{ viewers: { user: PublicUser; viewedAt: string }[]; nextCursor: string | null }>(
        `stories/${selected.id}/viewers${viewerCursor ? `?cursor=${encodeURIComponent(viewerCursor)}` : ""}`);
      setViewers(current => [...(current ?? []), ...result.viewers]); setViewerCursor(result.nextCursor);
    }, "Couldn't load viewers.");
  }

  return <ChatDialog title="Stories" onClose={() => { if (!busy) onClose(); }}>
    <div className="dialog-content-stack" aria-busy={busy || loading}>
      {!selected && <div className="account-tabs" aria-label="Story sections">
        {(["feed", "new", "privacy"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} disabled={busy} onClick={() => {
          setMode(value); setError(""); setFeedback("");
        }}>{value === "feed" ? "Feed" : value === "new" ? "New story" : "Audience"}</button>)}
      </div>}
      {mode === "feed" && !selected && <>
        {!feed.stories.length && <div className="workspace-empty"><Icon name="story" size={28} /><strong>{loading ? "Loading stories…" : "No active stories"}</strong></div>}
        {feed.stories.map(story => <button className="workspace-row story-row" type="button" disabled={busy} key={story.id} onClick={() => open(story)}>
          <Avatar name={story.author.displayName} /><span className="workspace-row-copy"><strong>{story.author.id === userId ? "Your story" : story.author.displayName}</strong>
            <span>{story.type === "text" ? story.text : story.type === "image" ? "Photo" : "Video"}</span></span>
          <span>{story.viewed ? "Viewed" : story.author.id === userId ? "" : "New"}</span>
        </button>)}
        {feed.nextCursor && <button type="button" className="quiet-button" disabled={busy} onClick={() => void run(async () => {
          const page = await api<Feed>(`stories/feed?cursor=${encodeURIComponent(feed.nextCursor!)}`);
          setFeed(current => ({ stories: [...current.stories, ...page.stories.filter(item => !current.stories.some(prior => prior.id === item.id))], nextCursor: page.nextCursor }));
        }, "Couldn't load more stories.")}>More stories</button>}
      </>}
      {selected && <>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => { setSelected(null); setError(""); }}><Icon name="back" size={16} /> Back to stories</button>
        <div className="profile-summary"><Avatar name={selected.author.displayName} /><div><h3>{selected.author.displayName}</h3><p>Expires {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(selected.expiresAt))}</p></div></div>
        {selected.text && <p className="story-text">{selected.text}</p>}
        {selected.media && (selected.type === "image"
          ? <img className="story-media" src={`/api/backend${selected.media.downloadPath.replace(/^\/v1/, "")}`} alt={`Photo story from ${selected.author.displayName}`} />
          : <video className="story-media" src={`/api/backend${selected.media.downloadPath.replace(/^\/v1/, "")}`} controls playsInline />)}
        {selected.author.id === userId && <>
          <div className="dialog-actions">
            <button type="button" className="quiet-button" disabled={busy || !!viewers && !viewerCursor} onClick={loadViewers}>{viewerCursor ? "More viewers" : "Viewers"}</button>
            <button type="button" className="danger-button" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete story</button>
          </div>
          {viewers && <section aria-label="Story viewers">{viewers.length ? viewers.map(viewer => <div className="workspace-row" key={viewer.user.id}>
            <Avatar name={viewer.user.displayName} size="sm" /><strong>{viewer.user.displayName}</strong>
          </div>) : <p>No views yet.</p>}</section>}
          {confirmDelete && <div className="account-confirm"><p>Remove this story from the feed?</p><div className="dialog-actions">
            <button type="button" className="quiet-button" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button type="button" className="danger-button" disabled={busy} onClick={() => void run(async () => {
              await api(`stories/${selected.id}`, { method: "DELETE" });
              setFeed(current => ({ ...current, stories: current.stories.filter(item => item.id !== selected.id) }));
              setSelected(null);
            }, "Couldn't delete this story.")}>Remove story</button></div></div>}
        </>}
      </>}
      {mode === "new" && <form className="account-form" onSubmit={publish}>
        <label>Story text<textarea value={text} onChange={event => { setText(event.target.value); storyKey.current = null; }} rows={4} maxLength={1000} disabled={!!file || busy} /></label>
        <label>Optional photo or video<input type="file" accept="image/jpeg,image/png,image/webp,video/mp4" disabled={busy} onChange={event => {
          setFile(event.target.files?.[0] ?? null); storyKey.current = null;
        }} /></label>
        <p className="dialog-description">Stories expire after 24 hours.</p>
        <button className="primary-button" disabled={busy || (!text.trim() && !file)}>{busy ? "Posting…" : "Post story"}</button>
      </form>}
      {mode === "privacy" && (privacy ? <form className="account-form" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const policy = await api<StoryPrivacy>("stories/privacy", { method: "PATCH", body: JSON.stringify(privacy) });
          setPrivacy(policy); setFeedback("Story audience saved.");
        }, "Couldn't save the story audience.");
      }}><label>Who can see your stories<select value={privacy.visibility} onChange={event => setPrivacy({
        visibility: event.target.value as StoryVisibility, userIds: [],
      })}>{audiences.map(audience => <option key={audience.value} value={audience.value}>{audience.label}</option>)}</select></label>
        {(privacy.visibility === "selected" || privacy.visibility === "excluded") && <>
          <label>Find accounts by username<input value={query} onChange={event => setQuery(event.target.value)} /></label>
          {privacy.userIds.map(id => <div className="workspace-row" key={id}><span className="workspace-row-copy">{chosen[id]?.displayName ?? `Account ending in ${id.slice(-6)}`}</span>
            <button type="button" className="quiet-button" onClick={() => setPrivacy({ ...privacy, userIds: privacy.userIds.filter(personId => personId !== id) })}>Remove</button></div>)}
          {found.filter(person => !privacy.userIds.includes(person.id)).map(person => <div className="workspace-row" key={person.id}><span className="workspace-row-copy">{person.displayName} · @{person.username}</span>
            <button type="button" className="quiet-button" onClick={() => {
              setChosen(current => ({ ...current, [person.id]: person })); setPrivacy({ ...privacy, userIds: [...privacy.userIds, person.id] });
            }}>Add</button></div>)}
        </>}
        <button className="primary-button" disabled={busy}>Save audience</button>
      </form> : !error && <p>Loading audience settings…</p>)}
      {error && <p className="form-error" role="alert">{error}</p>}
      {feedback && <p className="dialog-feedback" role="status">{feedback}</p>}
    </div>
  </ChatDialog>;
}
