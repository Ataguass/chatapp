"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { CallIceConfiguration, CallInvitation, CallKind, CallSignal } from "@messaging/contracts";
import { api } from "../lib/client-api";

type Phase = "incoming" | "preparing" | "ringing" | "connecting" | "connected";
type CallView = CallInvitation & { phase: Phase; local?: MediaStream; remote?: MediaStream };
type RunningCall = CallView & {
  socket: Socket;
  peer?: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  processing: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

const errors: Record<string, string> = {
  call_busy: "Someone is already on a call.",
  call_peer_offline: "This person is offline.",
  call_rate_limited: "Wait a few seconds before calling again.",
  call_unavailable: "That call is no longer available.",
  unavailable: "This call is no longer available.",
  messaging_blocked: "Calls are unavailable in this chat.",
  declined: "Call declined.",
  no_answer: "No answer.",
  disconnected: "The call ended because a connection was lost.",
  answered_elsewhere: "This call was answered on another device.",
  ended: "Call ended.",
};

async function iceConfiguration(): Promise<RTCConfiguration> {
  const configured = await api<CallIceConfiguration>("calls/ice", { signal: AbortSignal.timeout(5000) });
  if (configured.iceServers.length) return { iceServers: configured.iceServers };
  const urls = process.env.NEXT_PUBLIC_STUN_URL;
  return { iceServers: urls?.startsWith("stun:") || urls?.startsWith("stuns:") ? [{ urls }] : [] };
}

export function useDirectCall(socket: Socket | null, userId: string | undefined, notify: (message: string) => void) {
  const active = useRef<RunningCall | null>(null);
  const [view, setView] = useState<CallView | null>(null);

  const update = useCallback((call: RunningCall) => {
    if (active.current === call) {
      const { callId, conversationId, callerId, kind, phase, local, remote } = call;
      setView({ callId, conversationId, callerId, kind, phase, local, remote });
    }
  }, []);

  const finish = useCallback((call: RunningCall, reason?: string, announce = true) => {
    if (active.current !== call) return;
    active.current = null;
    clearTimeout(call.timer);
    if (announce && call.socket.connected) call.socket.emit("call:end", { callId: call.callId });
    call.peer?.close();
    call.local?.getTracks().forEach(track => track.stop());
    setView(null);
    if (reason) notify(errors[reason] ?? reason);
  }, [notify]);

  function createCall(invitation: CallInvitation, phase: Phase, currentSocket: Socket) {
    const call: RunningCall = { ...invitation, phase, socket: currentSocket, pendingIce: [], processing: Promise.resolve() };
    active.current = call;
    update(call);
    return call;
  }

  const sendSignal = useCallback((call: RunningCall, signal: CallSignal) => {
    if (active.current === call && call.socket.connected) call.socket.emit("call:signal", { callId: call.callId, signal });
  }, []);

  function waitForMedia(call: RunningCall) {
    clearTimeout(call.timer);
    call.timer = setTimeout(() => finish(call, "Couldn't connect the call."), 25_000);
  }

  async function prepare(call: RunningCall) {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("Calls need a browser connection that can access the microphone and camera.");
    }
    const configuration = await iceConfiguration();
    if (active.current !== call) return false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.kind === "video" });
    } catch (error) {
      if (call.kind !== "video" || !(error instanceof DOMException) ||
          !["NotFoundError", "NotReadableError", "OverconstrainedError"].includes(error.name)) throw error;
      if (active.current !== call) return false;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (active.current !== call) { stream.getTracks().forEach(track => track.stop()); return false; }
    call.local = stream;
    const peer = new RTCPeerConnection(configuration);
    call.peer = peer;
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    if (call.kind === "video" && !stream.getVideoTracks().length) peer.addTransceiver("video", { direction: "recvonly" });
    for (const track of stream.getVideoTracks()) track.onended = () => update(call);
    peer.ontrack = event => {
      if (event.streams[0]) call.remote = event.streams[0];
      else {
        call.remote ??= new MediaStream();
        call.remote.addTrack(event.track);
      }
      update(call);
    };
    peer.onicecandidate = event => {
      const candidate = event.candidate?.toJSON();
      if (candidate?.candidate) sendSignal(call, { candidate: { ...candidate, candidate: candidate.candidate } });
    };
    peer.onconnectionstatechange = () => {
      if (active.current !== call) return;
      if (peer.connectionState === "connected") {
        clearTimeout(call.timer);
        call.phase = "connected";
        update(call);
      } else if (peer.connectionState === "failed") finish(call, "Couldn't connect the call.");
      else if (peer.connectionState === "disconnected") {
        call.phase = "connecting";
        update(call);
        waitForMedia(call);
      }
    };
    update(call);
    return true;
  }

  function failure(error: unknown) {
    if (error instanceof DOMException && ["NotAllowedError", "NotFoundError", "NotReadableError"].includes(error.name)) {
      return "Check your microphone and camera access, then try again.";
    }
    return error instanceof Error && (error.message in errors || error.message.startsWith("Calls need"))
      ? error.message : "Couldn't start the call. Try again.";
  }

  async function start(conversationId: string, kind: CallKind) {
    if (!socket?.connected || !userId || active.current) return;
    const invitation = { callId: crypto.randomUUID(), callerId: userId, conversationId, kind };
    const call = createCall(invitation, "preparing", socket);
    try {
      if (!await prepare(call)) return;
      call.phase = "ringing";
      update(call);
      const result = await socket.timeout(6000).emitWithAck("call:start", { callId: call.callId, conversationId, kind });
      if (!result.ok) finish(call, result.error);
    } catch (error) { finish(call, failure(error)); }
  }

  async function accept() {
    const call = active.current;
    if (!call || call.phase !== "incoming") return;
    try {
      call.phase = "preparing";
      update(call);
      if (!await prepare(call)) return;
      call.phase = "connecting";
      update(call);
      waitForMedia(call);
      const result = await call.socket.timeout(6000).emitWithAck("call:accept", { callId: call.callId });
      if (!result.ok) finish(call, result.error);
    } catch (error) { finish(call, failure(error)); }
  }

  useEffect(() => {
    if (!socket) return;
    function onIncoming(invitation: CallInvitation) {
      if (active.current || !socket) return;
      const call: RunningCall = { ...invitation, phase: "incoming", socket, pendingIce: [], processing: Promise.resolve() };
      active.current = call;
      update(call);
    }
    async function onAccepted({ callId }: { callId: string }) {
      const call = active.current;
      if (!call?.peer || call.callId !== callId || call.phase !== "ringing") return;
      try {
        call.phase = "connecting";
        update(call);
        call.timer = setTimeout(() => finish(call, "Couldn't connect the call."), 25_000);
        const offer = await call.peer.createOffer();
        await call.peer.setLocalDescription(offer);
        if (offer.sdp) sendSignal(call, { description: { type: "offer", sdp: offer.sdp } });
      } catch { finish(call, "Couldn't connect the call."); }
    }
    function onSignal({ callId, signal }: { callId: string; signal: CallSignal }) {
      const call = active.current;
      const peer = call?.peer;
      if (!peer || !call || call.callId !== callId) return;
      call.processing = call.processing.then(async () => {
        if (active.current !== call) return;
        if ("candidate" in signal) {
          if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate);
          else if (call.pendingIce.length < 128) call.pendingIce.push(signal.candidate);
          return;
        }
        await peer.setRemoteDescription(signal.description);
        for (const candidate of call.pendingIce.splice(0)) await peer.addIceCandidate(candidate);
        if (signal.description.type === "offer") {
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          if (answer.sdp) sendSignal(call, { description: { type: "answer", sdp: answer.sdp } });
        }
      }).catch(() => finish(call, "Couldn't connect the call."));
    }
    function onEnded({ callId, reason }: { callId: string; reason: string }) {
      const call = active.current;
      if (call?.callId === callId) finish(call, reason, false);
    }
    function onDisconnect() {
      const call = active.current;
      if (call) finish(call, "disconnected", false);
    }
    socket.on("call:incoming", onIncoming);
    socket.on("call:accepted", onAccepted);
    socket.on("call:signal", onSignal);
    socket.on("call:ended", onEnded);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("call:incoming", onIncoming);
      socket.off("call:accepted", onAccepted);
      socket.off("call:signal", onSignal);
      socket.off("call:ended", onEnded);
      socket.off("disconnect", onDisconnect);
      const call = active.current;
      if (call?.socket === socket) finish(call);
    };
  }, [finish, sendSignal, socket, update]);

  return { view, start, accept, end: () => { if (active.current) finish(active.current); } };
}

