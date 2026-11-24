import { Prisma, PrismaClient } from "@prisma/client";
import { HttpError } from "../auth/service.ts";
import type { PublicUser } from "@messaging/contracts";

const usernamePattern = /^[a-z0-9_]{3,32}$/;
const searchPattern = /^[a-z0-9_]{2,32}$/;
const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  createdAt: true,
} as const;

function publicUser(user: {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: Date;
}): PublicUser {
  return { ...user, createdAt: user.createdAt.toISOString() };
}

function normalizedUsername(value: string) {
  const username = value.trim().toLowerCase();
  if (!usernamePattern.test(username)) throw new HttpError(400, "invalid_username");
  return username;
}

export type ProfilePatch = {
  displayName?: string;
  bio?: string | null;
  avatarUrl?: string | null;
};

function validateProfile(patch: ProfilePatch) {
  if (!Object.keys(patch).length) throw new HttpError(400, "empty_profile_update");
  const data: ProfilePatch = {};
  if (patch.displayName !== undefined) {
    const value = patch.displayName.trim();
    if (!value || value.length > 100) throw new HttpError(400, "invalid_display_name");
    data.displayName = value;
  }
  if (patch.bio !== undefined) {
    if (patch.bio !== null && typeof patch.bio !== "string") throw new HttpError(400, "invalid_bio");
    const value = patch.bio?.trim() ?? null;
    if (value !== null && value.length > 500) throw new HttpError(400, "invalid_bio");
    data.bio = value || null;
  }
  if (patch.avatarUrl !== undefined) {
    if (patch.avatarUrl === null) {
      data.avatarUrl = null;
    } else {
      if (patch.avatarUrl.length > 2048) throw new HttpError(400, "invalid_avatar_url");
      let url: URL;
      try { url = new URL(patch.avatarUrl); }
      catch { throw new HttpError(400, "invalid_avatar_url"); }
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new HttpError(400, "invalid_avatar_url");
      }
      data.avatarUrl = url.toString();
    }
  }
  return data;
}

export function createUserService(db: PrismaClient) {
  return {
    async listBlocks(userId: string, after?: string) {
      const rows = await db.userBlock.findMany({
        where: { blockerId: userId, blockedId: after ? { gt: after } : undefined, blocked: { deletedAt: null } },
        orderBy: { blockedId: "asc" }, include: { blocked: { select: publicUserSelect } }, take: 101,
      });
      return { users: rows.slice(0, 100).map(row => publicUser(row.blocked)),
        nextCursor: rows.length > 100 ? rows[99].blockedId : null };
    },

    async getByUsername(viewerId: string, rawUsername: string) {
      const username = normalizedUsername(rawUsername);
      const user = await db.user.findUnique({ where: { username, deletedAt: null }, select: publicUserSelect });
      if (!user) throw new HttpError(404, "user_not_found");
      const blocked = await db.userBlock.findFirst({
        where: { OR: [
          { blockerId: viewerId, blockedId: user.id },
          { blockerId: user.id, blockedId: viewerId },
        ] },
        select: { blockerId: true },
      });
      if (blocked) throw new HttpError(404, "user_not_found");
      return publicUser(user);
    },

    async search(viewerId: string, rawQuery: string) {
      const query = rawQuery.trim().toLowerCase();
      if (!searchPattern.test(query)) throw new HttpError(400, "invalid_search_query");
      const users = await db.user.findMany({
        where: {
          username: { startsWith: query },
          id: { not: viewerId },
          deletedAt: null,
          blocks: { none: { blockedId: viewerId } },
          blockedBy: { none: { blockerId: viewerId } },
        },
        select: publicUserSelect,
        orderBy: { username: "asc" },
        take: 20,
      });
      return users.map(publicUser);
    },

    async updateProfile(userId: string, patch: ProfilePatch) {
      const data = validateProfile(patch);
      const user = await db.user.update({ where: { id: userId, deletedAt: null }, data, select: publicUserSelect });
      return publicUser(user);
    },

    async block(blockerId: string, blockedId: string) {
      if (blockerId === blockedId) throw new HttpError(400, "cannot_block_self");
      const target = await db.user.findUnique({ where: { id: blockedId, deletedAt: null }, select: { id: true } });
      if (!target) throw new HttpError(404, "user_not_found");
      try {
        await db.userBlock.create({ data: { blockerId, blockedId } });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      }
      const [userOneId, userTwoId] = [blockerId, target.id].sort();
      return db.directConversation.findUnique({
        where: { userOneId_userTwoId: { userOneId, userTwoId } }, select: { conversationId: true },
      });
    },

    async unblock(blockerId: string, blockedId: string) {
      if (blockerId === blockedId) throw new HttpError(400, "cannot_unblock_self");
      await db.userBlock.deleteMany({ where: { blockerId, blockedId } });
    },
  };
}

export type UserService = ReturnType<typeof createUserService>;
