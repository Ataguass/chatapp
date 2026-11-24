import type { Server as HttpServer, IncomingMessage } from "node:http";
import { Server, type Socket } from "socket.io";
import type { PublicMessage } from "@messaging/contracts";
import type { AuthService } from "../modules/auth/router.ts";
import { HttpError } from "../modules/auth/service.ts";
import type { MessageService } from "../modules/messages/service.ts";
import type { Logger } from "../infrastructure/log.ts";
import type { PresenceService } from "../modules/users/presence.ts";
import type { CallHistory } from "../modules/calls/history.ts";
import { createCallSignaling } from "./calls.ts";

type SocketServices = { auth: AuthService; messages: MessageService; presence?: PresenceService; callHistory?: CallHistory };
type Ack<T = unknown> = (result: { ok: true; data: T } | { ok: false; error: string }) => void;
type ClientSocket = Socket & {
  data: { userId?: string; sessionId?: string; deviceId?: string; accessToken?: string; joinedConversations?: Set<string> };
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function allowedOrigin(origin: string | undefined, allowed: readonly string[]) {
  return !origin || allowed.includes(origin);
}

function errorCode(error: unknown) {
  return error instanceof HttpError ? error.code : "internal_error";
}

function leaveConversationOnDenied(socket: ClientSocket, conversationId: string, code: string) {
  if (code !== "conversation_access_denied" && code !== "messaging_blocked") return;
  socket.data.joinedConversations?.delete(conversationId);
  void socket.leave(`conversation:${conversationId}`);
}

function acknowledge<T>(callback: unknown, result: { ok: true; data: T } | { ok: false; error: string }) {
  if (typeof callback === "function") (callback as Ack<T>)(result);
}

function conversationIdFrom(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const conversationId = (payload as Record<string, unknown>).conversationId;
  return typeof conversationId === "string" && uuidPattern.test(conversationId) ? conversationId : null;
}

export function createRealtimeGateway(
  httpServer: HttpServer,
  services: SocketServices,
  allowedOrigins: readonly string[],
  log: Logger,
) {
  const io = new Server(httpServer, {
    maxHttpBufferSize: 24 * 1024,
    cors: allowedOrigins.length ? { origin: [...allowedOrigins], methods: ["GET", "POST"] } : undefined,
    allowRequest: (request: IncomingMessage, callback) => {
      callback(null, allowedOrigin(request.headers.origin, allowedOrigins));
    },
  });

  const calls = createCallSignaling(io, services.messages.callPeer, services.callHistory);

  io.use(async (socket, next) => {
    const supplied = socket.handshake.auth?.token;
    if (typeof supplied !== "string" || !supplied || supplied.length > 128) {
      next(new Error("unauthorized"));
      return;
    }
    try {
      const context = await services.auth.authenticate(supplied);
      socket.data.userId = context.user.id;
      socket.data.sessionId = context.sessionId;
      socket.data.deviceId = context.deviceId;
      socket.data.accessToken = supplied;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", rawSocket => {
    const socket = rawSocket as ClientSocket;
    const userId = socket.data.userId;
    const sessionId = socket.data.sessionId;
    const deviceId = socket.data.deviceId;
    if (!userId || !sessionId || !deviceId) {
      socket.disconnect(true);
      return;
    }
    socket.data.joinedConversations = new Set();
    void socket.join([`user:${userId}`, `session:${sessionId}`, `device:${userId}:${deviceId}`]);
    const publishPresence = async (online: boolean) => {
      const presence = services.presence;
      if (!presence) return;
      try {
        const lastSeenAt = await presence.touch(userId, deviceId);
        const peers = await presence.directPeers(userId);
        if (io.sockets.adapter.rooms.has(`user:${userId}`) !== online || !peers.length) return;
        io.to(peers.map(peer => `user:${peer.id}`)).emit("presence:update", { userId, online, lastSeenAt });
      } catch {
        log("presence.update_failed");
      }
    };
    if (io.sockets.adapter.rooms.get(`user:${userId}`)?.size === 1) void publishPresence(true);
    calls.attach(socket, userId);
    socket.on("session:authenticate", async (token: unknown, callback: unknown) => {
      if (typeof token !== "string" || !token || token.length > 128) return acknowledge(callback, { ok: false, error: "unauthorized" });
      try {
        const context = await services.auth.authenticate(token);
        if (context.sessionId !== sessionId) return acknowledge(callback, { ok: false, error: "unauthorized" });
        socket.data.accessToken = token;
        acknowledge(callback, { ok: true, data: null });
      } catch { acknowledge(callback, { ok: false, error: "unauthorized" }); }
    });
    const sessionCheck = setInterval(() => {
      const accessToken = socket.data.accessToken;
      if (!accessToken) {
        socket.disconnect(true);
        return;
      }
      void services.auth.authenticate(accessToken).catch(() => {
        if (socket.data.accessToken === accessToken) socket.disconnect(true);
      });
    }, 60_000);
    sessionCheck.unref();
    log("socket.connected");

    socket.on("conversation:join", async (payload: unknown, callback?: unknown) => {
      const conversationId = conversationIdFrom(payload);
      if (!conversationId) {
        acknowledge(callback, { ok: false, error: "invalid_conversation_id" });
        return;
      }
      try {
        await services.messages.authorize(conversationId, userId);
        await socket.join(`conversation:${conversationId}`);
        socket.data.joinedConversations?.add(conversationId);
        acknowledge(callback, { ok: true, data: { conversationId } });
      } catch (error) {
        const code = errorCode(error);
        if (code === "conversation_access_denied" || code === "messaging_blocked") {
          socket.data.joinedConversations?.delete(conversationId);
          void socket.leave(`conversation:${conversationId}`);
        }
        acknowledge(callback, { ok: false, error: code });
      }
    });

    socket.on("conversation:leave", (payload: unknown, callback?: unknown) => {
      const conversationId = conversationIdFrom(payload);
      if (!conversationId) {
        acknowledge(callback, { ok: false, error: "invalid_conversation_id" });
        return;
      }
      socket.data.joinedConversations?.delete(conversationId);
      void socket.leave(`conversation:${conversationId}`);
      acknowledge(callback, { ok: true, data: { conversationId } });
    });

    socket.on("message:send", async (payload: unknown, callback?: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        acknowledge(callback, { ok: false, error: "invalid_request" });
        return;
      }
      const input = payload as Record<string, unknown>;
      const conversationId = input.conversationId;
      const clientMessageId = input.clientMessageId;
      const content = input.content;
      const replyToMessageId = input.replyToMessageId;
      if (typeof conversationId !== "string" || !uuidPattern.test(conversationId) ||
          !socket.data.joinedConversations?.has(conversationId)) {
        acknowledge(callback, { ok: false, error: "conversation_access_denied" });
        return;
      }
      if (typeof clientMessageId !== "string" || typeof content !== "string" ||
          (replyToMessageId !== undefined && replyToMessageId !== null && typeof replyToMessageId !== "string")) {
        acknowledge(callback, { ok: false, error: "invalid_request" });
        return;
      }
      try {
        const result = await services.messages.send(conversationId, userId,
          { clientMessageId, content, replyToMessageId: replyToMessageId as string | null | undefined });
        if (result.created) {
          socket.to(`conversation:${conversationId}`).emit("message:new", result.message satisfies PublicMessage);
        }
        const data = { message: result.message, created: result.created };
        socket.emit("message:ack", data);
        acknowledge(callback, { ok: true, data });
      } catch (error) {
        const code = errorCode(error);
        if (code === "conversation_access_denied" || code === "messaging_blocked") {
          socket.data.joinedConversations?.delete(conversationId);
          void socket.leave(`conversation:${conversationId}`);
        }
        acknowledge(callback, { ok: false, error: code });
      }
    });

    socket.on("message:edit", async (payload: unknown, callback?: unknown) => {
      const conversationId = conversationIdFrom(payload);
      const input = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown> : {};
      if (!conversationId || typeof input.messageId !== "string" || typeof input.content !== "string" ||
          !uuidPattern.test(input.messageId) || !socket.data.joinedConversations?.has(conversationId)) {
        acknowledge(callback, { ok: false, error: "invalid_request" });
        return;
      }
      try {
        const message = await services.messages.edit(conversationId, userId, input.messageId, input.content);
        socket.to(`conversation:${conversationId}`).emit("message:updated", { message });
        acknowledge(callback, { ok: true, data: { message } });
      } catch (error) {
        const code = errorCode(error);
        leaveConversationOnDenied(socket, conversationId, code);
        acknowledge(callback, { ok: false, error: code });
      }
    });

    socket.on("message:delete", async (payload: unknown, callback?: unknown) => {
      const conversationId = conversationIdFrom(payload);
      const input = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown> : {};
      if (!conversationId || typeof input.messageId !== "string" || !uuidPattern.test(input.messageId) ||
          !socket.data.joinedConversations?.has(conversationId)) {
        acknowledge(callback, { ok: false, error: "invalid_request" });
        return;
      }
      try {
        const result = await services.messages.remove(conversationId, userId, input.messageId);
        if (result.changed) {
          const event = { conversationId, messageId: result.message.id, deletedAt: result.message.deletedAt! };
          socket.to(`conversation:${conversationId}`).emit("message:deleted", event);
        }
        acknowledge(callback, { ok: true, data: result });
      } catch (error) {
        const code = errorCode(error);
        leaveConversationOnDenied(socket, conversationId, code);
        acknowledge(callback, { ok: false, error: code });
      }
    });

    socket.on("message:reaction", async (payload: unknown, callback?: unknown) => {
      const conversationId = conversationIdFrom(payload);
      const input = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown> : {};
      if (!conversationId || typeof input.messageId !== "string" || !uuidPattern.test(input.messageId) ||
          typeof input.emoji !== "string" || typeof input.active !== "boolean" ||
          !socket.data.joinedConversations?.has(conversationId)) {
        acknowledge(callback, { ok: false, error: "invalid_request" });
        return;
      }
      try {
        const result = await services.messages.setReaction(
          conversationId, userId, input.messageId, input.emoji, input.active,
        );
        if (result.changed) {
          const { changed: _changed, ...event } = result;
          socket.to(`conversation:${conversationId}`).emit("message:reaction", event);
        }
        acknowledge(callback, { ok: true, data: result });
      } catch (error) {
        const code = errorCode(error);
        leaveConversationOnDenied(socket, conversationId, code);
        acknowledge(callback, { ok: false, error: code });
      }
    });

    socket.on("conversation:read", async (payload: unknown, callback?: unknown) => {
      const conversationId = conversationIdFrom(payload);
      const messageId = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).messageId : null;
      if (!conversationId || typeof messageId !== "string" || !uuidPattern.test(messageId)) {
        acknowledge(callback, { ok: false, error: "invalid_request" });
        return;
      }
      if (!socket.data.joinedConversations?.has(conversationId)) {
        acknowledge(callback, { ok: false, error: "conversation_access_denied" });
        return;
      }
      try {
        const result = await services.messages.markRead(conversationId, userId, messageId);
        if (result.advanced) {
          const { advanced: _advanced, ...event } = result;
          socket.to(`conversation:${conversationId}`).emit("conversation:read", event);
        }
        acknowledge(callback, { ok: true, data: result });
      } catch (error) {
        const code = errorCode(error);
        if (code === "conversation_access_denied" || code === "messaging_blocked") {
          socket.data.joinedConversations?.delete(conversationId);
          void socket.leave(`conversation:${conversationId}`);
        }
        acknowledge(callback, { ok: false, error: code });
      }
    });

    const typing = async (event: "typing:start" | "typing:stop", payload: unknown) => {
      const conversationId = conversationIdFrom(payload);
      if (!conversationId || !socket.data.joinedConversations?.has(conversationId)) return;
      try {
        await services.messages.authorize(conversationId, userId);
        socket.to(`conversation:${conversationId}`).emit(event, { conversationId, userId });
      } catch {
        socket.data.joinedConversations?.delete(conversationId);
        void socket.leave(`conversation:${conversationId}`);
      }
    };
    socket.on("typing:start", (payload: unknown) => { void typing("typing:start", payload); });
    socket.on("typing:stop", (payload: unknown) => { void typing("typing:stop", payload); });

    socket.on("disconnect", reason => {
      clearInterval(sessionCheck);
      if (!io.sockets.adapter.rooms.has(`user:${userId}`)) void publishPresence(false);
      for (const conversationId of socket.data.joinedConversations ?? []) {
        socket.to(`conversation:${conversationId}`).emit("typing:stop", { conversationId, userId });
      }
      log("socket.disconnected", { reason });
    });
  });

  return Object.assign(io, { endCallsBetween: calls.endBetween });
}
