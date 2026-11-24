import { Router } from "express";
import type { Response } from "express";
import type { DeliveryCursorEvent, MessageDeletedEvent, MessageReactionEvent, MessageUpdatedEvent, PublicMessage } from "@messaging/contracts";
import { HttpError } from "../auth/service.ts";
import { requireAuth } from "../auth/router.ts";
import type { AuthService } from "../auth/router.ts";
import type { AuthContext } from "../auth/service.ts";
import type { ConversationReadCursorEvent } from "@messaging/contracts";
import type { MessageService } from "./service.ts";
import type { AttachmentService } from "./attachments.ts";
import type { PresenceService } from "../users/presence.ts";
import { downloadPrivateFile } from "../../infrastructure/private-download.ts";

type MessagePublishers = {
  created?: (conversationId: string, message: PublicMessage) => void;
  updated?: (conversationId: string, event: MessageUpdatedEvent) => void;
  deleted?: (conversationId: string, event: MessageDeletedEvent) => void;
  reaction?: (conversationId: string, event: MessageReactionEvent) => void;
  delivered?: (event: DeliveryCursorEvent) => void;
  hidden?: (event: { conversationId: string; userId: string; messageIds: string[] }) => void;
};

function context(res: Response) {
  return (res.locals as { auth: AuthContext }).auth;
}

function messageInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["clientMessageId", "content", "replyToMessageId"].includes(key)) ||
      typeof body.clientMessageId !== "string" || typeof body.content !== "string" ||
      (body.replyToMessageId !== undefined && body.replyToMessageId !== null && typeof body.replyToMessageId !== "string")) {
    throw new HttpError(400, "invalid_request");
  }
  return { clientMessageId: body.clientMessageId, content: body.content,
    replyToMessageId: body.replyToMessageId as string | null | undefined };
}

function reactionInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.emoji !== "string") throw new HttpError(400, "invalid_request");
  return body.emoji;
}

