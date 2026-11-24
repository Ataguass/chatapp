import express from "express";
import type { ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  ConversationReadCursorEvent,
  ConversationSummary,
  DeliveryCursorEvent,
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
import type { AuthControls, AuthService } from "./modules/auth/router.ts";
import { createAuthRouter, requireAuth } from "./modules/auth/router.ts";
import { HttpError } from "./modules/auth/service.ts";
import { createConversationsRouter } from "./modules/conversations/router.ts";
import type { ConversationService } from "./modules/conversations/service.ts";
import { createUsersRouter } from "./modules/users/router.ts";
import type { UserService } from "./modules/users/service.ts";
import type { DeviceService } from "./modules/users/devices.ts";
import type { PresenceService } from "./modules/users/presence.ts";
import { createStoriesRouter } from "./modules/stories/router.ts";
import type { StoryService } from "./modules/stories/service.ts";
import type { PrivateMedia } from "./infrastructure/private-upload.ts";
import { createCallsRouter } from "./modules/calls/router.ts";
import type { CallHistory } from "./modules/calls/history.ts";
import type { readIceSettings } from "./modules/calls/ice.ts";
import { createAdminRouter, createReportsRouter } from "./modules/admin/router.ts";
import type { AdminService } from "./modules/admin/service.ts";
import { createMessagesRouter } from "./modules/messages/router.ts";
import type { MessageService } from "./modules/messages/service.ts";
import type { AttachmentService } from "./modules/messages/attachments.ts";
import { createNotificationsRouter } from "./modules/notifications/router.ts";
import type { NotificationService } from "./modules/notifications/service.ts";

type ApiServices = {
  auth: AuthService;
  authControls?: AuthControls;
  users: UserService;
  devices?: DeviceService;
  presence?: PresenceService;
  stories?: StoryService;
  media?: PrivateMedia;
  calls?: { history: CallHistory; ice: ReturnType<typeof readIceSettings> };
  admin?: { service: AdminService; ids: ReadonlySet<string> };
  conversations: ConversationService;
  messages: MessageService;
  attachments: AttachmentService;
  notifications: NotificationService;
  publishConversationCreated?: (conversation: ConversationSummary) => void;
  publishReadCursor?: (event: ConversationReadCursorEvent) => void;
  publishDeliveryCursor?: (event: DeliveryCursorEvent) => void;
  publishMessagesHidden?: (event: { conversationId: string; userId: string; messageIds: string[] }) => void;
  publishMessageCreated?: (conversationId: string, message: PublicMessage) => void;
  publishMessageUpdated?: (conversationId: string, event: MessageUpdatedEvent) => void;
  publishMessageDeleted?: (conversationId: string, event: MessageDeletedEvent) => void;
  publishMessageReaction?: (conversationId: string, event: MessageReactionEvent) => void;
  publishGroupMemberAdded?: (event: GroupMemberEvent) => void;
  publishGroupMemberRemoved?: (event: GroupMemberRemovedEvent) => void;
  publishGroupRoleChanged?: (event: GroupMemberEvent) => void;
  publishGroupUpdated?: (event: GroupConversationUpdatedEvent) => void;
  publishDeviceRevoked?: (userId: string, deviceId: string) => void;
  publishBlock?: (viewerId: string, targetId: string, conversationId: string) => void;
};

export function createApp(ready: () => Promise<boolean>, log: Logger, api?: ApiServices, trustedProxyIps: string[] = []) {
  const app = express();
  if (trustedProxyIps.length) app.set("trust proxy", trustedProxyIps);
  app.disable("x-powered-by");
  app.disable("etag");
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    const route = req.path === "/health/live" ? "live" : req.path === "/health/ready" ? "ready" :
      req.path.startsWith("/v1/auth") ? "auth" : req.path.startsWith("/v1/users") ? "users" :
      req.path.startsWith("/v1/push") ? "push" :
      req.path.startsWith("/v1/stories") ? "stories" : req.path.startsWith("/v1/media") ? "media" :
      req.path.startsWith("/v1/calls") ? "calls" :
      req.path.startsWith("/v1/admin") ? "admin" : req.path.startsWith("/v1/reports") ? "reports" :
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
    app.use("/v1/auth", createAuthRouter(api.auth, api.authControls));
    app.use("/v1/push", createNotificationsRouter(api.auth, api.notifications));
    app.use("/v1/users", createUsersRouter(api.auth, api.users, api.devices, api.publishDeviceRevoked, api.publishBlock));
    if (api.stories) app.use("/v1/stories", createStoriesRouter(api.auth, api.stories));
    if (api.calls) app.use("/v1/calls", createCallsRouter(api.auth, api.calls.history, api.calls.ice));
    if (api.admin) {
      app.use("/v1/reports", createReportsRouter(api.auth, api.admin.service));
      if (api.media) app.use("/v1/admin", createAdminRouter(api.auth, api.admin, api.media, ready));
    }
    if (api.media) {
      const media = api.media;
      app.get("/v1/media/policies", requireAuth(api.auth), async (_req, res) => res.json(await media.policies()));
    }
    app.use("/v1/conversations", createConversationsRouter(api.auth, api.conversations, {
      created: api.publishConversationCreated,
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
      delivered: api.publishDeliveryCursor,
      hidden: api.publishMessagesHidden,
    }, api.attachments, api.presence));
  }
  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
  const onError: ErrorRequestHandler = (_error, _req, res, next) => {
    if (res.headersSent) return next(_error);
    if (_error instanceof HttpError) {
      if (_error.status === 413) res.set("Connection", "close");
      res.status(_error.status).json({ error: _error.code });
      return;
    }
    if (_error instanceof SyntaxError && "body" in _error) {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    if (_error && typeof _error === "object" && "type" in _error && _error.type === "entity.too.large") {
      res.set("Connection", "close").status(413).json({ error: "payload_too_large" });
      return;
    }
    log("http.internal_error", { requestId: res.get("X-Request-Id") });
    res.status(500).json({ error: "internal_error" });
  };
  app.use(onError);
  return app;
}
