import type { PrismaClient } from "@prisma/client";
import type { CallKind, DirectCallEndReason, DirectCallRecord } from "@messaging/contracts";
import type { Logger } from "../../infrastructure/log.ts";
import { HttpError } from "../auth/service.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function view(row: Omit<DirectCallRecord, "startedAt" | "acceptedAt" | "endedAt"> &
  { startedAt: Date; acceptedAt: Date | null; endedAt: Date | null }): DirectCallRecord {
  return { ...row, startedAt: row.startedAt.toISOString(), acceptedAt: row.acceptedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null };
}

export function createCallHistory(db: PrismaClient, log: Logger, bootedAt = new Date()) {
  let recovery: Promise<unknown> | undefined;
  const pending = new Set<Promise<void>>();
  function recover() {
    recovery ??= db.directCall.updateMany({
      where: { endedAt: null, startedAt: { lt: bootedAt } },
      data: { endedAt: bootedAt, endReason: "interrupted" },
    }).catch(error => {
      recovery = undefined;
      throw error;
    });
    return recovery;
  }

  return {
    async begin(input: { id: string; conversationId: string; callerId: string; recipientId: string; kind: CallKind }, online: boolean) {
      await recover();
      const result = await db.directCall.createMany({ data: {
        ...input, startedAt: new Date(),
        ...(online ? {} : { endedAt: new Date(), endReason: "offline" }),
      }, skipDuplicates: true });
      if (!result.count) throw new HttpError(409, "call_id_used");
    },

    async accept(id: string) {
      const result = await db.directCall.updateMany({
        where: { id, acceptedAt: null, endedAt: null }, data: { acceptedAt: new Date() },
      });
      if (!result.count) throw new HttpError(409, "call_unavailable");
    },

    end(id: string, reason: DirectCallEndReason) {
      const work = db.directCall.updateMany({
        where: { id, endedAt: null }, data: { endedAt: new Date(), endReason: reason },
      }).then(() => {}).catch(() => log("call.history_write_failed"));
      pending.add(work);
      void work.finally(() => pending.delete(work));
    },

    async list(userId: string, cursor?: string) {
      let boundary: { OR: [{ startedAt: { lt: Date } }, { startedAt: Date; id: { lt: string } }] } | undefined;
      if (cursor !== undefined) {
        const match = /^(\d{13})_([\da-f-]{36})$/i.exec(cursor);
        if (!match || !uuid.test(match[2])) throw new HttpError(400, "invalid_cursor");
        const startedAt = new Date(Number(match[1]));
        boundary = { OR: [{ startedAt: { lt: startedAt } }, { startedAt, id: { lt: match[2] } }] };
      }
      await recover();
      const rows = await db.directCall.findMany({ where: {
        OR: [{ callerId: userId }, { recipientId: userId }], ...(boundary ? { AND: [boundary] } : {}),
      }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 51 });
      const page = rows.slice(0, 50);
      const last = page.at(-1);
      return { calls: page.map(view), nextCursor: rows.length > 50 && last ? `${last.startedAt.getTime()}_${last.id}` : null };
    },

    async get(id: string, userId: string) {
      if (!uuid.test(id)) throw new HttpError(400, "invalid_call_id");
      await recover();
      const row = await db.directCall.findFirst({ where: { id, OR: [{ callerId: userId }, { recipientId: userId }] } });
      if (!row) throw new HttpError(404, "call_not_found");
      return view(row);
    },

    async flush() { await Promise.all(pending); },
  };
}

export type CallHistory = ReturnType<typeof createCallHistory>;
