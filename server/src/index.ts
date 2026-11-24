import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { settings } from "./config/settings.ts";
import { log } from "./infrastructure/log.ts";
import { openServices } from "./infrastructure/services.ts";
import { createAuthService } from "./modules/auth/service.ts";
import { createAccountLifecycle } from "./modules/auth/account-lifecycle.ts";
import { createAuthThrottle } from "./modules/auth/throttle.ts";
import { createConversationService } from "./modules/conversations/service.ts";
import { createMessageService } from "./modules/messages/service.ts";
import { createAttachmentService } from "./modules/messages/attachments.ts";
import { createNotificationService } from "./modules/notifications/service.ts";
import { createPushWorker, enqueueMessagePush } from "./modules/notifications/worker.ts";
import { createUserService } from "./modules/users/service.ts";
import { createDeviceService } from "./modules/users/devices.ts";
import { createPresenceService } from "./modules/users/presence.ts";
import { createRealtimeGateway } from "./realtime/gateway.ts";
import { createMediaCleanup } from "./infrastructure/media-cleanup.ts";
import { createPrivateMedia } from "./infrastructure/private-upload.ts";
import { createStoryService } from "./modules/stories/service.ts";
import { createCallHistory } from "./modules/calls/history.ts";
import { readIceSettings } from "./modules/calls/ice.ts";
import { createAdminService, systemAdminIds } from "./modules/admin/service.ts";

function start() {
  const config = settings(process.env);
  const ice = readIceSettings(process.env);
  const adminIds = systemAdminIds(process.env.SYSTEM_ADMIN_USER_IDS);
  const services = openServices(config, log);
  const auth = createAuthService(services.db);
  const notifications = createNotificationService(services.db, {
    projectId: config.fcmProjectId,
    serviceAccountFile: config.fcmServiceAccountFile,
  }, log);
  const pushWorker = notifications.enabled ? createPushWorker(services.db, notifications.send, log) : undefined;
  const messages = createMessageService(services.db, notifications.enabled ? enqueueMessagePush : undefined);
  const media = createPrivateMedia(config.mediaStoragePath, config.mediaLimits, () => services.db.mediaPolicy.findMany());
  const attachments = createAttachmentService(services.db, messages, media);
  const mediaCleanup = createMediaCleanup(services.db, config.mediaStoragePath, log);
  const callHistory = createCallHistory(services.db, log);
  let realtime: ReturnType<typeof createRealtimeGateway> | undefined;
  const presence = createPresenceService(services.db, userId => realtime?.sockets.adapter.rooms.has(`user:${userId}`) ?? false);
  const app = createApp(services.ready, log, {
    auth,
    authControls: {
      throttle: createAuthThrottle(services.redis),
      account: createAccountLifecycle(services.db),
      revokeSession: sessionId => realtime?.in(`session:${sessionId}`).disconnectSockets(true),
      revokeUserSessions: userId => realtime?.in(`user:${userId}`).disconnectSockets(true),
      accountRemoved: conversationIds => {
        for (const conversationId of conversationIds) realtime?.to(`conversation:${conversationId}`)
          .emit("conversation:invalidated", { conversationId });
        void mediaCleanup.sweep();
      },
    },
    users: createUserService(services.db),
    devices: createDeviceService(services.db),
    presence,
    publishDeviceRevoked: (userId, deviceId) => realtime?.in(`device:${userId}:${deviceId}`).disconnectSockets(true),
    publishBlock: (viewerId, targetId, conversationId) => {
      realtime?.endCallsBetween(viewerId, targetId);
      const room = `conversation:${conversationId}`;
      realtime?.in(room).socketsLeave(room);
      realtime?.to([`user:${viewerId}`, `user:${targetId}`]).emit("conversation:invalidated", { conversationId });
    },
    conversations: createConversationService(services.db, config.maxGroupMembers),
    messages,
    attachments,
    media,
    stories: createStoryService(services.db, media),
    calls: { history: callHistory, ice },
    admin: { service: createAdminService(services.db, messages, config.mediaLimits), ids: adminIds },
    notifications,
    publishConversationCreated: conversation => {
      if (!realtime) return;
      const participantRooms = conversation.participants.map(user => `user:${user.id}`);
      realtime.in(participantRooms).socketsJoin(`conversation:${conversation.id}`);
      realtime.to(participantRooms).emit("conversation:created", conversation);
    },
    publishReadCursor: event => realtime?.to(`conversation:${event.conversationId}`).emit("conversation:read", event),
    publishDeliveryCursor: event => realtime?.to(`conversation:${event.conversationId}`).emit("conversation:delivered", event),
    publishMessagesHidden: ({ userId, ...event }) => realtime?.to(`user:${userId}`).emit("message:hidden", event),
    publishMessageCreated: (conversationId, message) => {
      realtime?.to(`conversation:${conversationId}`).emit("message:new", message);
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
  }, config.trustedProxyIps);
  const server = createServer(app);
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  const gateway = createRealtimeGateway(server, { auth, messages, presence, callHistory }, config.socketAllowedOrigins, log);
  realtime = gateway;
  let stopping = false;
  function stop(reason: string, exitCode = 0) {
    if (stopping) return;
    stopping = true;
    services.drain();
    log("server.stopping", { reason });
    const hardDeadline = setTimeout(() => process.exit(1), 10000);
    gateway.close(async () => {
      try {
        await Promise.all([mediaCleanup.close(), pushWorker?.close(), callHistory.flush()]);
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
