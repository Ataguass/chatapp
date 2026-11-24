import { createHash, randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { lockActiveAccount } from "./account-lock.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";
import { HttpError, validatePassword, type AuthContext } from "./service.ts";

function codeHash(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

function freshRecoveryCode() {
  return randomBytes(16).toString("hex");
}

async function confirmPassword(db: PrismaClient, context: AuthContext, password: string) {
  validatePassword(password);
  const user = await db.user.findUnique({ where: { id: context.user.id, deletedAt: null }, select: { passwordHash: true } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) throw new HttpError(401, "invalid_current_password");
  return user.passwordHash;
}

async function confirmStillAuthorized(tx: Prisma.TransactionClient, context: AuthContext, passwordHash: string) {
  const user = await lockActiveAccount(tx, context.user.id);
  const session = await tx.userSession.findFirst({ where: {
    id: context.sessionId, userId: context.user.id, revokedAt: null, accessExpiresAt: { gt: new Date() }, expiresAt: { gt: new Date() },
  }, select: { id: true } });
  if (!user || user.passwordHash !== passwordHash || !session) throw new HttpError(401, "unauthorized");
}

export function createAccountLifecycle(db: PrismaClient) {
  return {
    async changePassword(context: AuthContext, currentPassword: string, newPassword: string) {
      validatePassword(newPassword);
      if (newPassword === currentPassword) throw new HttpError(400, "password_unchanged");
      const currentHash = await confirmPassword(db, context, currentPassword);
      const passwordHash = await hashPassword(newPassword);
      const userId = context.user.id;
      await db.$transaction(async tx => {
        await confirmStillAuthorized(tx, context, currentHash);
        await tx.user.update({ where: { id: userId }, data: { passwordHash } });
        await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.pushToken.deleteMany({ where: { userId } });
        await tx.accountRecoveryCode.deleteMany({ where: { userId } });
      });
    },

    async replaceRecoveryCodes(context: AuthContext, password: string) {
      const passwordHash = await confirmPassword(db, context, password);
      const userId = context.user.id;
      const codes = Array.from({ length: 5 }, freshRecoveryCode);
      await db.$transaction(async tx => {
        await confirmStillAuthorized(tx, context, passwordHash);
        await tx.accountRecoveryCode.deleteMany({ where: { userId } });
        await tx.accountRecoveryCode.createMany({ data: codes.map(code => ({ userId, codeHash: codeHash(code) })) });
      });
      return codes.map(code => code.match(/.{1,8}/g)!.join("-"));
    },

    async resetPassword(rawUsername: string, rawCode: string, password: string) {
      const username = rawUsername.trim().toLowerCase();
      const code = rawCode.replace(/[\s-]/g, "").toLowerCase();
      if (!/^[a-z0-9_]{3,32}$/.test(username) || rawCode.length > 100 || !/^[a-f0-9]{32}$/.test(code)) {
        throw new HttpError(401, "invalid_recovery_credentials");
      }
      validatePassword(password);
      const digest = codeHash(code);
      const pending = await db.accountRecoveryCode.findFirst({
        where: { codeHash: digest, user: { username, deletedAt: null } }, select: { userId: true },
      });
      if (!pending) throw new HttpError(401, "invalid_recovery_credentials");
      const passwordHash = await hashPassword(password);
      const { userId } = pending;
      await db.$transaction(async tx => {
        if (!await lockActiveAccount(tx, userId)) throw new HttpError(401, "invalid_recovery_credentials");
        const consumed = await tx.accountRecoveryCode.deleteMany({ where: { codeHash: digest, userId } });
        if (consumed.count !== 1) throw new HttpError(401, "invalid_recovery_credentials");
        await tx.accountRecoveryCode.deleteMany({ where: { userId } });
        await tx.user.update({ where: { id: userId }, data: { passwordHash } });
        await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.pushToken.deleteMany({ where: { userId } });
      });
      return userId;
    },

    async deleteAccount(context: AuthContext, confirmation: string, password: string) {
      if (confirmation.trim() !== context.user.username) throw new HttpError(400, "username_confirmation_required");
      const passwordHash = await confirmPassword(db, context, password);
      const userId = context.user.id;
      try {
        return await db.$transaction(async tx => {
          await confirmStillAuthorized(tx, context, passwordHash);
          const memberships = await tx.conversationMember.findMany({
            where: { userId }, select: { conversationId: true, role: true, leftAt: true,
              conversation: { select: { kind: true } } },
          });
          const attachments = await tx.attachment.findMany({ where: { uploadedBy: userId }, select: { storageKey: true } });
          const stories = await tx.story.findMany({ where: { userId }, select: { storageKey: true } });
          await tx.conversationMember.deleteMany({ where: { userId } });
          await tx.attachment.deleteMany({ where: { uploadedBy: userId } });
          await tx.story.deleteMany({ where: { userId } });
          await tx.storyView.deleteMany({ where: { viewerId: userId } });
          await tx.storyAudience.deleteMany({ where: { userId } });
          await tx.storyPrivacy.deleteMany({ where: { userId } });
          await tx.directCall.deleteMany({ where: { OR: [{ callerId: userId }, { recipientId: userId }] } });
          await tx.moderationReport.deleteMany({ where: { reporterId: userId } });
          await tx.moderationReport.updateMany({ where: { reviewedById: userId }, data: { reviewedById: null } });
          await tx.mediaPolicy.updateMany({ where: { updatedById: userId }, data: { updatedById: null } });
          const files = [...attachments, ...stories.flatMap(story => story.storageKey ? [{ storageKey: story.storageKey }] : [])];
          if (files.length) await tx.pendingMediaDeletion.createMany({ data: files, skipDuplicates: true });
          await tx.userDevice.deleteMany({ where: { userId } });
          await tx.accountRecoveryCode.deleteMany({ where: { userId } });
          await tx.userBlock.deleteMany({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] } });
          await tx.groupInvitation.deleteMany({ where: { createdBy: userId } });
          for (const member of memberships) {
            if (member.conversation.kind !== "group" || member.role !== "owner" || member.leftAt) continue;
            const successor = await tx.conversationMember.findFirst({
              where: { conversationId: member.conversationId, leftAt: null, user: { deletedAt: null } },
              orderBy: [{ role: "asc" }, { joinedAt: "asc" }, { userId: "asc" }],
              select: { userId: true },
            });
            if (successor) await tx.conversationMember.update({ where: {
              conversationId_userId: { conversationId: member.conversationId, userId: successor.userId },
            }, data: { role: "owner" } });
            else await tx.groupInvitation.deleteMany({ where: { conversationId: member.conversationId } });
          }
          await tx.user.update({ where: { id: userId }, data: {
            username: "deleted_" + randomBytes(12).toString("hex"), displayName: "Deleted account",
            bio: null, avatarUrl: null, passwordHash: "deleted", pushEnabled: false, createdAt: new Date(0), deletedAt: new Date(),
          } });
          return memberships.map(member => member.conversationId);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
          throw new HttpError(409, "account_changed_retry");
        }
        throw error;
      }
    },
  };
}

export type AccountLifecycle = ReturnType<typeof createAccountLifecycle>;
