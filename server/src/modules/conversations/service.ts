import { createHash, randomBytes } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type { ConversationPage, ConversationSummary, PublicUser } from "@messaging/contracts";
import { HttpError } from "../auth/service.ts";

const defaultMaxGroupMembers = 100;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const userSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  createdAt: true,
} as const;
const conversationInclude = {
  members: {
    where: { leftAt: null },
    include: { user: { select: userSelect } },
    orderBy: { joinedAt: "asc" as const },
  },
};

function validateConversationId(conversationId: string) {
  if (!uuidPattern.test(conversationId)) throw new HttpError(400, "invalid_conversation_id");
}

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

function conversationView(conversation: {
  id: string;
  kind: "direct" | "group";
  title: string | null;
  createdAt: Date;
  members: Array<{ user: Parameters<typeof publicUser>[0] }>;
}): ConversationSummary {
  return {
    id: conversation.id,
    type: conversation.kind,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    participants: conversation.members.map(member => publicUser(member.user)),
  };
}

function inviteDigest(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function serializable<T>(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(error => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new HttpError(409, "group_changed_retry");
    }
    throw error;
  });
}

async function requireGroupMember(db: PrismaClient, conversationId: string, userId: string) {
  validateConversationId(conversationId);
  const member = await db.conversationMember.findFirst({
    where: { conversationId, userId, leftAt: null },
    include: { conversation: { select: { kind: true } } },
  });
  if (!member) throw new HttpError(403, "conversation_access_denied");
  if (member.conversation.kind !== "group") throw new HttpError(400, "not_a_group");
  return member;
}

async function requireGroupAdmin(db: PrismaClient, conversationId: string, userId: string, ownerOnly = false) {
  const member = await requireGroupMember(db, conversationId, userId);
  if (member.role !== "owner" && (ownerOnly || member.role !== "admin")) {
    throw new HttpError(403, "group_admin_required");
  }
  return member;
}

async function requireGroupAdminTx(
  tx: Prisma.TransactionClient,
  conversationId: string,
  userId: string,
  ownerOnly = false,
) {
  validateConversationId(conversationId);
  const member = await tx.conversationMember.findFirst({
    where: { conversationId, userId, leftAt: null },
    include: { conversation: { select: { kind: true } } },
  });
  if (!member) throw new HttpError(403, "conversation_access_denied");
  if (member.conversation.kind !== "group") throw new HttpError(400, "not_a_group");
  if (member.role !== "owner" && (ownerOnly || member.role !== "admin")) {
    throw new HttpError(403, "group_admin_required");
  }
  return member;
}

function groupTitle(value: string) {
  const title = value.trim();
  if (!title || [...title].length > 120) throw new HttpError(400, "invalid_group_title");
  return title;
}

function memberIds(value: string[], maximum: number, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > maximum ||
      value.some(id => typeof id !== "string" || !uuidPattern.test(id))) {
    throw new HttpError(400, "invalid_group_members");
  }
  return [...new Set(value)];
}

export type DirectTarget = { username?: string; userId?: string };

