import type { PrismaClient } from "@prisma/client";
import type { ConversationPresence } from "@messaging/contracts";

export function createPresenceService(db: PrismaClient, isOnline: (userId: string) => boolean) {
  return {
    async list(conversationId: string, viewerId: string): Promise<ConversationPresence[]> {
      const rows = await db.conversationMember.findMany({
        where: { conversationId, leftAt: null, user: { deletedAt: null,
          blocks: { none: { blockedId: viewerId } }, blockedBy: { none: { blockerId: viewerId } } } },
        select: { userId: true, user: { select: { devices: { take: 1, orderBy: { lastSeenAt: "desc" },
          select: { lastSeenAt: true } } } } },
      });
      return rows.map(row => ({
        userId: row.userId, online: isOnline(row.userId), lastSeenAt: row.user.devices[0]?.lastSeenAt.toISOString() ?? null,
      }));
    },

    async touch(userId: string, deviceId: string) {
      const now = new Date();
      await db.userDevice.updateMany({ where: { id: deviceId, userId, lastSeenAt: { lt: now } },
        data: { lastSeenAt: now } });
      return now.toISOString();
    },

    async directPeers(userId: string) {
      const activeViewer = { members: { some: { userId, leftAt: null, user: { deletedAt: null } } } };
      return db.user.findMany({
        where: {
          deletedAt: null, blocks: { none: { blockedId: userId } }, blockedBy: { none: { blockerId: userId } },
          OR: [
            { directFirst: { some: { userTwoId: userId, conversation: activeViewer } } },
            { directSecond: { some: { userOneId: userId, conversation: activeViewer } } },
          ],
        },
        select: { id: true },
      });
    },
  };
}

export type PresenceService = ReturnType<typeof createPresenceService>;
