import type { Server, Socket } from "socket.io";
import type { CallInvitation, CallSignal, DirectCallEndReason } from "@messaging/contracts";
import { HttpError } from "../modules/auth/service.ts";
import type { CallHistory } from "../modules/calls/history.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ActiveCall = CallInvitation & {
  callerSocket: string;
  recipientId: string;
  recipientSocket?: string;
  accepting?: boolean;
  ringTimer: ReturnType<typeof setTimeout>;
};

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function signalFrom(value: unknown): CallSignal | null {
  const signal = fields(value);
  if (Object.keys(signal).length !== 1) return null;
  if (signal.description) {
    const { type, sdp } = fields(signal.description);
    if ((type === "offer" || type === "answer") && typeof sdp === "string" && sdp.length <= 20_000) {
      return { description: { type, sdp } };
    }
    return null;
  }
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = fields(signal.candidate);
  if (typeof candidate !== "string" || candidate.length > 4096 ||
      (sdpMid != null && (typeof sdpMid !== "string" || sdpMid.length > 128)) ||
      (sdpMLineIndex != null && (typeof sdpMLineIndex !== "number" || !Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0)) ||
      (usernameFragment != null && (typeof usernameFragment !== "string" || usernameFragment.length > 256))) return null;
  return { candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } };
}

function ack(callback: unknown, error?: string) {
  if (typeof callback === "function") callback(error ? { ok: false, error } : { ok: true });
}

export function createCallSignaling(io: Server, callPeer: (conversationId: string, userId: string) => Promise<string>,
  history?: CallHistory) {
  const activeCalls = new Map<string, ActiveCall>();
  const callsByUser = new Map<string, ActiveCall>();
  const startingUsers = new Set<string>();

  function end(call: ActiveCall, reason: DirectCallEndReason) {
    if (activeCalls.get(call.callId) !== call) return;
    activeCalls.delete(call.callId);
    callsByUser.delete(call.callerId);
    callsByUser.delete(call.recipientId);
    clearTimeout(call.ringTimer);
    history?.end(call.callId, reason);
    io.to([call.callerSocket, call.recipientSocket ?? `user:${call.recipientId}`])
      .emit("call:ended", { callId: call.callId, reason });
  }

  function attach(socket: Socket, userId: string) {
    let lastStart = 0;
    socket.on("call:start", async (payload: unknown, callback: unknown) => {
      const { callId, conversationId, kind } = fields(payload);
      if (typeof callId !== "string" || !uuid.test(callId) || typeof conversationId !== "string" ||
          !uuid.test(conversationId) || (kind !== "voice" && kind !== "video")) return ack(callback, "invalid_call");
      if (Date.now() - lastStart < 3000) return ack(callback, "call_rate_limited");
      lastStart = Date.now();
      try {
        const recipientId = await callPeer(conversationId, userId);
        const recipientRoom = `user:${recipientId}`;
        const peers = await io.in(recipientRoom).fetchSockets();
        if (!socket.connected) return;
        if (callsByUser.has(userId) || callsByUser.has(recipientId) || activeCalls.has(callId) ||
            startingUsers.has(userId) || startingUsers.has(recipientId)) return ack(callback, "call_busy");
        startingUsers.add(userId);
        startingUsers.add(recipientId);
        try {
          await history?.begin({ id: callId, conversationId, callerId: userId, recipientId, kind }, peers.length > 0);
          if (history && peers.length) {
            try { await callPeer(conversationId, userId); }
            catch (error) { history.end(callId, "unavailable"); throw error; }
          }
        } finally {
          startingUsers.delete(userId);
          startingUsers.delete(recipientId);
        }
        if (!peers.length) return ack(callback, "call_peer_offline");
        if (!socket.connected) { history?.end(callId, "disconnected"); return; }
        const invitation: CallInvitation = { callId, conversationId, callerId: userId, kind };
        const ringTimer = setTimeout(() => {
          const call = activeCalls.get(callId);
          if (call && !call.recipientSocket) end(call, "no_answer");
        }, 45_000);
        ringTimer.unref();
        const call = { ...invitation, callerSocket: socket.id, recipientId, ringTimer };
        activeCalls.set(callId, call);
        callsByUser.set(userId, call);
        callsByUser.set(recipientId, call);
        io.to(recipientRoom).emit("call:incoming", invitation);
        ack(callback);
      } catch (error) { ack(callback, error instanceof HttpError ? error.code : "call_failed"); }
    });

    socket.on("call:accept", async (payload: unknown, callback: unknown) => {
      const call = callsByUser.get(userId);
      if (!call || call.callId !== fields(payload).callId || call.recipientId !== userId || call.recipientSocket || call.accepting) {
        return ack(callback, "call_unavailable");
      }
      call.accepting = true;
      try {
        await callPeer(call.conversationId, userId);
        if (!socket.connected || activeCalls.get(call.callId) !== call) return ack(callback, "call_unavailable");
        await history?.accept(call.callId);
      } catch {
        end(call, "unavailable");
        return ack(callback, "call_unavailable");
      } finally {
        call.accepting = false;
      }
      if (activeCalls.get(call.callId) !== call) return ack(callback, "call_unavailable");
      if (!socket.connected) { end(call, "disconnected"); return; }
      call.recipientSocket = socket.id;
      clearTimeout(call.ringTimer);
      io.to(call.callerSocket).emit("call:accepted", { callId: call.callId });
      socket.to(`user:${userId}`).emit("call:ended", { callId: call.callId, reason: "answered_elsewhere" });
      ack(callback);
    });

    socket.on("call:signal", (payload: unknown) => {
      const { callId, signal } = fields(payload);
      const call = callsByUser.get(userId);
      if (!call || call.callId !== callId || !call.recipientSocket) return;
      const caller = socket.id === call.callerSocket;
      if (!caller && socket.id !== call.recipientSocket) return;
      const data = signalFrom(signal);
      if (!data || ("description" in data && data.description.type !== (caller ? "offer" : "answer"))) return;
      io.to(caller ? call.recipientSocket : call.callerSocket).emit("call:signal", { callId, signal: data });
    });

    socket.on("call:end", (payload: unknown) => {
      const call = callsByUser.get(userId);
      if (!call || call.callId !== fields(payload).callId) return;
      if (socket.id === call.callerSocket || socket.id === call.recipientSocket) end(call, "ended");
      else if (call.recipientId === userId && !call.recipientSocket) end(call, "declined");
    });

    socket.on("disconnect", () => {
      const call = callsByUser.get(userId);
      if (call && (call.callerSocket === socket.id || call.recipientSocket === socket.id)) end(call, "disconnected");
    });
  }

  return {
    attach,
    endBetween(one: string, two: string) {
      const call = callsByUser.get(one);
      if (call && callsByUser.get(two) === call) end(call, "unavailable");
    },
  };
}
