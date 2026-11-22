/** Public HTTP response contract. Internal dependency details are only logged server-side. */
export type HealthResponse = { status: "live" | "ready" | "unavailable" };

export type DevicePlatform = "android" | "ios" | "web" | "desktop";

export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
};

export type AuthSessionResponse = {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  user: PublicUser;
};

export type ConversationSummary = {
  id: string;
  type: "direct" | "group";
  title: string | null;
  createdAt: string;
  participants: PublicUser[];
};

export type GroupMemberEvent = {
  conversationId: string;
  userId: string;
  role: "owner" | "admin" | "member";
};

export type GroupMemberRemovedEvent = { conversationId: string; userId: string };

export type GroupConversationUpdatedEvent = { conversation: ConversationSummary };

export type PublicMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  content: string;
  replyToMessageId: string | null;
  replyTo: { id: string; senderId: string; content: string; deletedAt: string | null } | null;
  reactions: MessageReactionSummary[];
  type: "text" | "image" | "video" | "audio" | "document";
  attachment: PublicAttachment | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
};

export type PublicAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  category: "image" | "video" | "audio" | "document";
  sizeBytes: number;
  downloadPath: string;
};

export type MessageReactionSummary = { emoji: string; count: number; reactedByMe: boolean };

export type MessageReactionEvent = {
  conversationId: string;
  messageId: string;
  userId: string;
  emoji: string;
  active: boolean;
  count: number;
};

export type MessageUpdatedEvent = { message: PublicMessage };

export type MessageDeletedEvent = {
  conversationId: string;
  messageId: string;
  deletedAt: string;
};

export type MessagePage = {
  messages: PublicMessage[];
  nextCursor: string | null;
};

export type MessageSendEvent = {
  conversationId: string;
  clientMessageId: string;
  content: string;
  replyToMessageId?: string | null;
};

export type MessageAckEvent = {
  message: PublicMessage;
  created: boolean;
};

export type RealtimeAck<T> = { ok: true; data: T } | { ok: false; error: string };

export type TypingEvent = { conversationId: string; userId: string };

export type ConversationReadCursorEvent = {
  conversationId: string;
  userId: string;
  lastReadMessageId: string;
  readAt: string;
};

export type ConversationReadCursorView = {
  userId: string;
  lastReadMessageId: string | null;
  readAt: string | null;
};

export type ApiError = { error: string };