function CallMedia({ stream, video, local = false }: { stream?: MediaStream; video: boolean; local?: boolean }) {
  const element = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const player = element.current;
    if (!player) return;
    player.srcObject = stream ?? null;
    return () => { player.srcObject = null; };
  }, [stream, video]);
  if (video) return <video ref={node => { element.current = node; }} autoPlay playsInline muted={local} aria-label={local ? "Your camera" : "Other person's camera"} />;
  return local ? null : <audio ref={node => { element.current = node; }} autoPlay controls aria-label="Call audio" />;
}

export function CallPanel({ call, name, onAccept, onEnd }: { call: CallView; name: string; onAccept: () => void; onEnd: () => void }) {
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const video = call.kind === "video";
  const hasCamera = call.local?.getVideoTracks().some(track => track.readyState === "live");
  const status: Record<Phase, string> = { incoming: "Incoming", preparing: "Waiting for device access", ringing: "Ringing", connecting: "Connecting", connected: "Connected" };
  return <section className="call-panel" aria-label={video ? "Video call" : "Voice call"}>
    <div className="call-heading"><strong>{video ? "Video call" : "Voice call"} · {name}</strong><span role="status">{status[call.phase]}</span></div>
    {call.remote && (video ? <div className="call-video"><CallMedia stream={call.remote} video />{hasCamera && <CallMedia stream={call.local} video local />}</div> :
      <CallMedia stream={call.remote} video={false} />)}
    {video && call.local && !hasCamera && <span role="status">Camera unavailable. The call can continue with audio.</span>}
    <div className="dialog-actions">
      {call.phase === "incoming" && <button className="primary-button" type="button" onClick={onAccept}>Accept</button>}
      {call.local && <button className="quiet-button" type="button" aria-pressed={muted} onClick={() => {
        call.local?.getAudioTracks().forEach(track => { track.enabled = muted; }); setMuted(!muted);
      }}>{muted ? "Unmute" : "Mute"}</button>}
      {video && hasCamera && <button className="quiet-button" type="button" aria-pressed={cameraOff} onClick={() => {
        call.local?.getVideoTracks().forEach(track => { track.enabled = cameraOff; }); setCameraOff(!cameraOff);
      }}>{cameraOff ? "Camera on" : "Camera off"}</button>}
      <button className="danger-button" type="button" onClick={onEnd}>{call.phase === "incoming" ? "Decline" : "End call"}</button>
    </div>
  </section>;
}
