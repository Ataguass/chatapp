import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "./log.ts";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function createMediaCleanup(db: PrismaClient, storagePath: string, log: Logger) {
  let running: Promise<void> | undefined;
  function sweep() {
    if (running) return running;
    running = (async () => {
      await db.$transaction(async tx => {
        const expired = await tx.$queryRaw<{ id: string; storageKey: string | null }[]>
          `SELECT id, storage_key AS "storageKey" FROM stories WHERE expires_at <= CURRENT_TIMESTAMP
            ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`;
        if (!expired.length) return;
        await tx.story.deleteMany({ where: { id: { in: expired.map(row => row.id) } } });
        const files = expired.flatMap(row => row.storageKey ? [{ storageKey: row.storageKey }] : []);
        if (files.length) await tx.pendingMediaDeletion.createMany({ data: files, skipDuplicates: true });
      });
      const rows = await db.pendingMediaDeletion.findMany({ where: { nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: "asc" }, take: 25 });
      for (const row of rows) {
        if (!uuid.test(row.storageKey)) {
          log("media.cleanup_invalid_key");
          await db.pendingMediaDeletion.deleteMany({ where: { storageKey: row.storageKey } });
          continue;
        }
        try {
          await rm(join(storagePath, row.storageKey), { force: true });
          await db.pendingMediaDeletion.deleteMany({ where: { storageKey: row.storageKey } });
        } catch {
          log("media.cleanup_retry");
          await db.pendingMediaDeletion.updateMany({ where: { storageKey: row.storageKey },
            data: { nextAttemptAt: new Date(Date.now() + 5 * 60_000) } });
        }
      }
    })().catch(() => log("media.cleanup_failed")).finally(() => { running = undefined; });
    return running;
  }
  const timer = setInterval(() => void sweep(), 30_000);
  timer.unref();
  return { sweep, async close() { clearInterval(timer); await running; } };
}
