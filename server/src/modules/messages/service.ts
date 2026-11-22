import { Prisma, PrismaClient } from "@prisma/client";
import type {
  ConversationReadCursorEvent,
  ConversationReadCursorView,
  MessageReactionEvent,
  MessageReactionSummary,
  PublicMessage,
} from "@messaging/contracts";
import { HttpError } from "../auth/service.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxMessageLength = 4000;
const replySelect = { id: true, senderId: true, content: true, deletedAt: true } as const;

function validateContent(content: string) {
  if (!content.trim() || [...content].length > maxMessageLength) {
    throw new HttpError(400, "invalid_message_content");
  }
}

function messageView(message: {
  id: string;
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  content: string;
  type: "text" | "image" | "video" | "audio" | "document";
  attachmentId: string | null;
  attachment?: { id: string; fileName: string; contentType: string; category: "image" | "video" | "audio" | "document"; sizeBytes: bigint } | null;
  replyToMessageId: string | null;
  replyTo?: { id: string; senderId: string; content: string; deletedAt: Date | null } | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}, reactions: MessageReactionSummary[] = []): PublicMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    clientMessageId: message.clientMessageId,
    content: message.content,
    replyToMessageId: message.replyToMessageId,
    replyTo: message.replyTo ? {
      id: message.replyTo.id,
      senderId: message.replyTo.senderId,
      content: message.replyTo.content,
      deletedAt: message.replyTo.deletedAt?.toISOString() ?? null,
    } : null,
    reactions,
    type: message.type,
    attachment: message.attachment && !message.deletedAt ? {
      id: message.attachment.id,
      fileName: message.attachment.fileName,
      contentType: message.attachment.contentType,
      category: message.attachment.category,
      sizeBytes: Number(message.attachment.sizeBytes),
      downloadPath: `/v1/conversations/${message.conversationId}/attachments/${message.attachment.id}`,
    } : null,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
  };
}

async function assertCanAccess(db: PrismaClient, conversationId: string, userId: string) {
  if (!uuidPattern.test(conversationId)) throw new HttpError(400, "invalid_conversation_id");
  const membership = await db.conversationMember.findFirst({
    where: { conversationId, userId, leftAt: null },
    include: { conversation: { include: { direct: true } } },
  });
  if (!membership) throw new HttpError(403, "conversation_access_denied");

  if (membership.conversation.kind === "direct" && membership.conversation.direct) {
    const direct = membership.conversation.direct;
    const otherUserId = direct.userOneId === userId ? direct.userTwoId : direct.userOneId;
    const blocked = await db.userBlock.findFirst({
      where: { OR: [
        { blockerId: userId, blockedId: otherUserId },
        { blockerId: otherUserId, blockedId: userId },
      ] },
      select: { blockerId: true },
    });
    if (blocked) throw new HttpError(403, "messaging_blocked");
  }
  return membership;
}

async function reactionSummaries(db: PrismaClient, conversationId: string, messageIds: string[], userId: string) {
  if (!messageIds.length) return new Map<string, MessageReactionSummary[]>();
  const [counts, mine] = await Promise.all([
    db.messageReaction.groupBy({
      by: ["messageId", "emoji"],
      where: { conversationId, messageId: { in: messageIds } },
      _count: { _all: true },
    }),
    db.messageReaction.findMany({
      where: { conversationId, messageId: { in: messageIds }, userId },
      select: { messageId: true, emoji: true },
    }),
  ]);
  const mineByMessage = new Map<string, Set<string>>();
  for (const reaction of mine) {
    const emojis = mineByMessage.get(reaction.messageId) ?? new Set<string>();
    emojis.add(reaction.emoji);
    mineByMessage.set(reaction.messageId, emojis);
  }
  const result = new Map<string, MessageReactionSummary[]>();
  for (const count of counts) {
    const summaries = result.get(count.messageId) ?? [];
    summaries.push({ emoji: count.emoji, count: count._count._all,
      reactedByMe: mineByMessage.get(count.messageId)?.has(count.emoji) ?? false });
    result.set(count.messageId, summaries);
  }
  return result;
}

function validateEmoji(emoji: string) {
  if ([...emoji].length > 16 || !/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(emoji) ||
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(emoji)].length !== 1) {
    throw new HttpError(400, "invalid_reaction");
  }
}