export function createMessagesRouter(
  auth: AuthService,
  messages: MessageService,
  publishReadCursor?: (event: ConversationReadCursorEvent) => void,
  publishMessage?: MessagePublishers,
  attachments?: AttachmentService,
  presence?: PresenceService,
) {
  const router = Router();
  const authenticated = requireAuth(auth);

  if (presence) {
    router.get("/:conversationId/presence", authenticated, async (req, res) => {
      const userId = context(res).user.id;
      await messages.authorize(req.params.conversationId, userId);
      res.json(await presence.list(req.params.conversationId, userId));
    });
  }

  if (attachments) {
    router.post("/:conversationId/attachments", authenticated, async (req, res) => {
      const stringHeader = (name: string) => {
        const value = req.headers[name];
        if (Array.isArray(value)) throw new HttpError(400, "invalid_request");
        return value;
      };
      const clientMessageId = stringHeader("x-client-message-id");
      const fileName = stringHeader("x-file-name");
      const contentType = stringHeader("content-type");
      if (!clientMessageId || !fileName || !contentType) throw new HttpError(400, "invalid_request");
      const result = await attachments.send({
        conversationId: req.params.conversationId,
        userId: context(res).user.id,
        clientMessageId,
        fileName,
        contentType,
        contentLength: stringHeader("content-length"),
        contentEncoding: stringHeader("content-encoding"),
        replyToMessageId: stringHeader("x-reply-to-message-id"),
        content: stringHeader("x-message-text"),
        body: req,
      });
      if (result.created) publishMessage?.created?.(req.params.conversationId, result.message);
      res.status(result.created ? 201 : 200).json(result.message);
    });

    router.get("/:conversationId/attachments/:attachmentId", authenticated, async (req, res) => {
      const file = await attachments.open(req.params.conversationId, context(res).user.id, req.params.attachmentId);
      await downloadPrivateFile(req, res, file);
    });

    router.post("/:conversationId/messages/:messageId/forward", authenticated, async (req, res) => {
      const input = req.body;
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 ||
          typeof input.conversationId !== "string" || typeof input.clientMessageId !== "string") {
        throw new HttpError(400, "invalid_request");
      }
      const result = await attachments.forward(req.params.conversationId, context(res).user.id, req.params.messageId,
        input.conversationId, input.clientMessageId);
      if (result.created) publishMessage?.created?.(result.message.conversationId, result.message);
      res.status(result.created ? 201 : 200).json(result.message);
    });
  }

  router.get("/:conversationId/messages", authenticated, async (req, res) => {
    if (req.query.before !== undefined && typeof req.query.before !== "string") {
      throw new HttpError(400, "invalid_cursor");
    }
    if (req.query.limit !== undefined && typeof req.query.limit !== "string") {
      throw new HttpError(400, "invalid_limit");
    }
    const result = await messages.history(req.params.conversationId, context(res).user.id,
      typeof req.query.before === "string" ? req.query.before : undefined,
      typeof req.query.limit === "string" ? req.query.limit : undefined);
    res.json(result);
  });

  router.get("/:conversationId/sync", authenticated, async (req, res) => {
    const { after, limit } = req.query;
    if (after !== undefined && typeof after !== "string") throw new HttpError(400, "invalid_cursor");
    if (limit !== undefined && typeof limit !== "string") throw new HttpError(400, "invalid_limit");
    res.json(await messages.sync(req.params.conversationId, context(res).user.id, after, limit));
  });

  router.get("/:conversationId/settings", authenticated, async (req, res) => {
    res.json(await messages.settings(req.params.conversationId, context(res).user.id));
  });
  router.patch("/:conversationId/settings", authenticated, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
        typeof body.pushMuted !== "boolean") throw new HttpError(400, "invalid_request");
    res.json(await messages.settings(req.params.conversationId, context(res).user.id, body.pushMuted));
  });

  router.post("/:conversationId/messages", authenticated, async (req, res) => {
    const result = await messages.send(req.params.conversationId, context(res).user.id, messageInput(req.body));
    if (result.created) publishMessage?.created?.(req.params.conversationId, result.message);
    res.status(result.created ? 201 : 200).json(result.message);
  });

  router.post("/:conversationId/messages/hide", authenticated, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
        !Array.isArray(body.messageIds) || body.messageIds.some((id: unknown) => typeof id !== "string")) {
      throw new HttpError(400, "invalid_request");
    }
    const userId = context(res).user.id;
    const messageIds = await messages.hide(req.params.conversationId, userId, body.messageIds);
    publishMessage?.hidden?.({ conversationId: req.params.conversationId, userId, messageIds });
    res.json({ messageIds });
  });

  router.put("/:conversationId/messages/:messageId", authenticated, async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 || typeof req.body.content !== "string") {
      throw new HttpError(400, "invalid_request");
    }
    const message = await messages.edit(req.params.conversationId, context(res).user.id,
      req.params.messageId, req.body.content);
    publishMessage?.updated?.(req.params.conversationId, { message });
    res.json(message);
  });

  router.delete("/:conversationId/messages/:messageId", authenticated, async (req, res) => {
    const result = await messages.remove(req.params.conversationId, context(res).user.id, req.params.messageId);
    if (result.changed) {
      publishMessage?.deleted?.(req.params.conversationId, {
        conversationId: req.params.conversationId,
        messageId: result.message.id,
        deletedAt: result.message.deletedAt!,
      });
    }
    res.json(result.message);
  });

  router.get("/:conversationId/messages/:messageId/reactions", authenticated, async (req, res) => {
    res.json(await messages.reactions(req.params.conversationId, context(res).user.id, req.params.messageId));
  });

  router.post("/:conversationId/messages/:messageId/reactions", authenticated, async (req, res) => {
    const result = await messages.setReaction(req.params.conversationId, context(res).user.id,
      req.params.messageId, reactionInput(req.body), true);
    if (result.changed) publishMessage?.reaction?.(req.params.conversationId, result);
    res.json(result);
  });

  router.delete("/:conversationId/messages/:messageId/reactions", authenticated, async (req, res) => {
    const result = await messages.setReaction(req.params.conversationId, context(res).user.id,
      req.params.messageId, reactionInput(req.body), false);
    if (result.changed) publishMessage?.reaction?.(req.params.conversationId, result);
    res.json(result);
  });

  router.get("/:conversationId/read-cursors", authenticated, async (req, res) => {
    res.json(await messages.readCursors(req.params.conversationId, context(res).user.id));
  });

  router.post("/:conversationId/read", authenticated, async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 || typeof req.body.messageId !== "string") {
      throw new HttpError(400, "invalid_request");
    }
    const result = await messages.markRead(req.params.conversationId, context(res).user.id, req.body.messageId);
    if (result.advanced) publishReadCursor?.(result);
    res.json(result);
  });

  router.get("/:conversationId/delivery-cursors", authenticated, async (req, res) => {
    res.json(await messages.deliveryCursors(req.params.conversationId, context(res).user.id));
  });
  router.post("/:conversationId/delivered", authenticated, async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 || typeof req.body.messageId !== "string") {
      throw new HttpError(400, "invalid_request");
    }
    const result = await messages.markDelivered(req.params.conversationId, context(res).user.id, req.body.messageId);
    if (result.advanced) {
      const { advanced: _advanced, ...event } = result;
      publishMessage?.delivered?.(event);
    }
    res.json(result);
  });

  return router;
}
