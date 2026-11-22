import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { settings } from "./config/settings.ts";
import { log } from "./infrastructure/log.ts";
import { openServices } from "./infrastructure/services.ts";
import { createAuthService } from "./modules/auth/service.ts";
import { createConversationService } from "./modules/conversations/service.ts";
import { createMessageService } from "./modules/messages/service.ts";
import { createAttachmentService } from "./modules/messages/attachments.ts";
import { createNotificationService } from "./modules/notifications/service.ts";
import { createUserService } from "./modules/users/service.ts";
import { createRealtimeGateway } from "./realtime/gateway.ts";

function start() {
  const config = settings(process.env);
  const services = openServices(config, log);
  const auth = createAuthService(services.db);
  const messages = createMessageService(services.db);
  const attachments = createAttachmentService(services.db, messages, config.mediaStoragePath, config.mediaLimits);
  const notifications = createNotificationService(services.db, {
    projectId: config.fcmProjectId,
    serviceAccountFile: config.fcmServiceAccountFile,
  }, log);
  let realtime: ReturnType<typeof createRealtimeGateway> | undefined;
  const app = createApp(services.ready, log, {
    auth,
    users: createUserService(services.db),
    conversations: createConversationService(services.db, config.maxGroupMembers),
    messages,
    attachments,
    notifications,
    publishReadCursor: event => realtime?.to(`conversation:${event.conversationId}`).emit("conversation:read", event),
    publishMessageCreated: (conversationId, message) => {
      realtime?.to(`conversation:${conversationId}`).emit("message:new", message);
      void notifications.notifyNewMessage(conversationId, message.id).catch(() => log("push.dispatch_failed"));
    },
    publishMessageUpdated: (conversationId, event) =>
      realtime?.to(`conversation:${conversationId}`).emit("message:updated", event),
    publishMessageDeleted: (conversationId, event) =>
      realtime?.to(`conversation:${conversationId}`).emit("message:deleted", event),
    publishMessageReaction: (conversationId, event) =>
      realtime?.to(`conversation:${conversationId}`).emit("message:reaction", event),
    publishGroupMemberAdded: event => {
      realtime?.in(`user:${event.userId}`).socketsJoin(`conversation:${event.conversationId}`);
      realtime?.to(`conversation:${event.conversationId}`).emit("group:member_added", event);
    },
    publishGroupMemberRemoved: event => {
      realtime?.in(`user:${event.userId}`).socketsLeave(`conversation:${event.conversationId}`);
      realtime?.to(`conversation:${event.conversationId}`).emit("group:member_removed", event);
      realtime?.to(`user:${event.userId}`).emit("group:member_removed", event);
    },
    publishGroupRoleChanged: event =>
      realtime?.to(`conversation:${event.conversationId}`).emit("group:role_changed", event),
    publishGroupUpdated: event =>
      realtime?.to(`conversation:${event.conversation.id}`).emit("group:updated", event),
  });
  const server = createServer(app);
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  realtime = createRealtimeGateway(server, { auth, messages, notifications }, config.socketAllowedOrigins, log);
  let stopping = false;
  function stop(reason: string, exitCode = 0) {
    if (stopping) return;
    stopping = true;
    services.drain();
    log("server.stopping", { reason });
    const hardDeadline = setTimeout(() => process.exit(1), 10000);
    realtime.close(async () => {
      try {
        await services.close();
        process.exitCode = exitCode;
      } catch {
        process.exitCode = 1;
      } finally {
        clearTimeout(hardDeadline);
      }
    });
  }
  server.on("error", () => stop("http_error", 1));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
  server.listen(config.port, config.host, () => log("server.started", { port: config.port }));
}

try {
  start();
} catch {
  log("server.start_failed");
  process.exitCode = 1;
}
