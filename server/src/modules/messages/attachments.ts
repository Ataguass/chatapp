import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import type { PrivateMedia, UploadBody } from "../../infrastructure/private-upload.ts";
import type { MessageService } from "./service.ts";
import { HttpError } from "../auth/service.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createAttachmentService(db: PrismaClient, messages: MessageService, media: PrivateMedia) {
  async function send(input: UploadBody & {
    conversationId: string;
    userId: string;
    clientMessageId: string;
    replyToMessageId?: string | null;
    content?: string;
    forwarded?: boolean;
  }) {
    if (!uuidPattern.test(input.clientMessageId)) throw new HttpError(400, "invalid_client_message_id");
    if (input.replyToMessageId != null && !uuidPattern.test(input.replyToMessageId)) {
      throw new HttpError(400, "invalid_reply_target");
    }
    if (input.content !== undefined && [...input.content].length > 4000) {
      throw new HttpError(400, "invalid_message_content");
    }
    await messages.authorizeSend(input.conversationId, input.userId);
    const file = await media.store(input);
    try {
      const sent = await messages.send(input.conversationId, input.userId, {
        clientMessageId: input.clientMessageId,
        content: input.content ?? "",
        replyToMessageId: input.replyToMessageId,
        forwarded: input.forwarded,
      }, file);
      if (!sent.created) await media.discard(file.storageKey);
      return sent;
    } catch (error) {
      // A lost transaction response can leave committed metadata. Preserve its file.
      const retained = await db.attachment.findUnique({ where: { storageKey: file.storageKey }, select: { id: true } })
        .catch(() => undefined);
      if (retained === null) await media.discard(file.storageKey);
      throw error;
    }
  }

  async function open(conversationId: string, userId: string, attachmentId: string) {
    await messages.authorize(conversationId, userId);
    if (!uuidPattern.test(attachmentId)) throw new HttpError(400, "invalid_attachment_id");
    const attachment = await db.attachment.findFirst({
      where: { id: attachmentId, conversationId, message: { is: { deletedAt: null, deletions: { none: { userId } } } } },
    });
    if (!attachment) throw new HttpError(404, "attachment_not_found");
    return media.describe(attachment);
  }

  return {
    send,
    open,
    async forward(sourceConversationId: string, userId: string, messageId: string, conversationId: string, clientMessageId: string) {
      const source = await messages.forwardSource(sourceConversationId, userId, messageId);
      if (!source.attachmentId) {
        return messages.send(conversationId, userId, { clientMessageId, content: source.content, forwarded: true });
      }
      const file = await open(sourceConversationId, userId, source.attachmentId);
      const stream = Readable.from((async function* () { yield* createReadStream(file.path); })());
      try {
        return await send({
          conversationId, userId, clientMessageId, content: source.content, forwarded: true,
          fileName: encodeURIComponent(file.fileName), contentType: file.contentType,
          contentLength: String(file.sizeBytes), body: stream,
        });
      } finally {
        stream.destroy();
      }
    },
  };
}

export type AttachmentService = ReturnType<typeof createAttachmentService>;