export function createConversationService(db: PrismaClient, maxGroupMembers = defaultMaxGroupMembers) {
  if (!Number.isInteger(maxGroupMembers) || maxGroupMembers < 2 || maxGroupMembers > 500) {
    throw new Error("Invalid MAX_GROUP_MEMBERS");
  }
  return {
    async list(userId: string) {
      const memberships = await db.conversationMember.findMany({
        where: { userId, leftAt: null },
        include: { conversation: { include: conversationInclude } },
        orderBy: [{ joinedAt: "desc" }, { conversationId: "desc" }],
        take: 50,
      });
      return memberships.map(({ conversation }) => conversationView(conversation));
    },

    async page(userId: string, rawCursor: string | undefined, rawLimit: string | undefined): Promise<ConversationPage> {
      const limit = Number(rawLimit ?? 50);
      if ((rawLimit !== undefined && !/^\d{1,3}$/.test(rawLimit)) || limit < 1 || limit > 100) {
        throw new HttpError(400, "invalid_limit");
      }
      const where: Prisma.ConversationMemberWhereInput = { userId, leftAt: null };
      if (rawCursor !== undefined) {
        const match = /^(\d{13})_([\da-f-]{36})$/i.exec(rawCursor);
        if (!match || !uuidPattern.test(match[2])) throw new HttpError(400, "invalid_cursor");
        const joinedAt = new Date(Number(match[1]));
        where.OR = [{ joinedAt: { lt: joinedAt } }, { joinedAt, conversationId: { lt: match[2] } }];
      }
      const memberships = await db.conversationMember.findMany({
        where,
        include: { conversation: { include: conversationInclude } },
        orderBy: [{ joinedAt: "desc" }, { conversationId: "desc" }],
        take: limit + 1,
      });
      const page = memberships.slice(0, limit);
      const last = page.at(-1);
      return {
        conversations: page.map(({ conversation }) => conversationView(conversation)),
        nextCursor: memberships.length > limit && last
          ? `${String(last.joinedAt.getTime()).padStart(13, "0")}_${last.conversationId}`
          : null,
      };
    },

    async openDirect(userId: string, target: DirectTarget) {
      const other = target.userId
        ? await db.user.findUnique({ where: { id: target.userId, deletedAt: null }, select: { id: true } })
        : target.username
          ? await db.user.findUnique({ where: { username: target.username.trim().toLowerCase(), deletedAt: null }, select: { id: true } })
          : null;
      if (!other) throw new HttpError(404, "user_not_found");
      if (other.id === userId) throw new HttpError(400, "cannot_message_self");

      const blocked = await db.userBlock.findFirst({
        where: { OR: [
          { blockerId: userId, blockedId: other.id },
          { blockerId: other.id, blockedId: userId },
        ] },
        select: { blockerId: true },
      });
      if (blocked) throw new HttpError(403, "messaging_blocked");

      const [userOneId, userTwoId] = [userId, other.id].sort();
      const pair = { userOneId, userTwoId };
      const include = { conversation: { include: conversationInclude } };
      const existing = await db.directConversation.findUnique({ where: { userOneId_userTwoId: pair }, include });
      if (existing) return { conversation: conversationView(existing.conversation), created: false };

      try {
        const conversation = await db.$transaction(tx => tx.conversation.create({
          data: {
            kind: "direct",
            members: { create: [{ userId }, { userId: other.id }] },
            direct: { create: pair },
          },
          include: conversationInclude,
        }));
        return { conversation: conversationView(conversation), created: true };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
        const raced = await db.directConversation.findUnique({ where: { userOneId_userTwoId: pair }, include });
        if (!raced) throw error;
        return { conversation: conversationView(raced.conversation), created: false };
      }
    },

    async createGroup(ownerId: string, rawTitle: string, rawMemberIds: string[]) {
      const title = groupTitle(rawTitle);
      const initialIds = memberIds(rawMemberIds, maxGroupMembers - 1);
      if (initialIds.includes(ownerId)) throw new HttpError(400, "group_owner_is_implicit");
      const allIds = [ownerId, ...initialIds];
      const found = await db.user.findMany({ where: { id: { in: allIds }, deletedAt: null }, select: { id: true } });
      if (found.length !== allIds.length) throw new HttpError(404, "group_member_not_found");
      const conversation = await serializable(db, tx => tx.conversation.create({
        data: {
          kind: "group",
          title,
          members: { create: allIds.map(userId => ({
            userId,
            role: userId === ownerId ? "owner" as const : "member" as const,
          })) },
        },
        include: conversationInclude,
      }));
      return conversationView(conversation);
    },

    async get(conversationId: string, userId: string) {
      validateConversationId(conversationId);
      const membership = await db.conversationMember.findFirst({
        where: { conversationId, userId, leftAt: null },
        include: { conversation: { include: conversationInclude } },
      });
      if (!membership) throw new HttpError(403, "conversation_access_denied");
      return conversationView(membership.conversation);
    },

    async updateGroupTitle(conversationId: string, actorId: string, rawTitle: string) {
      const title = groupTitle(rawTitle);
      const conversation = await serializable(db, async tx => {
        await requireGroupAdminTx(tx, conversationId, actorId);
        return tx.conversation.update({ where: { id: conversationId }, data: { title }, include: conversationInclude });
      });
      return conversationView(conversation);
    },

    async members(conversationId: string, userId: string) {
      await requireGroupMember(db, conversationId, userId);
      const rows = await db.conversationMember.findMany({
        where: { conversationId, leftAt: null },
        include: { user: { select: userSelect } },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      });
      return rows.map(row => ({ user: publicUser(row.user), role: row.role, joinedAt: row.joinedAt.toISOString() }));
    },

    async addMembers(conversationId: string, actorId: string, rawUserIds: string[]) {
      const ids = memberIds(rawUserIds, maxGroupMembers);
      await requireGroupAdmin(db, conversationId, actorId);
      if (ids.includes(actorId)) throw new HttpError(400, "cannot_add_self");
      const users = await db.user.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
      if (users.length !== ids.length) throw new HttpError(404, "group_member_not_found");
      return serializable(db, async tx => {
        const actor = await tx.conversationMember.findFirst({
          where: { conversationId, userId: actorId, leftAt: null }, select: { role: true },
        });
        if (!actor || (actor.role !== "owner" && actor.role !== "admin")) throw new HttpError(403, "group_admin_required");
        const activeCount = await tx.conversationMember.count({ where: { conversationId, leftAt: null } });
        const existing = await tx.conversationMember.findMany({
          where: { conversationId, userId: { in: ids } }, select: { userId: true, leftAt: true },
        });
        const activeIds = new Set(existing.filter(row => row.leftAt === null).map(row => row.userId));
        const toAdd = ids.filter(id => !activeIds.has(id));
        if (activeCount + toAdd.length > maxGroupMembers) throw new HttpError(409, "group_full");
        const existingById = new Map(existing.map(row => [row.userId, row]));
        for (const id of toAdd) {
          if (existingById.has(id)) {
            await tx.conversationMember.update({
              where: { conversationId_userId: { conversationId, userId: id } },
              data: { role: "member", joinedAt: new Date(), leftAt: null },
            });
          } else {
            await tx.conversationMember.create({ data: { conversationId, userId: id, role: "member" } });
          }
        }
        return { addedUserIds: toAdd };
      });
    },

    async removeMember(conversationId: string, actorId: string, targetId: string) {
      await requireGroupAdmin(db, conversationId, actorId);
      if (!uuidPattern.test(targetId)) throw new HttpError(400, "invalid_user_id");
      if (targetId === actorId) throw new HttpError(400, "use_group_leave");
      return serializable(db, async tx => {
        const actor = await tx.conversationMember.findFirst({
          where: { conversationId, userId: actorId, leftAt: null }, select: { role: true },
        });
        if (!actor || (actor.role !== "owner" && actor.role !== "admin")) throw new HttpError(403, "group_admin_required");
        const target = await tx.conversationMember.findFirst({ where: { conversationId, userId: targetId, leftAt: null } });
        if (!target) throw new HttpError(404, "group_member_not_found");
        if (target.role === "owner" || (actor.role === "admin" && target.role === "admin")) {
          throw new HttpError(403, "group_role_restricted");
        }
        await tx.conversationMember.update({
          where: { conversationId_userId: { conversationId, userId: targetId } },
          data: { leftAt: new Date() },
        });
        return { conversationId, userId: targetId, role: target.role };
      });
    },

    async setMemberRole(conversationId: string, ownerId: string, targetId: string, role: "admin" | "member") {
      if (!uuidPattern.test(targetId)) throw new HttpError(400, "invalid_user_id");
      return serializable(db, async tx => {
        await requireGroupAdminTx(tx, conversationId, ownerId, true);
        const target = await tx.conversationMember.findFirst({ where: { conversationId, userId: targetId, leftAt: null } });
        if (!target) throw new HttpError(404, "group_member_not_found");
        if (target.role === "owner") throw new HttpError(409, "transfer_ownership_instead");
        await tx.conversationMember.update({
          where: { conversationId_userId: { conversationId, userId: targetId } }, data: { role },
        });
        return { conversationId, userId: targetId, role };
      });
    },

    async transferOwnership(conversationId: string, ownerId: string, targetId: string) {
      if (!uuidPattern.test(targetId) || targetId === ownerId) throw new HttpError(400, "invalid_owner_transfer");
      return serializable(db, async tx => {
        await requireGroupAdminTx(tx, conversationId, ownerId, true);
        const target = await tx.conversationMember.findFirst({ where: { conversationId, userId: targetId, leftAt: null } });
        if (!target) throw new HttpError(404, "group_member_not_found");
        await tx.conversationMember.update({
          where: { conversationId_userId: { conversationId, userId: targetId } }, data: { role: "owner" },
        });
        await tx.conversationMember.update({
          where: { conversationId_userId: { conversationId, userId: ownerId } }, data: { role: "admin" },
        });
        return { conversationId, previousOwnerId: ownerId, userId: targetId, role: "owner" as const };
      });
    },

    async leaveGroup(conversationId: string, userId: string) {
      return serializable(db, async tx => {
        const member = await tx.conversationMember.findFirst({
          where: { conversationId, userId, leftAt: null },
          include: { conversation: { select: { kind: true } } },
        });
        if (!member) throw new HttpError(403, "conversation_access_denied");
        if (member.conversation.kind !== "group") throw new HttpError(400, "not_a_group");
        if (member.role === "owner") throw new HttpError(409, "owner_must_transfer_ownership");
        await tx.conversationMember.update({
          where: { conversationId_userId: { conversationId, userId } }, data: { leftAt: new Date() },
        });
        return { conversationId, userId, role: member.role };
      });
    },

    async createInvite(conversationId: string, creatorId: string, rawExpiresInHours = 168, rawMaxUses = 100) {
      if (!Number.isInteger(rawExpiresInHours) || rawExpiresInHours < 1 || rawExpiresInHours > 720) {
        throw new HttpError(400, "invalid_invite_expiration");
      }
      if (!Number.isInteger(rawMaxUses) || rawMaxUses < 1 || rawMaxUses > 1000) {
        throw new HttpError(400, "invalid_invite_use_limit");
      }
      const token = randomBytes(32).toString("base64url");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + rawExpiresInHours * 60 * 60 * 1000);
      const invite = await serializable(db, async tx => {
        await requireGroupAdminTx(tx, conversationId, creatorId);
        return tx.groupInvitation.create({
          data: {
            conversationId,
            createdBy: creatorId,
            tokenHash: inviteDigest(token),
            createdAt: now,
            expiresAt,
            maxUses: rawMaxUses,
          },
          select: { id: true, conversationId: true, createdAt: true, expiresAt: true, maxUses: true, useCount: true },
        });
      });
      return { ...invite, createdAt: invite.createdAt.toISOString(), expiresAt: invite.expiresAt.toISOString(), token };
    },

    async listInvites(conversationId: string, userId: string) {
      await requireGroupAdmin(db, conversationId, userId);
      const invites = await db.groupInvitation.findMany({
        where: { conversationId }, orderBy: { createdAt: "desc" },
        select: { id: true, createdBy: true, createdAt: true, expiresAt: true, maxUses: true, useCount: true, revokedAt: true },
      });
      return invites.map(invite => ({ ...invite,
        createdAt: invite.createdAt.toISOString(), expiresAt: invite.expiresAt.toISOString(),
        revokedAt: invite.revokedAt?.toISOString() ?? null,
      }));
    },

    async revokeInvite(conversationId: string, userId: string, inviteId: string) {
      if (!uuidPattern.test(inviteId)) throw new HttpError(400, "invalid_invite_id");
      return serializable(db, async tx => {
        await requireGroupAdminTx(tx, conversationId, userId);
        const invite = await tx.groupInvitation.findFirst({ where: { id: inviteId, conversationId } });
        if (!invite) throw new HttpError(404, "invite_not_found");
        if (!invite.revokedAt) {
          await tx.groupInvitation.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
        }
        return { id: invite.id, revoked: true };
      });
    },

    async previewInvite(userId: string, token: string) {
      if (!/^[a-z\d_-]{43}$/i.test(token)) throw new HttpError(404, "invite_unavailable");
      const invite = await db.groupInvitation.findUnique({
        where: { tokenHash: inviteDigest(token) },
        select: { expiresAt: true, revokedAt: true, useCount: true, maxUses: true, conversation: {
          select: { kind: true, title: true, members: { where: { userId, leftAt: null }, select: { userId: true } },
            _count: { select: { members: { where: { leftAt: null } } } } },
        } },
      });
      if (!invite || invite.conversation.kind !== "group") throw new HttpError(404, "invite_unavailable");
      const joined = invite.conversation.members.length > 0;
      if (invite.revokedAt || invite.expiresAt <= new Date() || (!joined && invite.useCount >= invite.maxUses)) {
        throw new HttpError(410, "invite_unavailable");
      }
      return { title: invite.conversation.title, expiresAt: invite.expiresAt.toISOString(), joined,
        canJoin: joined || invite.conversation._count.members < maxGroupMembers };
    },

    async redeemInvite(userId: string, token: string) {
      if (typeof token !== "string" || token.length < 32 || token.length > 128) {
        throw new HttpError(404, "invite_unavailable");
      }
      const tokenHash = inviteDigest(token);
      return serializable(db, async tx => {
        const invite = await tx.groupInvitation.findUnique({
          where: { tokenHash }, include: { conversation: { select: { kind: true } } },
        });
        if (!invite || invite.conversation.kind !== "group") throw new HttpError(404, "invite_unavailable");
        const now = new Date();
        if (invite.revokedAt || invite.expiresAt <= now) {
          throw new HttpError(410, "invite_unavailable");
        }
        const active = await tx.conversationMember.findUnique({
          where: { conversationId_userId: { conversationId: invite.conversationId, userId } },
        });
        if (active?.leftAt === null) return { joined: false, conversationId: invite.conversationId };
        if (invite.useCount >= invite.maxUses) throw new HttpError(410, "invite_unavailable");
        const activeCount = await tx.conversationMember.count({
          where: { conversationId: invite.conversationId, leftAt: null },
        });
        if (activeCount >= maxGroupMembers) throw new HttpError(409, "group_full");
        if (active) {
          await tx.conversationMember.update({
            where: { conversationId_userId: { conversationId: invite.conversationId, userId } },
            data: { role: "member", joinedAt: now, leftAt: null },
          });
        } else {
          await tx.conversationMember.create({ data: { conversationId: invite.conversationId, userId, role: "member" } });
        }
        const used = await tx.groupInvitation.updateMany({
          where: { id: invite.id, revokedAt: null, expiresAt: { gt: now }, useCount: { lt: invite.maxUses } },
          data: { useCount: { increment: 1 } },
        });
        if (used.count !== 1) throw new HttpError(410, "invite_unavailable");
        return { joined: true, conversationId: invite.conversationId, userId };
      });
    },
  };
}

export type ConversationService = ReturnType<typeof createConversationService>;
