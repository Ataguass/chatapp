import { Prisma, PrismaClient } from "@prisma/client";
import type {
  ConversationReadCursorEvent,
  ConversationReadCursorView,
  DeliveryCursorEvent,
  MessageReactionEvent,
  MessageReactionSummary,
  MessageSyncPage,
  PublicMessage,
} from "@messaging/contracts";
import { HttpError } from "../auth/service.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxMessageLength = 4000;
const replySelect = { id: true, senderId: true, content: true, deletedAt: true } as const;
const messageInclude = { replyTo: { select: replySelect }, attachment: { select: {
  id: true, fileName: true, contentType: true, category: true, sizeBytes: true,
} } } satisfies Prisma.MessageInclude;

function pageLimit(rawLimit: string | undefined) {
  if (rawLimit === undefined) return 50;
  if (!/^\d{1,3}$/.test(rawLimit)) throw new HttpError(400, "invalid_limit");
  const limit = Number(rawLimit);
  if (limit < 1 || limit > 100) throw new HttpError(400, "invalid_limit");
  return limit;
}

function validateContent(content: string) {
  if (!content.trim() || [...content].length > maxMessageLength) {
    throw new HttpError(400, "invalid_message_content");
  }
}

function messageView(message: {
  id: string;
  conversationId: string;
  position: bigint;
  senderId: string;
  clientMessageId: string;
  content: string;
  forwarded: boolean;
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
    position: message.position.toString(),
    senderId: message.senderId,
    clientMessageId: message.clientMessageId,
    content: message.content,
    forwarded: message.forwarded,
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

async function assertCanAccess(db: Prisma.TransactionClient, conversationId: string, userId: string) {
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

async function activeDirectPeer(db: Prisma.TransactionClient, direct: { userOneId: string; userTwoId: string }, userId: string) {
  const peerId = direct.userOneId === userId ? direct.userTwoId : direct.userOneId;
  const peer = await db.user.findUnique({ where: { id: peerId, deletedAt: null }, select: { id: true } });
  if (!peer) throw new HttpError(403, "conversation_closed");
  return peer.id;
}

async function assertCanSend(db: Prisma.TransactionClient, conversationId: string, userId: string) {
  const { conversation } = await assertCanAccess(db, conversationId, userId);
  if (conversation.direct) await activeDirectPeer(db, conversation.direct, userId);
}

async function reactionSummaries(db: Prisma.TransactionClient, conversationId: string, messageIds: string[], userId: string) {
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

async function visibleMessageViews(db: Prisma.TransactionClient, conversationId: string,
  rows: Prisma.MessageGetPayload<{ include: typeof messageInclude }>[], userId: string) {
  const ids = rows.flatMap(row => row.replyToMessageId ? [row.id, row.replyToMessageId] : [row.id]);
  const [summaries, deletions] = await Promise.all([
    reactionSummaries(db, conversationId, rows.map(row => row.id), userId),
    ids.length ? db.messageDeletion.findMany({ where: { conversationId, userId, messageId: { in: ids } },
      select: { messageId: true } }) : [],
  ]);
  const hidden = new Set(deletions.map(row => row.messageId));
  return rows.flatMap(row => hidden.has(row.id) ? [] : [
    messageView(row.replyTo && hidden.has(row.replyTo.id) ? { ...row, replyTo: null } : row, summaries.get(row.id)),
  ]);
}

function validateEmoji(emoji: string) {
  if ([...emoji].length > 16 || !/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(emoji) ||
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(emoji)].length !== 1) {
    throw new HttpError(400, "invalid_reaction");
  }
}

export function createMessageService(db: PrismaClient,
  enqueuePush?: (tx: Prisma.TransactionClient, message: { id: string; conversationId: string; senderId: string }) => Promise<unknown>) {
  type MessageInput = { clientMessageId: string; content: string; replyToMessageId?: string | null; forwarded?: boolean };
  type StoredAttachment = Pick<Prisma.AttachmentUncheckedCreateInput,
    "storageKey" | "fileName" | "contentType" | "category" | "sizeBytes" | "sha256">;
  async function send(conversationId: string, senderId: string, input: MessageInput, file?: StoredAttachment) {
    if (!uuidPattern.test(input.clientMessageId)) throw new HttpError(400, "invalid_client_message_id");
    if (file) {
      if ([...input.content].length > maxMessageLength) throw new HttpError(400, "invalid_message_content");
    } else validateContent(input.content);
    const replyToMessageId = input.replyToMessageId ?? null;
    if (replyToMessageId !== null && !uuidPattern.test(replyToMessageId)) throw new HttpError(400, "invalid_reply_target");
    const where = { conversationId_senderId_clientMessageId: { conversationId, senderId, clientMessageId: input.clientMessageId } };
    try {
      return await db.$transaction(async tx => {
        await assertCanSend(tx, conversationId, senderId);
        const existing = await tx.message.findUnique({ where, include: messageInclude });
        if (existing) {
          const [message] = await visibleMessageViews(tx, conversationId, [existing], senderId);
          if (!message) throw new HttpError(409, "message_hidden");
          return { message, created: false };
        }
        if (replyToMessageId && !await tx.message.findFirst({ where: { id: replyToMessageId, conversationId,
          deletions: { none: { userId: senderId } } },
          select: { id: true } })) throw new HttpError(404, "reply_target_not_found");
        const attachment = file ? await tx.attachment.create({
          data: { ...file, conversationId, uploadedBy: senderId }, select: { id: true },
        }) : null;
        const message = await tx.message.create({ data: {
          conversationId, senderId, clientMessageId: input.clientMessageId, content: input.content, replyToMessageId,
          type: file?.category ?? "text", attachmentId: attachment?.id, forwarded: input.forwarded,
        }, include: messageInclude });
        await enqueuePush?.(tx, message);
        return { message: messageView(message), created: true };
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      await assertCanSend(db, conversationId, senderId);
      const message = await db.message.findUnique({ where, include: messageInclude });
      if (!message) throw error;
      const [visible] = await visibleMessageViews(db, conversationId, [message], senderId);
      if (!visible) throw new HttpError(409, "message_hidden");
      return { message: visible, created: false };
    }
  }

  return {
    send,
    async authorize(conversationId: string, userId: string) {
      await assertCanAccess(db, conversationId, userId);
    },
    async authorizeSend(conversationId: string, userId: string) {
      await assertCanSend(db, conversationId, userId);
    },

    async settings(conversationId: string, userId: string, pushMuted?: boolean) {
      const membership = await assertCanAccess(db, conversationId, userId);
      if (pushMuted === undefined) return { pushMuted: membership.pushMuted };
      const updated = await db.conversationMember.updateMany({
        where: { conversationId, userId, leftAt: null }, data: { pushMuted },
      });
      if (!updated.count) throw new HttpError(403, "conversation_access_denied");
      return { pushMuted };
    },

    async callPeer(conversationId: string, userId: string) {
      const { conversation } = await assertCanAccess(db, conversationId, userId);
      if (conversation.kind !== "direct" || !conversation.direct) throw new HttpError(400, "direct_calls_only");
      return activeDirectPeer(db, conversation.direct, userId);
    },

    async forwardSource(conversationId: string, userId: string, messageId: string) {
      if (!uuidPattern.test(messageId)) throw new HttpError(400, "invalid_message_id");
      return db.$transaction(async tx => {
        await assertCanAccess(tx, conversationId, userId);
        const source = await tx.message.findFirst({
          where: { id: messageId, conversationId, deletedAt: null, deletions: { none: { userId } } },
          select: { content: true, attachmentId: true },
        });
        if (!source) throw new HttpError(404, "message_not_found");
        return source;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },

    async history(conversationId: string, userId: string, before: string | undefined, rawLimit: string | undefined) {
      await assertCanAccess(db, conversationId, userId);
      const limit = pageLimit(rawLimit);

      let boundary: { position: bigint } | null = null;
      if (before !== undefined) {
        if (!uuidPattern.test(before)) throw new HttpError(400, "invalid_cursor");
        boundary = await db.message.findFirst({
          where: { id: before, conversationId },
          select: { position: true },
        });
        if (!boundary) throw new HttpError(400, "invalid_cursor");
      }

      const where: Prisma.MessageWhereInput = { conversationId, deletions: { none: { userId } } };
      if (boundary) where.position = { lt: boundary.position };
      const rows = await db.message.findMany({
        where,
        include: messageInclude,
        orderBy: { position: "desc" },
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const nextCursor = hasMore && page.length ? page[page.length - 1].id : null;
      page.reverse();
      return { messages: await visibleMessageViews(db, conversationId, page, userId), nextCursor };
    },

    async sync(conversationId: string, userId: string, after: string | undefined, rawLimit: string | undefined): Promise<MessageSyncPage> {
      const limit = pageLimit(rawLimit);
      if (after !== undefined && !/^(0|[1-9]\d{0,18})$/.test(after)) throw new HttpError(400, "invalid_cursor");
      const cursor = after === undefined ? null : BigInt(after);
      return db.$transaction(async tx => {
        await assertCanAccess(tx, conversationId, userId);
        const state = await tx.conversationSyncState.findUnique({ where: { conversationId } });
        const latest = state?.revision ?? 0n;
        if (cursor === null) return { cursor: latest.toString(), hasMore: false, messages: [], removedMessageIds: [] };
        if (cursor > latest) throw new HttpError(400, "invalid_cursor");
        const [shared, personal] = await Promise.all([
          tx.conversationMessageChange.findMany({
            where: { conversationId, revision: { gt: cursor } }, orderBy: { revision: "asc" }, take: limit + 1,
          }),
          tx.messageDeletion.findMany({
            where: { conversationId, userId, revision: { gt: cursor } }, orderBy: { revision: "asc" }, take: limit + 1,
          }),
        ]);
        const changes = [...shared, ...personal].sort((one, two) => one.revision < two.revision ? -1 : 1);
        const hasMore = changes.length > limit;
        const page = changes.slice(0, limit);
        const ids = [...new Set(page.map(change => change.messageId))];
        const rows = await tx.message.findMany({ where: { conversationId, id: { in: ids } }, include: messageInclude });
        const byId = new Map((await visibleMessageViews(tx, conversationId, rows, userId)).map(message => [message.id, message]));
        return {
          cursor: (hasMore ? page[page.length - 1].revision : latest).toString(),
          hasMore,
          messages: ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []),
          removedMessageIds: ids.filter(id => !byId.has(id)),
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },

    async hide(conversationId: string, userId: string, messageIds: string[]) {
      if (!messageIds.length || messageIds.length > 100 || messageIds.some(id => !uuidPattern.test(id))) {
        throw new HttpError(400, "invalid_message_ids");
      }
      const ids = [...new Set(messageIds.map(id => id.toLowerCase()))].sort();
      return db.$transaction(async tx => {
        await assertCanAccess(tx, conversationId, userId);
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM messages WHERE conversation_id = ${conversationId}::uuid
          AND id IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR KEY SHARE`;
        if (locked.length !== ids.length) throw new HttpError(404, "message_not_found");
        const existing = await tx.messageDeletion.findMany({ where: { conversationId, userId, messageId: { in: ids } },
          select: { messageId: true } });
        const hidden = new Set(existing.map(row => row.messageId));
        const additions = ids.filter(id => !hidden.has(id));
        if (additions.length) {
          const count = BigInt(additions.length);
          const [state] = await tx.$queryRaw<{ revision: bigint }[]>`INSERT INTO conversation_sync_state (conversation_id, revision)
            VALUES (${conversationId}::uuid, ${count}) ON CONFLICT (conversation_id) DO UPDATE
            SET revision = conversation_sync_state.revision + EXCLUDED.revision RETURNING revision`;
          await tx.messageDeletion.createMany({ data: additions.map((messageId, index) => ({
            conversationId, userId, messageId, revision: state.revision - count + BigInt(index + 1),
          })), skipDuplicates: true });
        }
        return ids;
      });
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
        const attachment = await tx.attachment.findFirst({
          where: { message: { id: messageId, conversationId } }, select: { id: true, storageKey: true },
        });
        const deleted = await tx.message.updateMany({
          where: { id: messageId, conversationId, senderId: userId, deletedAt: null },
          data: { content: "", deletedAt, attachmentId: null },
        });
        if (deleted.count !== 1) throw new HttpError(409, "message_changed");
        await tx.messageReaction.deleteMany({ where: { conversationId, messageId } });
        if (attachment) {
          await tx.attachment.delete({ where: { id: attachment.id } });
          await tx.pendingMediaDeletion.create({ data: { storageKey: attachment.storageKey } });
        }
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
      return db.$transaction(async tx => {
        const message = await tx.$queryRaw<{ id: string }[]>`SELECT message.id FROM messages message
          WHERE message.id = ${messageId}::uuid AND message.conversation_id = ${conversationId}::uuid
            AND message.deleted_at IS NULL AND NOT EXISTS (
              SELECT 1 FROM message_deletions hidden WHERE hidden.message_id = message.id AND hidden.user_id = ${userId}::uuid
            ) FOR UPDATE`;
        if (!message.length) throw new HttpError(404, "message_not_found");
        const changed = active
          ? (await tx.messageReaction.createMany({
            data: { conversationId, messageId, userId, emoji }, skipDuplicates: true,
          })).count === 1
          : (await tx.messageReaction.deleteMany({
            where: { conversationId, messageId, userId, emoji },
          })).count === 1;
        const count = await tx.messageReaction.count({ where: { conversationId, messageId, emoji } });
        const event: MessageReactionEvent = { conversationId, messageId, userId, emoji, active, count };
        return { ...event, changed };
      });
    },

    async reactions(conversationId: string, userId: string, messageId: string) {
      await assertCanAccess(db, conversationId, userId);
      if (!uuidPattern.test(messageId)) throw new HttpError(400, "invalid_message_id");
      const message = await db.message.findFirst({ where: { id: messageId, conversationId, deletions: { none: { userId } } },
        select: { id: true } });
      if (!message) throw new HttpError(404, "message_not_found");
      const summaries = await reactionSummaries(db, conversationId, [messageId], userId);
      return summaries.get(messageId) ?? [];
    },

    async markRead(conversationId: string, userId: string, messageId: string) {
      await assertCanAccess(db, conversationId, userId);
      if (!uuidPattern.test(messageId)) throw new HttpError(400, "invalid_message_id");
      const target = await db.message.findFirst({
        where: { id: messageId, conversationId },
        select: { id: true, createdAt: true, position: true },
      });
      if (!target) throw new HttpError(404, "message_not_found");

      const advancedRows = await db.$queryRaw<Array<{
        conversationId: string;
        userId: string;
        lastReadMessageId: string;
        readAt: Date;
      }>>`INSERT INTO conversation_read_cursors
        (conversation_id, user_id, last_read_message_id, last_read_message_created_at, last_read_message_position, read_at)
      VALUES (${conversationId}::uuid, ${userId}::uuid, ${target.id}::uuid, ${target.createdAt}, ${target.position}, CURRENT_TIMESTAMP)
      ON CONFLICT (conversation_id, user_id) DO UPDATE
      SET last_read_message_id = EXCLUDED.last_read_message_id,
          last_read_message_created_at = EXCLUDED.last_read_message_created_at,
          last_read_message_position = EXCLUDED.last_read_message_position,
          read_at = CURRENT_TIMESTAMP
      WHERE EXCLUDED.last_read_message_position > conversation_read_cursors.last_read_message_position
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

    async markDelivered(conversationId: string, userId: string, messageId: string): Promise<DeliveryCursorEvent & { advanced: boolean }> {
      await assertCanAccess(db, conversationId, userId);
      if (!uuidPattern.test(messageId)) throw new HttpError(400, "invalid_message_id");
      const target = await db.message.findFirst({ where: { id: messageId, conversationId },
        select: { id: true, position: true } });
      if (!target) throw new HttpError(404, "message_not_found");
      const advanced = await db.$queryRaw<{ messageId: string; position: bigint; deliveredAt: Date }[]>
        `INSERT INTO conversation_delivery_cursors (conversation_id, user_id, message_id, position)
          VALUES (${conversationId}::uuid, ${userId}::uuid, ${target.id}::uuid, ${target.position})
          ON CONFLICT (conversation_id, user_id) DO UPDATE
          SET message_id = EXCLUDED.message_id, position = EXCLUDED.position, delivered_at = CURRENT_TIMESTAMP
          WHERE EXCLUDED.position > conversation_delivery_cursors.position
          RETURNING message_id AS "messageId", position, delivered_at AS "deliveredAt"`;
      const cursor = advanced[0] ?? await db.conversationDeliveryCursor.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!cursor) throw new HttpError(409, "delivery_cursor_unavailable");
      return { conversationId, userId, lastDeliveredMessageId: cursor.messageId,
        lastDeliveredPosition: cursor.position.toString(), deliveredAt: cursor.deliveredAt.toISOString(),
        advanced: advanced.length > 0 };
    },

    async deliveryCursors(conversationId: string, userId: string) {
      await assertCanAccess(db, conversationId, userId);
      const members = await db.conversationMember.findMany({ where: { conversationId, leftAt: null },
        select: { userId: true, deliveryCursor: true, readCursor: true } });
      return members.map(member => {
        const { readCursor: read, deliveryCursor: delivery } = member;
        if (read && (!delivery || read.lastReadMessagePosition > delivery.position)) {
          return { userId: member.userId, lastDeliveredMessageId: read.lastReadMessageId,
            lastDeliveredPosition: read.lastReadMessagePosition.toString(), deliveredAt: read.readAt.toISOString() };
        }
        return { userId: member.userId, lastDeliveredMessageId: delivery?.messageId ?? null,
          lastDeliveredPosition: delivery?.position.toString() ?? null, deliveredAt: delivery?.deliveredAt.toISOString() ?? null };
      });
    },
  };
}

export type MessageService = ReturnType<typeof createMessageService>;
