"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

export function ChatDialog({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);

  return <dialog ref={dialog} className="chat-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="chat-dialog-header">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="quiet-button" onClick={onClose}>Close</button>
    </header>
    {children}
  </dialog>;
}
