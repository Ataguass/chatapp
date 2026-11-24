import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../../src/app.ts";
import { settings } from "../../src/config/settings.ts";
import { createMediaCleanup } from "../../src/infrastructure/media-cleanup.ts";
import { createPrivateMedia } from "../../src/infrastructure/private-upload.ts";
import { createAdminService } from "../../src/modules/admin/service.ts";
import { createAccountLifecycle } from "../../src/modules/auth/account-lifecycle.ts";
import { createAuthService } from "../../src/modules/auth/service.ts";
import { createCallHistory } from "../../src/modules/calls/history.ts";
import { createConversationService } from "../../src/modules/conversations/service.ts";
import { createAttachmentService } from "../../src/modules/messages/attachments.ts";
import { createMessageService } from "../../src/modules/messages/service.ts";
import { createNotificationService } from "../../src/modules/notifications/service.ts";
import { createPushWorker, enqueueMessagePush } from "../../src/modules/notifications/worker.ts";
import { createStoryService } from "../../src/modules/stories/service.ts";
import { createDeviceService } from "../../src/modules/users/devices.ts";
import { createPresenceService } from "../../src/modules/users/presence.ts";
import { createUserService } from "../../src/modules/users/service.ts";
import { createRealtimeGateway } from "../../src/realtime/gateway.ts";

const config = settings(process.env);
const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
const storage = await mkdtemp(join(tmpdir(), "chatapp-backend-"));
const limits = { image: 1024, video: 1024, audio: 1024, document: 1024 };
const media = createPrivateMedia(storage, limits, () => db.mediaPolicy.findMany());
const auth = createAuthService(db);
const messages = createMessageService(db, enqueueMessagePush);
const conversations = createConversationService(db);
const callHistory = createCallHistory(db, () => {});
const iceSecret = "a-disposable-test-turn-credential-secret";
const presence = createPresenceService(db, userId => realtime.sockets.adapter.rooms.has(`user:${userId}`));
const adminIds = new Set<string>();
const app = createApp(async () => true, () => {}, {
  auth, conversations, messages, media, attachments: createAttachmentService(db, messages, media),
  users: createUserService(db), devices: createDeviceService(db), stories: createStoryService(db, media),
  notifications: createNotificationService(db, {}, () => {}),
  calls: { history: callHistory, ice: { stunUrls: ["stun:example.test"], turnUrls: ["turn:example.test"], secret: iceSecret } },
  admin: { ids: adminIds, service: createAdminService(db, messages, limits) },
  authControls: {
    account: createAccountLifecycle(db), throttle: async () => 0, revokeUserSessions: () => {},
    revokeSession: () => {}, accountRemoved: () => {},
  },
  presence,
  publishBlock: (one, two) => realtime.endCallsBetween(one, two),
});
const server = createServer(app);
const realtime = createRealtimeGateway(server, { auth, messages, callHistory, presence }, [], () => {});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const http = `http://127.0.0.1:${address.port}/v1`;
const actors: string[] = [];
const password = "unique integration passphrase";

after(async () => {
  await new Promise<void>(resolve => { void realtime.close(() => resolve()); });
  await callHistory.flush();
  const chats = await db.conversation.findMany({ where: { members: { some: { userId: { in: actors } } } }, select: { id: true } });
  const ids = chats.map(chat => chat.id);
  await db.message.deleteMany({ where: { conversationId: { in: ids } } });
  await db.conversation.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: actors } } });
  await db.$disconnect();
  await rm(storage, { recursive: true, force: true });
});

async function actor() {
  const username = "it_" + randomUUID().replaceAll("-", "").slice(0, 20);
  const session = await auth.register({ username, password, displayName: username, platform: "web", deviceName: "Integration" });
  actors.push(session.user.id);
  return { id: session.user.id, username, token: session.accessToken };
}

