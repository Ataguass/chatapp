import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { PrismaClient, Prisma } from "@prisma/client";
import { Redis } from "ioredis";
import { settings } from "../../src/config/settings.ts";

const config = settings(process.env);
const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
after(() => db.$disconnect());

// Fixtures live in rolled-back transactions, including when an assertion fails.
async function fixture(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  const rollback = new Error("fixture rollback");
  try {
    await db.$transaction(async tx => { await work(tx); throw rollback; });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
function user(tx: Prisma.TransactionClient) {
  return tx.user.create({ data: { username: "t_" + randomUUID().replaceAll("-", "").slice(0, 26),
    displayName: "Integration fixture", passwordHash: "unused-fixture-hash" } });
}

test("Redis answers an authenticated PING using the configured connection", async () => {
  const redis = new Redis(config.redisUrl, { lazyConnect: true, connectTimeout: 2000, retryStrategy: () => null });
  redis.on("error", () => {});
  try { await redis.connect(); assert.equal(await redis.ping(), "PONG"); }
  finally { redis.disconnect(); }
});

test("canonical usernames are unique", () => fixture(async tx => {
  const first = await user(tx);
  await assert.rejects(tx.user.create({ data: { username: first.username, displayName: "Second", passwordHash: "fixture" } }),
    { code: "P2002" });
}));

test("the database rejects noncanonical username spelling", () => fixture(async tx => {
  await assert.rejects(tx.$executeRaw`INSERT INTO users (username, display_name, password_hash)
    VALUES ('MixedCase', 'Test', 'fixture')`, (error: unknown) =>
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010" && error.meta?.code === "23514");
}));

test("a session cannot use another account's device", () => fixture(async tx => {
  const owner = await user(tx);
  const other = await user(tx);
  const device = await tx.userDevice.create({ data: { userId: owner.id, platform: "web", deviceName: "Fixture" } });
  const now = Date.now();
  await assert.rejects(tx.userSession.create({ data: { userId: other.id, deviceId: device.id,
    accessTokenHash: "1".repeat(64), accessExpiresAt: new Date(now + 1800000),
    refreshTokenHash: "0".repeat(64), expiresAt: new Date(now + 3600000) } }), { code: "P2003" });
}));

test("a direct pair can have only one conversation", () => fixture(async tx => {
  const users = [(await user(tx)).id, (await user(tx)).id].sort();
  const pair = { userOneId: users[0], userTwoId: users[1] };
  const first = await tx.conversation.create({ data: { kind: "direct" } });
  const second = await tx.conversation.create({ data: { kind: "direct" } });
  await tx.directConversation.create({ data: { ...pair, conversationId: first.id } });
  await assert.rejects(tx.directConversation.create({ data: { ...pair, conversationId: second.id } }), { code: "P2002" });
}));

test("duplicate client message IDs are rejected within a sender and conversation", () => fixture(async tx => {
  const sender = await user(tx);
  const conversation = await tx.conversation.create({ data: { kind: "group", title: "Test" } });
  await tx.conversationMember.create({ data: { conversationId: conversation.id, userId: sender.id, role: "owner" } });
  const data = { conversationId: conversation.id, senderId: sender.id, clientMessageId: randomUUID(), content: "test" };
  const first = await tx.message.create({ data });
  assert.equal((await tx.message.findUniqueOrThrow({ where: { id: first.id } })).content, "test");
  await assert.rejects(tx.message.create({ data }), { code: "P2002" });
}));

test("message positions follow writes even when timestamps go backwards", () => fixture(async tx => {
  const sender = await user(tx);
  const conversation = await tx.conversation.create({ data: { kind: "group", title: "Message order" } });
  await tx.conversationMember.create({ data: { conversationId: conversation.id, userId: sender.id, role: "owner" } });
  const data = { conversationId: conversation.id, senderId: sender.id, content: "Fixture message" };
  const first = await tx.message.create({ data: { ...data, clientMessageId: randomUUID(), createdAt: new Date("2026-01-02") } });
  const second = await tx.message.create({ data: { ...data, clientMessageId: randomUUID(), createdAt: new Date("2026-01-01") } });
  assert.equal(first.position, 1n);
  assert.equal(second.position, 2n);
  const later = await tx.message.findMany({ where: { conversationId: conversation.id, position: { gt: first.position } } });
  assert.deepEqual(later.map(message => message.id), [second.id]);
}));

test("a sender must have a membership in the message's conversation", () => fixture(async tx => {
  const outsider = await user(tx);
  const conversation = await tx.conversation.create({ data: { kind: "group" } });
  await assert.rejects(tx.message.create({ data: { conversationId: conversation.id, senderId: outsider.id,
    clientMessageId: randomUUID(), content: "test" } }), { code: "P2003" });
}));

test("concurrent retries persist exactly one message across database connections", async () => {
  const fixture = await db.$transaction(async tx => {
    const sender = await user(tx);
    const conversation = await tx.conversation.create({ data: { kind: "group" } });
    await tx.conversationMember.create({ data: { conversationId: conversation.id, userId: sender.id } });
    return { conversationId: conversation.id, senderId: sender.id };
  });
  try {
    const data = { ...fixture, clientMessageId: randomUUID(), content: "concurrent retry" };
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => db.message.create({ data })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    for (const result of results) {
      if (result.status === "rejected") assert.equal(result.reason.code, "P2002");
    }
    assert.equal(await db.message.count({ where: fixture }), 1);
  } finally {
    await db.$transaction([
      db.conversation.delete({ where: { id: fixture.conversationId } }),
      db.user.delete({ where: { id: fixture.senderId } }),
    ]);
  }
});
