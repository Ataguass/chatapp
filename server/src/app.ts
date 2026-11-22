import express from "express";
import type { ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  ConversationReadCursorEvent,
  HealthResponse,
  GroupMemberEvent,
  GroupMemberRemovedEvent,
  GroupConversationUpdatedEvent,
  MessageDeletedEvent,
  MessageReactionEvent,
  MessageUpdatedEvent,
  PublicMessage,
} from "@messaging/contracts";
import type { Logger } from "./infrastructure/log.ts";
import type { AuthService } from "./modules/auth/router.ts";
import { createAuthRouter } from "./modules/auth/router.ts";
import { HttpError } from "./modules/auth/service.ts";
import { createConversationsRouter } from "./modules/conversations/router.ts";
import type { ConversationService } from "./modules/conversations/service.ts";
import { createUsersRouter } from "./modules/users/router.ts";
import type { UserService } from "./modules/users/service.ts";
import { createMessagesRouter } from "./modules/messages/router.ts";
import type { MessageService } from "./modules/messages/service.ts";
import type { AttachmentService } from "./modules/messages/attachments.ts";
import { createNotificationsRouter } from "./modules/notifications/router.ts";
import type { NotificationService } from "./modules/notifications/service.ts";

type ApiServices = {
  auth: AuthService;
  users: UserService;
  conversations: ConversationService;
  messages: MessageService;
  attachments: AttachmentService;
  notifications: NotificationService;
  publishReadCursor?: (event: ConversationReadCursorEvent) => void;
  publishMessageCreated?: (conversationId: string, message: PublicMessage) => void;
  publishMessageUpdated?: (conversationId: string, event: MessageUpdatedEvent) => void;
  publishMessageDeleted?: (conversationId: string, event: MessageDeletedEvent) => void;
  publishMessageReaction?: (conversationId: string, event: MessageReactionEvent) => void;
  publishGroupMemberAdded?: (event: GroupMemberEvent) => void;
  publishGroupMemberRemoved?: (event: GroupMemberRemovedEvent) => void;
  publishGroupRoleChanged?: (event: GroupMemberEvent) => void;
  publishGroupUpdated?: (event: GroupConversationUpdatedEvent) => void;
};

export function createApp(ready: () => Promise<boolean>, log: Logger, api?: ApiServices) {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    const route = req.path === "/health/live" ? "live" : req.path === "/health/ready" ? "ready" :
      req.path.startsWith("/v1/auth") ? "auth" : req.path.startsWith("/v1/users") ? "users" :
      req.path.startsWith("/v1/push") ? "push" :
      req.path.startsWith("/v1/conversations") ? "conversations" : "unmatched";
    res.set({ "X-Request-Id": requestId, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.on("finish", () => log("http.request", {
      requestId, route, status: res.statusCode, durationMs: Math.round(performance.now() - started),
    }));
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  app.get("/health/live", (_req, res) => {
    res.json({ status: "live" } satisfies HealthResponse);
  });
  app.get("/health/ready", async (_req, res) => {
    const ok = await ready();
    res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "unavailable" } satisfies HealthResponse);
  });
  if (api) {
    app.use("/v1/auth", createAuthRouter(api.auth));
    app.use("/v1/push", createNotificationsRouter(api.auth, api.notifications));
    app.use("/v1/users", createUsersRouter(api.auth, api.users));
    app.use("/v1/conversations", createConversationsRouter(api.auth, api.conversations, {
      memberAdded: api.publishGroupMemberAdded,
      memberRemoved: api.publishGroupMemberRemoved,
      roleChanged: api.publishGroupRoleChanged,
      updated: api.publishGroupUpdated,
    }));
    app.use("/v1/conversations", createMessagesRouter(api.auth, api.messages, api.publishReadCursor, {
      created: api.publishMessageCreated,
      updated: api.publishMessageUpdated,
      deleted: api.publishMessageDeleted,
      reaction: api.publishMessageReaction,
    }, api.attachments));
  }
  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
  const onError: ErrorRequestHandler = (_error, _req, res, next) => {
    if (res.headersSent) return next(_error);
    if (_error instanceof HttpError) {
      res.status(_error.status).json({ error: _error.code });
      return;
    }
    if (_error instanceof SyntaxError && "body" in _error) {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    if (_error && typeof _error === "object" && "type" in _error && _error.type === "entity.too.large") {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }
    res.status(500).json({ error: "internal_error" });
  };
  app.use(onError);
  return app;
}
