import type { MessagePage, PublicMessage } from "@messaging/contracts";

export function mergeMessages(current: PublicMessage[], incoming: PublicMessage[]) {
  if (!incoming.length) return current;
  const messages = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) {
    const previous = messages.get(message.id);
    if (previous?.deletedAt && !message.deletedAt) continue;
    if (previous?.editedAt && !message.deletedAt && previous.editedAt > (message.editedAt ?? "")) continue;
    messages.set(message.id, message);
  }
  return [...messages.values()].sort((left, right) => {
    if (!left.position || !right.position) {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    }
    if (left.position.length !== right.position.length) return left.position.length - right.position.length;
    return left.position < right.position ? -1 : left.position > right.position ? 1 : 0;
  });
}

export async function synchronizeHistory(
  load: (before?: string) => Promise<MessagePage>,
  checkpoint: string | null | undefined,
) {
  const latest = await load();
  const batches = [latest.messages];
  let page = latest;
  while (checkpoint !== undefined && page.nextCursor && !page.messages.some(message => message.id === checkpoint)) {
    const before = page.nextCursor;
    page = await load(before);
    if (page.nextCursor === before) throw new Error("invalid_message_cursor");
    batches.push(page.messages);
  }
  return { messages: batches.reverse().flat(), newestId: latest.messages.at(-1)?.id ?? null };
}
