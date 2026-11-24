import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import type { Logger } from "./log.ts";
import { createReadiness } from "./readiness.ts";
import type { settings } from "../config/settings.ts";

export function openServices(config: ReturnType<typeof settings>, log: Logger) {
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const redis = new Redis(config.redisUrl, {
    connectTimeout: config.deadline, commandTimeout: config.deadline, enableOfflineQueue: false,
    maxRetriesPerRequest: 1, retryStrategy: attempt => Math.min(250 * attempt, 4000),
  });
  // Report availability transitions through readiness. Raw client errors can contain secrets.
  redis.on("error", () => {});
  const health = createReadiness({
    postgresql: async () => {
      await db.$queryRaw`SELECT messages.position, users.deleted_at, users.push_enabled, conversation_members.push_muted
        FROM users, messages, conversation_members, account_recovery_codes,
        pending_media_deletions, conversation_sync_state, conversation_message_changes,
        stories, story_privacy, story_views, conversation_delivery_cursors, message_push_jobs, direct_calls, message_deletions,
        moderation_reports, media_policies LIMIT 0`;
    },
    redis: async () => { if (await redis.ping() !== "PONG") throw new Error("Redis probe failed"); },
  }, config.deadline, (dependency, ok) => log(ok ? "dependency.ready" : "dependency.unavailable", { dependency }));
  return { ...health, db, redis, async close() { redis.disconnect(); await db.$disconnect(); } };
}