export function createMessageService(db: PrismaClient) {
  return {
    async authorize(conversationId: string, userId: string) {
      await assertCanAccess(db, conversationId, userId);
    },

    async send(conversationId: string, senderId: string,
      input: { clientMessageId: string; content: string; replyToMessageId?: string | null; attachmentId?: string }) {
      if (!uuidPattern.test(input.clientMessageId)) throw new HttpError(400, "invalid_client_message_id");
      if (input.attachmentId) {
        if (!uuidPattern.test(input.attachmentId)) throw new HttpError(400, "invalid_attachment_id");
        if ([...input.content].length > maxMessageLength) throw new HttpError(400, "invalid_message_content");
      } else {
        validateContent(input.content);
      }
      await assertCanAccess(db, conversationId, senderId);
      const attachment = input.attachmentId ? await db.attachment.findFirst({
        where: { id: input.attachmentId, conversationId, uploadedBy: senderId },
        select: { id: true, category: true },
      }) : null;
      if (input.attachmentId && !attachment) throw new HttpError(404, "attachment_not_found");
      const replyToMessageId = input.replyToMessageId ?? null;
      if (replyToMessageId !== null) {
        if (!uuidPattern.test(replyToMessageId)) throw new HttpError(400, "invalid_reply_target");
        const reply = await db.message.findFirst({
          where: { id: replyToMessageId, conversationId },
          select: { id: true },
        });
        if (!reply) throw new HttpError(404, "reply_target_not_found");
      }
      const data = { conversationId, senderId, clientMessageId: input.clientMessageId,
        content: input.content, replyToMessageId, type: attachment?.category ?? "text",
        attachmentId: attachment?.id ?? null };
      const include = { replyTo: { select: replySelect }, attachment: { select: {
        id: true, fileName: true, contentType: true, category: true, sizeBytes: true,
      } } };
      try {
        const message = await db.message.create({ data, include });
        return { message: messageView(message), created: true };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
        const message = await db.message.findUnique({
          where: { conversationId_senderId_clientMessageId: {
            conversationId, senderId, clientMessageId: input.clientMessageId,
          } },
          include,
        });
        if (!message) throw error;
        const summaries = await reactionSummaries(db, conversationId, [message.id], senderId);
        return { message: messageView(message, summaries.get(message.id) ?? []), created: false };
      }
    },

    async history(conversationId: string, userId: string, before: string | undefined, rawLimit: string | undefined) {
      await assertCanAccess(db, conversationId, userId);
      let limit = 50;
      if (rawLimit !== undefined) {
        if (!/^\d{1,3}$/.test(rawLimit)) throw new HttpError(400, "invalid_limit");
        limit = Number(rawLimit);
        if (limit < 1 || limit > 100) throw new HttpError(400, "invalid_limit");
      }

      let boundary: { id: string; createdAt: Date } | null = null;
      if (before !== undefined) {
        if (!uuidPattern.test(before)) throw new HttpError(400, "invalid_cursor");
        boundary = await db.message.findFirst({
          where: { id: before, conversationId },
          select: { id: true, createdAt: true },
        });
        if (!boundary) throw new HttpError(400, "invalid_cursor");
      }

      const where: Prisma.MessageWhereInput = { conversationId };
      if (boundary) {
        where.OR = [
          { createdAt: { lt: boundary.createdAt } },
          { createdAt: boundary.createdAt, id: { lt: boundary.id } },
        ];
      }
      const rows = await db.message.findMany({
        where,
        include: { replyTo: { select: replySelect }, attachment: { select: {
          id: true, fileName: true, contentType: true, category: true, sizeBytes: true,
        } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const nextCursor = hasMore && page.length ? page[page.length - 1].id : null;
      page.reverse();
      const summaries = await reactionSummaries(db, conversationId, page.map(message => message.id), userId);
      return { messages: page.map(message => messageView(message, summaries.get(message.id) ?? [])), nextCursor };
    },

    async edit(conversationId: string, userId: string, messageId: string, content: string) {
      await assertCanAccess(db, conversationId, userId);
      if (!uuidPattern.test(messageId)) throw new HttpError(400, "invalid_message_id");
      validateContent(content);
      const current = await db.message.findFirst({
        where: { id: messageId, conversationId }, include: { replyTo: { select: replySelect }, attachment: { select: {
          id: true, fileName: true, contentType: true, category: true, sizeBytes: true,
        } } },
      });
      if (!current) throw new HttpError(404, "message_not_found");
      if (current.senderId !== userId) throw new HttpError(403, "message_edit_forbidden");
      if (current.deletedAt) throw new HttpError(409, "message_deleted");
      const updated = await db.message.updateMany({
        where: { id: messageId, conversationId, senderId: userId, deletedAt: null },
        data: { content, editedAt: new Date() },
      });
      if (updated.count !== 1) throw new HttpError(409, "message_changed");
      const message = await db.message.findUniqueOrThrow({
        where: { id: messageId }, include: { replyTo: { select: replySelect }, attachment: { select: {
          id: true, fileName: true, contentType: true, category: true, sizeBytes: true,
        } } },
      });
      const summaries = await reactionSummaries(db, conversationId, [messageId], userId);
      return messageView(message, summaries.get(messageId) ?? []);
    },

    async remove(conversationId: string, userId: string, messageId: string) {
      await assertCanAccess(db, conversationId, userId);
      if (!uuidPattern.test(messageId)) throw new HttpError(400, "invalid_message_id");
      const current = await db.message.findFirst({
        where: { id: messageId, conversationId }, include: { replyTo: { select: replySelect }, attachment: { select: {
          id: true, fileName: true, contentType: true, category: true, sizeBytes: true,
        } } },
      });
      if (!current) throw new HttpError(404, "message_not_found");
      if (current.senderId !== userId) throw new HttpError(403, "message_delete_forbidden");
      if (current.deletedAt) return { message: messageView(current), changed: false };
      const deletedAt = new Date();
      const message = await db.$transaction(async tx => {
        const deleted = await tx.message.updateMany({
          where: { id: messageId, conversationId, senderId: userId, deletedAt: null },
          data: { content: "", deletedAt },
        });
        if (deleted.count !== 1) throw new HttpError(409, "message_changed");
        await tx.messageReaction.deleteMany({ where: { conversationId, messageId } });
        return tx.message.findUniqueOrThrow({
          where: { id: messageId }, include: { replyTo: { select: replySelect }, attachment: { select: {
            id: true, fileName: true, contentType: true, category: true, sizeBytes: true,
          } } },
        });
      });
      return { message: messageView(message), changed: true };
    },

    async setReaction(conversationId: string, userId: string, messageId: string, emoji: string, active: boolean) {
      await assertCanAccess(db, conversationId, userId);
      if (!uuidPattern.test(messageId)) throw new HttpError(400, "invalid_message_id");
      validateEmoji(emoji);
      const message = await db.message.findFirst({
        where: { id: messageId, conversationId, deletedAt: null },
        select: { id: true },
      });
      if (!message) throw new HttpError(404, "message_not_found");

      const changed = active
        ? (await db.messageReaction.createMany({
          data: { conversationId, messageId, userId, emoji }, skipDuplicates: true,
        })).count === 1
        : (await db.messageReaction.deleteMany({
          where: { conversationId, messageId, userId, emoji },
        })).count === 1;
      const count = await db.messageReaction.count({ where: { conversationId, messageId, emoji } });
      const event: MessageReactionEvent = { conversationId, messageId, userId, emoji, active, count };
      return { ...event, changed };
    },

    async reactions(conversationId: string, userId: string, messageId: string) {
      await assertCanAccess(db, conversationId, userId);
      if (!uuidPattern.test(messageId)) throw new HttpError(400, "invalid_message_id");
      const message = await db.message.findFirst({ where: { id: messageId, conversationId }, select: { id: true } });
      if (!message) throw new HttpError(404, "message_not_found");
      const summaries = await reactionSummaries(db, conversationId, [messageId], userId);
      return summaries.get(messageId) ?? [];
    },

    async markRead(conversationId: string, userId: string, messageId: string) {
      await assertCanAccess(db, conversationId, userId);
      if (!uuidPattern.test(messageId)) throw new HttpError(400, "invalid_message_id");
      const target = await db.message.findFirst({
        where: { id: messageId, conversationId },
        select: { id: true, createdAt: true },
      });
      if (!target) throw new HttpError(404, "message_not_found");

      const advancedRows = await db.$queryRaw<Array<{
        conversationId: string;
        userId: string;
        lastReadMessageId: string;
        readAt: Date;
      }>>`INSERT INTO conversation_read_cursors
        (conversation_id, user_id, last_read_message_id, last_read_message_created_at, read_at)
      VALUES (${conversationId}::uuid, ${userId}::uuid, ${target.id}::uuid, ${target.createdAt}, CURRENT_TIMESTAMP)
      ON CONFLICT (conversation_id, user_id) DO UPDATE
      SET last_read_message_id = EXCLUDED.last_read_message_id,
          last_read_message_created_at = EXCLUDED.last_read_message_created_at,
          read_at = CURRENT_TIMESTAMP
      WHERE (EXCLUDED.last_read_message_created_at, EXCLUDED.last_read_message_id) >
            (conversation_read_cursors.last_read_message_created_at, conversation_read_cursors.last_read_message_id)
      RETURNING conversation_id AS "conversationId", user_id AS "userId",
                last_read_message_id AS "lastReadMessageId", read_at AS "readAt"`;
      const cursor = advancedRows[0] ?? await db.conversationReadCursor.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { conversationId: true, userId: true, lastReadMessageId: true, readAt: true },
      });
      if (!cursor) throw new HttpError(409, "read_cursor_unavailable");
      const event: ConversationReadCursorEvent = {
        conversationId: cursor.conversationId,
        userId: cursor.userId,
        lastReadMessageId: cursor.lastReadMessageId,
        readAt: cursor.readAt.toISOString(),
      };
      return { ...event, advanced: advancedRows.length === 1 };
    },

    async readCursors(conversationId: string, userId: string): Promise<ConversationReadCursorView[]> {
      await assertCanAccess(db, conversationId, userId);
      const members = await db.conversationMember.findMany({
        where: { conversationId, leftAt: null },
        select: {
          userId: true,
          readCursor: { select: { lastReadMessageId: true, readAt: true } },
        },
        orderBy: { joinedAt: "asc" },
      });
      return members.map(member => ({
        userId: member.userId,
        lastReadMessageId: member.readCursor?.lastReadMessageId ?? null,
        readAt: member.readCursor?.readAt.toISOString() ?? null,
      }));
    },
  };
}

export type MessageService = ReturnType<typeof createMessageService>;
