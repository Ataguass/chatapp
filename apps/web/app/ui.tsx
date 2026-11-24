import { useState, type ReactNode } from "react";

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part.charAt(0).toUpperCase()).join("") || "?";
}

function colorIndex(name: string) {
  return [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6;
}

export function Avatar({ name, size = "md", online = false, src }: { name: string; size?: "sm" | "md" | "lg"; online?: boolean; src?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span className={`avatar avatar-${size} avatar-tone-${colorIndex(name)}`} role="img" aria-label={online ? `${name}, online` : name}>
    {src && src !== failed ? <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(src)} /> : initials(name)}
    {online && <i className="online-dot" aria-hidden="true" />}
  </span>;
}

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  const paths: Record<string, ReactNode> = {
    settings: <><path d="M10 3h4l1 3 3 1 2-1 2 4-2 2v2l2 2-2 4-3-1-2 1-1 3h-4l-1-3-3-1-2 1-2-4 2-2v-2L2 10l2-4 3 1 2-1z"/><circle cx="12" cy="13" r="3"/></>,
    reply: <path d="m10 7-6 5 6 5v-4h3a6 6 0 0 1 6 5c1-6-1-9-6-9h-3z"/>,
    forward: <path d="m14 7 6 5-6 5v-4h-3a6 6 0 0 0-6 5c-1-6 1-9 6-9h3z"/>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    history: <><circle cx="12" cy="12" r="8"/><path d="M12 7v5l4 2"/></>,
    story: <><circle cx="12" cy="12" r="9" strokeDasharray="4 3"/><circle cx="12" cy="12" r="4"/></>,
    shield: <><path d="m12 22 5-4a7 7 0 0 0 3-6V5l-8-3-8 3v7a7 7 0 0 0 3 6z"/><path d="m9 12 2 2 4-4"/></>,
    edit: <><path d="m4 16 11-11 4 4L8 20H4zM13 7l4 4"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.2 4.2" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    send: <><path d="m21 3-7.2 18-3.6-7.2L3 10.2 21 3Z" /><path d="M10.2 13.8 15 9" /></>,
    paperclip: <><path d="m8.5 12.5 7-7a4 4 0 0 1 5.7 5.7l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2" /></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></>,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    back: <><path d="m15 18-6-6 6-6" /></>,
    select: <><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m8 12 2.5 2.5 5-5"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></>,
    phone: <path d="M6.6 3h3l1.5 4.5-2.4 1.9a15 15 0 0 0 5.9 5.9l1.9-2.4L21 14.4v3a3 3 0 0 1-3.1 3C10 19.8 4.2 14 3.6 6.1A3 3 0 0 1 6.6 3Z"/>,
    video: <><rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M20 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
    message: <><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" /></>,
  };
  return <svg {...common}>{paths[name] ?? paths.message}</svg>;
}