function request(path: string, token: string, init: RequestInit = {}) {
  return fetch(http + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
}

function json(method: string, value: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

async function payload(response: Response, status: number) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

test("device revocation invalidates the target session, refresh token and push registration", async () => {
  const owner = await actor();
  const outsider = await actor();
  const other = await auth.login({ username: owner.username, password, deviceName: "Other phone", platform: "android" });
  const rotated = await auth.refresh(other.refreshToken);
  const device = await auth.authenticate(rotated.accessToken);
  const devices = await payload(await request("/users/me/devices", owner.token), 200);
  assert.equal(devices.length, 2);
  assert.ok(devices.some((entry: { id: string; current: boolean }) => entry.id === device.deviceId && !entry.current));
  assert.equal((await request("/push/tokens/current", rotated.accessToken, json("PUT", { token: randomUUID() }))).status, 204);
  assert.equal((await request(`/users/me/devices/${device.deviceId}`, outsider.token, { method: "DELETE" })).status, 204);
  assert.equal((await request("/auth/me", rotated.accessToken)).status, 200);
  assert.equal((await request(`/users/me/devices/${device.deviceId}`, owner.token, { method: "DELETE" })).status, 204);
  assert.equal((await request("/auth/me", rotated.accessToken)).status, 401);
  await assert.rejects(auth.refresh(rotated.refreshToken), { code: "invalid_refresh_token" });
  assert.equal(await db.pushToken.count({ where: { deviceId: device.deviceId } }), 0);
  assert.equal((await payload(await request("/users/me/devices", owner.token), 200)).length, 1);
});

test("password change requires current credentials and revokes prior sessions and recovery codes", async () => {
  const account = await actor();
  const another = await auth.login({ username: account.username, deviceName: "Another device", platform: "web", password });
  const nextPassword = "another unique integration passphrase";
  const change = (currentPassword: string) => request("/auth/password", account.token,
    json("POST", { currentPassword, newPassword: nextPassword }));
  const recover = await payload(await request("/auth/recovery-codes", account.token, json("POST", { password })), 200);
  assert.ok(recover.codes.length);
  assert.equal((await change("incorrect integration password")).status, 401);
  assert.equal((await change(password)).status, 204);
  assert.equal((await request("/auth/me", account.token)).status, 401);
  await assert.rejects(auth.refresh(another.refreshToken), { code: "invalid_refresh_token" });
  assert.equal(await db.accountRecoveryCode.count({ where: { userId: account.id } }), 0);
  const login = { username: account.username, platform: "web" as const, deviceName: "New sign in" };
  await assert.rejects(auth.login({ ...login, password }), { code: "invalid_credentials" });
  const fresh = await auth.login({ ...login, password: nextPassword });
  assert.equal((await request("/auth/me", fresh.accessToken)).status, 200);
});

test("sync paginates committed messages and returns later edits, reactions and hard deletion tombstones", async () => {
  const owner = await actor(), member = await actor(), outsider = await actor();
  const { id } = await conversations.createGroup(owner.id, "Sync fixture", [member.id]);
  await conversations.openDirect(owner.id, { userId: outsider.id });
  const firstPage = await payload(await request("/conversations/page?limit=1", owner.token), 200);
  const secondPage = await payload(await request(`/conversations/page?limit=1&cursor=${firstPage.nextCursor}`, owner.token), 200);
  assert.equal(new Set([...firstPage.conversations, ...secondPage.conversations].map(item => item.id)).size, 2);
  const path = `/conversations/${id}`;
  const start = await payload(await request(`${path}/sync`, member.token), 200);
  const first = (await messages.send(id, owner.id, { content: "First", clientMessageId: randomUUID() })).message;
  const last = (await messages.send(id, owner.id, { content: "Second", clientMessageId: randomUUID() })).message;
  const one = await payload(await request(`${path}/sync?after=${start.cursor}&limit=1`, member.token), 200);
  assert.deepEqual(one.messages.map(item => item.id), [first.id]);
  assert.equal(one.hasMore, true);
  const two = await payload(await request(`${path}/sync?after=${one.cursor}&limit=1`, member.token), 200);
  assert.deepEqual(two.messages.map(item => item.id), [last.id]);
  assert.equal(two.hasMore, false);
  await messages.edit(id, owner.id, first.id, "Edited while offline");
  await messages.setReaction(id, member.id, first.id, "👍", true);
  await db.message.delete({ where: { id: last.id } });
  const changes = await payload(await request(`${path}/sync?after=${two.cursor}`, member.token), 200);
  assert.equal(changes.messages[0].content, "Edited while offline");
  assert.deepEqual(changes.messages[0].reactions, [{ emoji: "👍", count: 1, reactedByMe: true }]);
  assert.deepEqual(changes.removedMessageIds, [last.id]);
  assert.equal((await request(`${path}/sync?after=0`, outsider.token)).status, 403);
  await conversations.removeMember(id, owner.id, member.id);
  assert.equal((await request(`${path}/sync?after=0`, member.token)).status, 403);
});

test("private invite preview and redemption enforce use limits, roles and membership revocation", async () => {
  const owner = await actor(), member = await actor(), invited = await actor(), outsider = await actor();
  const { id } = await conversations.createGroup(owner.id, "Private group", [member.id]);
  const path = `/conversations/${id}`;
  assert.equal((await request(`${path}/invites`, member.token, json("POST", { maxUses: 1 }))).status, 403);
  const invite = await payload(await request(`${path}/invites`, owner.token, json("POST", { maxUses: 1 })), 201);
  const body = json("POST", { token: invite.token });
  const preview = await payload(await request("/conversations/invites/preview", invited.token, body), 200);
  assert.equal(preview.title, "Private group");
  assert.equal(preview.canJoin, true);
  assert.equal((await payload(await request("/conversations/invites/redeem", invited.token, body), 200)).joined, true);
  assert.equal((await payload(await request("/conversations/invites/redeem", invited.token, body), 200)).joined, false);
  assert.equal((await request("/conversations/invites/redeem", outsider.token, body)).status, 410);
  assert.equal((await request(`${path}/messages`, invited.token)).status, 200);
  assert.equal((await payload(await request(`${path}/members/${invited.id}`, owner.token, { method: "DELETE" }), 200)).removed, true);
  assert.equal((await request(`${path}/messages`, invited.token)).status, 403);
});

test("delivery and read positions stay monotonic across devices", async () => {
  const alice = await actor(), bob = await actor();
  const { conversation: { id } } = await conversations.openDirect(alice.id, { userId: bob.id });
  const older = (await messages.send(id, alice.id, { content: "One", clientMessageId: randomUUID() })).message;
  const newest = (await messages.send(id, alice.id, { content: "Two", clientMessageId: randomUUID() })).message;
  const mark = (messageId: string) => request(`/conversations/${id}/delivered`, bob.token, json("POST", { messageId }));
  assert.equal((await payload(await mark(newest.id), 200)).advanced, true);
  const late = await payload(await mark(older.id), 200);
  assert.equal(late.advanced, false);
  assert.equal(late.lastDeliveredMessageId, newest.id);
  const newer = (await messages.send(id, alice.id, { content: "Three", clientMessageId: randomUUID() })).message;
  await messages.markRead(id, bob.id, newer.id);
  assert.equal((await messages.deliveryCursors(id, alice.id)).find(row => row.userId === bob.id)?.lastDeliveredMessageId, newer.id);
});

test("personal deletion syncs across devices and keeps the other member's history", async () => {
  const first = await actor(), second = await actor();
  const { conversation: { id } } = await conversations.openDirect(first.id, { userId: second.id });
  const base = `/conversations/${id}`;
  const original = (await messages.send(id, first.id, { content: "Original", clientMessageId: randomUUID() })).message;
  const reply = (await messages.send(id, second.id, {
    content: "Reply", clientMessageId: randomUUID(), replyToMessageId: original.id,
  })).message;
  const start = await payload(await request(`${base}/sync`, second.token), 200);
  const hide = json("POST", { messageIds: [original.id, original.id] });
  assert.deepEqual((await payload(await request(`${base}/messages/hide`, second.token, hide), 200)).messageIds, [original.id]);
  await payload(await request(`${base}/messages/hide`, second.token, hide), 200);
  const page = await payload(await request(`${base}/messages`, second.token), 200);
  assert.deepEqual(page.messages.map(item => item.id), [reply.id]);
  assert.equal(page.messages[0].replyTo, null);
  assert.equal((await payload(await request(`${base}/messages`, first.token), 200)).messages.length, 2);
  assert.deepEqual((await payload(await request(`${base}/sync?after=${start.cursor}`, second.token), 200)).removedMessageIds, [original.id]);
  assert.deepEqual((await payload(await request(`${base}/sync?after=${start.cursor}`, first.token), 200)).removedMessageIds, []);
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64");
function upload(id: string, bytes = png): RequestInit {
  return { method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": "caf%C3%A9.png",
    "X-Client-Message-Id": id }, body: new Uint8Array(bytes) };
}

test("private media enforces membership, signatures, ranges, and cleans up after forwarding or redaction", async () => {
  const alice = await actor(), bob = await actor(), third = await actor();
  const source = (await conversations.openDirect(alice.id, { userId: bob.id })).conversation.id;
  const destination = (await conversations.openDirect(bob.id, { userId: third.id })).conversation.id;
  const uploadPath = `/conversations/${source}/attachments`;
  assert.equal((await request(uploadPath, alice.token, upload(randomUUID(), Buffer.alloc(1500)))).status, 413);
  assert.equal((await request(uploadPath, alice.token, upload(randomUUID(), Buffer.from("broken")))).status, 415);
  const idempotency = randomUUID();
  const original = await payload(await request(uploadPath, alice.token, upload(idempotency)), 201);
  assert.equal((await payload(await request(uploadPath, alice.token, upload(idempotency)), 200)).id, original.id);
  const privatePath = original.attachment.downloadPath.slice(3);
  assert.equal((await request(privatePath, third.token)).status, 403);
  const part = await request(privatePath, bob.token, { headers: { Range: "bytes=1-8" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 1-8/${png.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), png.subarray(1, 9));
  assert.equal((await request(privatePath, bob.token, { headers: { Range: "bytes=9999-" } })).status, 416);
  const forwardPath = `/conversations/${source}/messages/${original.id}/forward`;
  const forwardBody = json("POST", { conversationId: destination, clientMessageId: randomUUID() });
  assert.equal((await request(forwardPath, third.token, forwardBody)).status, 403);
  const copy = await payload(await request(forwardPath, bob.token, forwardBody), 201);
  assert.equal(copy.forwarded, true);
  assert.notEqual(copy.attachment.id, original.attachment.id);
  assert.equal((await payload(await request(forwardPath, bob.token, forwardBody), 200)).id, copy.id);
  await messages.remove(source, alice.id, original.id);
  assert.equal((await request(privatePath, bob.token)).status, 404);
  const response = await request(copy.attachment.downloadPath.slice(3), third.token);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  const cleanup = createMediaCleanup(db, storage, () => {});
  try { await cleanup.sweep(); }
  finally { await cleanup.close(); }
  assert.equal((await readdir(storage)).length, 1);
});

test("story audience changes, blocks and server-side expiry also govern downloads and views", async () => {
  const author = await actor(), viewer = await actor(), outsider = await actor();
  const inviteOnly = await payload(await request("/stories/media", author.token, upload(randomUUID())), 201);
  assert.equal((await request(`/stories/${inviteOnly.id}`, viewer.token)).status, 404);
  const direct = (await conversations.openDirect(author.id, { userId: viewer.id })).conversation;
  await messages.send(direct.id, author.id, { content: "Hello", clientMessageId: randomUUID() });
  assert.equal((await request(`/stories/${inviteOnly.id}`, viewer.token)).status, 404);
  await messages.send(direct.id, viewer.id, { content: "Hello back", clientMessageId: randomUUID() });
  assert.equal((await request(`/stories/${inviteOnly.id}`, viewer.token)).status, 200);
  await payload(await request("/stories/privacy", author.token, json("PATCH", { visibility: "selected", userIds: [outsider.id] })), 200);
  const download = inviteOnly.media.downloadPath.slice(3);
  assert.equal((await request(download, viewer.token)).status, 404);
  assert.equal((await request(download, outsider.token, { method: "HEAD" })).status, 200);
  const mark = `/stories/${inviteOnly.id}/views`;
  assert.equal((await request(mark, viewer.token, { method: "POST" })).status, 404);
  assert.equal((await request(mark, outsider.token, { method: "POST" })).status, 204);
  assert.equal((await request(mark, outsider.token, { method: "POST" })).status, 204);
  const { viewers } = await payload(await request(`/stories/${inviteOnly.id}/viewers`, author.token), 200);
  assert.deepEqual(viewers.map(entry => entry.user.id), [outsider.id]);
  await request(`/users/${outsider.id}/block`, author.token, { method: "POST" });
  assert.equal((await request(download, outsider.token)).status, 404);
  await db.story.update({ where: { id: inviteOnly.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await request(download, author.token)).status, 404);
  const cleanup = createMediaCleanup(db, storage, () => {});
  try { await cleanup.sweep(); }
  finally { await cleanup.close(); }
  assert.equal(await db.story.count({ where: { id: inviteOnly.id } }), 0);
  assert.equal(await db.storyView.count({ where: { storyId: inviteOnly.id } }), 0);
});

test("account deletion removes personal records and preserves the other member's messages", async () => {
  const owner = await actor(), peer = await actor();
  const id = (await conversations.openDirect(owner.id, { userId: peer.id })).conversation.id;
  const chat = `/conversations/${id}`;
  const attachment = await payload(await request(`${chat}/attachments`, owner.token, upload(randomUUID())), 201);
  const kept = (await messages.send(id, peer.id, { content: "Peer keeps this", clientMessageId: randomUUID() })).message;
  const story = await payload(await request("/stories/media", owner.token, upload(randomUUID())), 201);
  const callId = randomUUID();
  await callHistory.begin({ id: callId, conversationId: id, callerId: owner.id, recipientId: peer.id, kind: "voice" }, false);
  const start = await payload(await request(`${chat}/sync`, peer.token), 200);
  assert.equal((await request("/auth/account", owner.token, json("DELETE", { username: owner.username, password }))).status, 204);
  assert.equal((await request("/auth/me", owner.token)).status, 401);
  assert.equal(await db.story.count({ where: { id: story.id } }), 0);
  assert.equal((await request(`/calls/${callId}`, peer.token)).status, 404);
  assert.deepEqual((await payload(await request(`${chat}/messages`, peer.token), 200)).messages.map(item => item.id), [kept.id]);
  assert.deepEqual((await payload(await request(`${chat}/sync?after=${start.cursor}`, peer.token), 200)).removedMessageIds,
    [attachment.id]);
  const cleanup = createMediaCleanup(db, storage, () => {});
  try { await cleanup.sweep(); }
  finally { await cleanup.close(); }
});

test("the push worker persists retry state and skips delivery after a block", async () => {
  const sender = await actor(), receiver = await actor();
  await payload(await request("/media/policies", receiver.token), 200);
  assert.equal((await request("/push/tokens/current", receiver.token, json("PUT", { token: randomUUID() }))).status, 204);
  const { conversation: { id } } = await conversations.openDirect(sender.id, { userId: receiver.id });
  const input = { content: "private body", clientMessageId: randomUUID() };
  const message = (await messages.send(id, sender.id, input)).message;
  assert.equal((await messages.send(id, sender.id, input)).created, false);
  assert.equal(await db.messagePushJob.count({ where: { messageId: message.id } }), 1);
  let calls = 0;
  const worker = createPushWorker(db, async (_token, data) => {
    calls++;
    assert.deepEqual(data, { type: "message", conversationId: id, messageId: message.id });
    return { status: "retry", delayMs: 120_000 };
  }, () => {});
  try {
    await worker.sweep();
    const job = await db.messagePushJob.findFirstOrThrow({ where: { messageId: message.id } });
    assert.ok(job.availableAt.getTime() > Date.now() + 100_000);
    assert.equal(job.attempts, 1);
    await request(`/users/${sender.id}/block`, receiver.token, { method: "POST" });
    await db.messagePushJob.updateMany({ where: { messageId: message.id }, data: { availableAt: new Date(0) } });
    await worker.sweep();
    assert.equal(calls, 1);
    assert.equal(await db.messagePushJob.count({ where: { messageId: message.id } }), 0);
  } finally { await worker.close(); }
});

test("account notification preferences and conversation mute are applied to durable push", async () => {
  const sender = await actor(), receiver = await actor();
  assert.equal((await request("/push/tokens/current", receiver.token, json("PUT", { token: randomUUID() }))).status, 204);
  const { conversation: { id } } = await conversations.openDirect(sender.id, { userId: receiver.id });
  await payload(await request("/push/preferences", receiver.token, json("PATCH", { pushEnabled: false })), 200);
  const first = (await messages.send(id, sender.id, { content: "Global mute", clientMessageId: randomUUID() })).message;
  assert.equal(await db.messagePushJob.count({ where: { messageId: first.id } }), 0);
  await payload(await request("/push/preferences", receiver.token, json("PATCH", { pushEnabled: true })), 200);
  const chatSettings = `/conversations/${id}/settings`;
  await payload(await request(chatSettings, receiver.token, json("PATCH", { pushMuted: true })), 200);
  const second = (await messages.send(id, sender.id, { content: "Chat mute", clientMessageId: randomUUID() })).message;
  assert.equal(await db.messagePushJob.count({ where: { messageId: second.id } }), 0);
  await payload(await request(chatSettings, receiver.token, json("PATCH", { pushMuted: false })), 200);
  const third = (await messages.send(id, sender.id, { content: "Push enabled", clientMessageId: randomUUID() })).message;
  assert.equal(await db.messagePushJob.count({ where: { messageId: third.id } }), 1);
  await messages.markRead(id, receiver.id, third.id);
  let dispatched = 0;
  const worker = createPushWorker(db, async () => { dispatched++; return { status: "sent" }; }, () => {});
  try { await worker.sweep(); }
  finally { await worker.close(); }
  assert.equal(dispatched, 0);
  assert.equal(await db.messagePushJob.count({ where: { messageId: third.id } }), 0);
});

test("report access and upload policy edits require the right authorization", async t => {
  const sender = await actor(), member = await actor(), admin = await actor();
  const { id } = await conversations.createGroup(sender.id, "Report fixture", [member.id]);
  const item = (await messages.send(id, sender.id, { content: "Reported item", clientMessageId: randomUUID() })).message;
  const report = json("POST", { conversationId: id, messageId: item.id, category: "spam" });
  assert.equal((await request("/reports", sender.token, report)).status, 400);
  assert.equal((await request("/reports", admin.token, report)).status, 403);
  const submitted = await payload(await request("/reports", member.token, report), 202);
  assert.equal((await payload(await request("/reports", member.token, report), 202)).id, submitted.id);
  assert.equal((await request("/admin/reports", sender.token)).status, 403);
  adminIds.add(admin.id);
  t.after(async () => {
    adminIds.delete(admin.id);
    await db.mediaPolicy.deleteMany({ where: { updatedById: admin.id } });
  });
  const queue = await payload(await request("/admin/reports", admin.token), 200);
  assert.equal(queue.reports.find(item => item.id === submitted.id).status, "pending");
  const resolved = await payload(await request(`/admin/reports/${submitted.id}`, admin.token, json("PATCH", { status: "resolved" })), 200);
  assert.equal(resolved.reviewedById, admin.id);
  const policy = "/admin/media-policies/image";
  const disable = json("PATCH", { enabled: false, maxBytes: 1024, contentTypes: ["image/png"] });
  assert.equal((await request(policy, sender.token, disable)).status, 403);
  await payload(await request(policy, admin.token, disable), 200);
  assert.equal((await request(`/conversations/${id}/attachments`, sender.token, upload(randomUUID()))).status, 415);
  const published = await payload(await request("/media/policies", member.token), 200);
  assert.equal(published.find(item => item.category === "image").enabled, false);
  const larger = json("PATCH", { enabled: true, maxBytes: 1025, contentTypes: ["image/png"] });
  assert.equal((await request(policy, admin.token, larger)).status, 400);
});

async function connect(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=websocket`);
  const inbox: string[] = [];
  const updates = new EventTarget();
  ws.addEventListener("message", event => {
    const frame = String(event.data);
    if (frame.startsWith("0")) ws.send("40" + JSON.stringify({ token }));
    else if (frame === "2") ws.send("3");
    else {
      inbox.push(frame);
      updates.dispatchEvent(new Event("packet"));
    }
  });
  function take(match: (packet: string) => boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        updates.removeEventListener("packet", check);
        reject(new Error("Timed out waiting for a Socket.IO frame"));
      }, 2000);
      function check() {
        const index = inbox.findIndex(match);
        if (index < 0) return;
        clearTimeout(timeout);
        updates.removeEventListener("packet", check);
        resolve(inbox.splice(index, 1)[0]);
      }
      updates.addEventListener("packet", check);
      check();
    });
  }
  const connected = await take(frame => frame.startsWith("40") || frame.startsWith("44"));
  assert.ok(connected.startsWith("40"));
  let sequence = 0;
  return {
    close: () => ws.close(),
    emit: (event: string, body: unknown) => ws.send("42" + JSON.stringify([event, body])),
    async ack(event: string, body: unknown) {
      const id = String(++sequence);
      ws.send("42" + id + JSON.stringify([event, body]));
      const prefix = "43" + id + "[";
      const frame = await take(packet => packet.startsWith(prefix));
      return JSON.parse(frame.slice(2 + id.length))[0];
    },
    async event(name: string) {
      const prefix = "42[" + JSON.stringify(name) + ",";
      return JSON.parse((await take(frame => frame.startsWith(prefix))).slice(2))[1];
    },
  };
}

test("authenticated direct call events persist call history and blocking ends the selected call", async t => {
  const caller = await actor(), recipient = await actor(), outsider = await actor();
  const { conversation: { id } } = await conversations.openDirect(caller.id, { userId: recipient.id });
  const callerSocket = await connect(caller.token);
  t.after(callerSocket.close);
  const recipientSocket = await connect(recipient.token);
  t.after(recipientSocket.close);
  const callId = randomUUID();
  assert.equal((await callerSocket.ack("call:start", { callId, conversationId: id, kind: "video" })).ok, true);
  assert.equal((await recipientSocket.event("call:incoming")).callId, callId);
  assert.equal((await recipientSocket.ack("call:accept", { callId })).ok, true);
  assert.equal((await callerSocket.event("call:accepted")).callId, callId);
  callerSocket.emit("call:signal", { callId, signal: { description: { type: "offer", sdp: "test-offer" } } });
  assert.equal((await recipientSocket.event("call:signal")).signal.description.sdp, "test-offer");
  const accepted = await payload(await request(`/calls/${callId}`, recipient.token), 200);
  assert.equal(accepted.kind, "video");
  assert.ok(accepted.acceptedAt);
  assert.equal((await request(`/calls/${callId}`, outsider.token)).status, 404);
  const online = await payload(await request(`/conversations/${id}/presence`, caller.token), 200);
  assert.equal(online.find(item => item.userId === recipient.id).online, true);
  assert.equal((await request(`/users/${caller.id}/block`, recipient.token, { method: "POST" })).status, 204);
  assert.equal((await callerSocket.event("call:ended")).reason, "unavailable");
  await callHistory.flush();
  assert.equal((await payload(await request("/calls/history", caller.token), 200)).calls[0].endReason, "unavailable");
  const ice = await payload(await request("/calls/ice", recipient.token), 200);
  const turn = ice.iceServers[1];
  assert.ok(turn.username.endsWith(":" + recipient.id));
  assert.equal(turn.credential, createHmac("sha1", iceSecret).update(turn.username).digest("base64"));
  assert.ok(Date.parse(ice.expiresAt) > Date.now());
  assert.equal((await request("/calls/ice", "invalid")).status, 401);
});
