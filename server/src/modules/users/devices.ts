import type { PrismaClient } from "@prisma/client";
import type { AccountDevice } from "@messaging/contracts";
import { lockActiveAccount } from "../auth/account-lock.ts";
import { HttpError, type AuthContext } from "../auth/service.ts";

const deviceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createDeviceService(db: PrismaClient) {
  return {
    async list(context: AuthContext): Promise<AccountDevice[]> {
      const rows = await db.userDevice.findMany({
        where: { userId: context.user.id, sessions: { some: { revokedAt: null, expiresAt: { gt: new Date() } } } },
        orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
        select: { id: true, platform: true, deviceName: true, lastSeenAt: true },
      });
      return rows.map(row => ({
        ...row,
        platform: row.platform as AccountDevice["platform"],
        lastSeenAt: row.lastSeenAt.toISOString(),
        current: row.id === context.deviceId,
      }));
    },

    async revoke(context: AuthContext, deviceId: string) {
      if (!deviceIdPattern.test(deviceId)) throw new HttpError(400, "invalid_device_id");
      const userId = context.user.id;
      await db.$transaction(async tx => {
        const user = await lockActiveAccount(tx, userId);
        const now = new Date();
        const caller = await tx.userSession.findFirst({
          where: { id: context.sessionId, userId, revokedAt: null,
            accessExpiresAt: { gt: now }, expiresAt: { gt: now } },
          select: { id: true },
        });
        if (!user || !caller) throw new HttpError(401, "unauthorized");
        await tx.userSession.updateMany({ where: { userId, deviceId, revokedAt: null }, data: { revokedAt: now } });
        await tx.pushToken.deleteMany({ where: { userId, deviceId } });
      });
    },
  };
}

export type DeviceService = ReturnType<typeof createDeviceService>;
