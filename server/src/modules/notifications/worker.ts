import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Logger } from "../../infrastructure/log.ts";
import type { NotificationService, PushResult } from "./service.ts";

const maxAgeMs = 60 * 60_000;
type ClaimedJob = { messageId: string; pushTokenId: string; recipientId: string; attempts: number; createdAt: Date };

export function enqueueMessagePush(tx: Prisma.TransactionClient,
  message: { id: string; conversationId: string; senderId: string }) {
  return tx.$executeRaw`INSERT INTO message_push_jobs (message_id, push_token_id, recipient_id)
    SELECT ${message.id}::uuid, token.id, token.user_id
    FROM push_tokens token JOIN conversation_members member ON member.user_id = token.user_id
    JOIN users recipient ON recipient.id = token.user_id
    WHERE member.conversation_id = ${message.conversationId}::uuid AND member.left_at IS NULL AND NOT member.push_muted
      AND recipient.deleted_at IS NULL AND recipient.push_enabled
      AND token.user_id <> ${message.senderId}::uuid
      AND EXISTS (SELECT 1 FROM user_sessions session WHERE session.device_id = token.device_id
        AND session.revoked_at IS NULL AND session.expires_at > CURRENT_TIMESTAMP)
    ON CONFLICT DO NOTHING`;
}

export function createPushWorker(db: PrismaClient, send: NotificationService["send"], log: Logger) {
  const stop = new AbortController();
  let running: Promise<void> | undefined;

  async function dispatch(job: ClaimedJob, leaseId: string) {
    const where = { messageId: job.messageId, pushTokenId: job.pushTokenId, leaseId };
    const item = await db.messagePushJob.findFirst({ where, select: {
      message: { select: { conversationId: true, senderId: true, deletedAt: true, position: true } },
      pushToken: { select: { token: true, userId: true, updatedAt: true, device: { select: { sessions: {
        where: { revokedAt: null, expiresAt: { gt: new Date() } }, take: 1, select: { id: true },
      } } } } },
    } });
    if (!item) return;
    const { message, pushToken } = item;
    const membership = await db.conversationMember.findFirst({
      where: { conversationId: message.conversationId, userId: job.recipientId, leftAt: null, pushMuted: false,
        user: { deletedAt: null, pushEnabled: true } },
      select: { conversation: { select: { kind: true } }, readCursor: { select: { lastReadMessagePosition: true } } },
    });
    const blocked = membership?.conversation.kind === "direct" && await db.userBlock.findFirst({
      where: { OR: [{ blockerId: job.recipientId, blockedId: message.senderId },
        { blockerId: message.senderId, blockedId: job.recipientId }] },
      select: { blockerId: true },
    });
    if (!membership || blocked || message.deletedAt || pushToken.userId !== job.recipientId || !pushToken.device.sessions.length ||
        (membership.readCursor && membership.readCursor.lastReadMessagePosition >= message.position) ||
        Date.now() - job.createdAt.getTime() >= maxAgeMs) {
      await db.messagePushJob.deleteMany({ where });
      return;
    }
    let result: PushResult;
    try {
      result = await send(pushToken.token, { type: "message", conversationId: message.conversationId,
        messageId: job.messageId }, stop.signal);
    } catch {
      result = { status: "retry", delayMs: 60_000 };
      if (!stop.signal.aborted) log("push.transport_failed");
    }
    if (result.status === "invalid") {
      await db.pushToken.deleteMany({ where: { id: job.pushTokenId, userId: job.recipientId, updatedAt: pushToken.updatedAt } });
    }
    if (result.status === "retry") {
      const backoff = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(4, job.attempts - 1));
      const next = Date.now() + Math.max(result.delayMs, backoff) + Math.floor(Math.random() * 10_000);
      if (next < job.createdAt.getTime() + maxAgeMs) {
        await db.messagePushJob.updateMany({ where, data: { availableAt: new Date(next), leaseId: null } });
        return;
      }
    }
    await db.messagePushJob.deleteMany({ where });
  }

  function sweep() {
    if (running || stop.signal.aborted) return running;
    running = (async () => {
      const leaseId = randomUUID();
      const jobs = await db.$queryRaw<ClaimedJob[]>`WITH ready AS (
          SELECT message_id, push_token_id FROM message_push_jobs WHERE available_at <= CURRENT_TIMESTAMP
          ORDER BY available_at, message_id, push_token_id LIMIT 16 FOR UPDATE SKIP LOCKED
        )
        UPDATE message_push_jobs job
        SET lease_id = ${leaseId}::uuid, available_at = CURRENT_TIMESTAMP + interval '60 seconds', attempts = attempts + 1
        FROM ready WHERE job.message_id = ready.message_id AND job.push_token_id = ready.push_token_id
        RETURNING job.message_id AS "messageId", job.push_token_id AS "pushTokenId",
          job.recipient_id AS "recipientId", job.attempts, job.created_at AS "createdAt"`;
      const outcomes = await Promise.allSettled(jobs.map(job => dispatch(job, leaseId)));
      if (outcomes.some(outcome => outcome.status === "rejected")) log("push.job_failed");
    })().catch(() => log("push.worker_failed")).finally(() => { running = undefined; });
    return running;
  }

  const timer = setInterval(() => void sweep(), 2000);
  timer.unref();
  return { sweep, async close() { clearInterval(timer); stop.abort(); await running; } };
}
