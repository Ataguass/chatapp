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
      // Readiness also requires the tables from both foundation migrations.
      await db.$queryRaw`SELECT 1 FROM users, messages LIMIT 0`;
    },
    redis: async () => { if (await redis.ping() !== "PONG") throw new Error("Redis probe failed"); },
  }, config.deadline, (dependency, ok) => log(ok ? "dependency.ready" : "dependency.unavailable", { dependency }));
  return { ...health, async close() { redis.disconnect(); await db.$disconnect(); } };
}
