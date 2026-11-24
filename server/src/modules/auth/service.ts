import { createHash, randomBytes } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type { DevicePlatform, PublicUser, AuthSessionResponse } from "@messaging/contracts";
import { hashPassword, needsPasswordUpgrade, verifyPassword } from "./passwords.ts";
import { lockActiveAccount } from "./account-lock.ts";

const ACCESS_LIFETIME_MS = 15 * 60 * 1000;
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const usernamePattern = /^[a-z0-9_]{3,32}$/;
const platforms = new Set<DevicePlatform>(["android", "ios", "web", "desktop"]);

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export type DeviceDetails = { platform: DevicePlatform; deviceName: string };
export type Credentials = DeviceDetails & { username: string; password: string };
export type Registration = Credentials & { displayName: string };

export type AuthContext = {
  sessionId: string;
  deviceId: string;
  user: PublicUser;
};

function token() {
  return randomBytes(32).toString("base64url");
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function publicUser(user: {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: Date;
}): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    createdAt: user.createdAt.toISOString(),
  };
}

function cleanUsername(value: string) {
  const username = value.trim().toLowerCase();
  if (!usernamePattern.test(username)) throw new HttpError(400, "invalid_username");
  return username;
}

export function validatePassword(value: string) {
  if ([...value].length < 12 || Buffer.byteLength(value, "utf8") > 128) {
    throw new HttpError(400, "invalid_password");
  }
}

function validateDevice(device: DeviceDetails) {
  if (!platforms.has(device.platform) || !device.deviceName.trim() ||
      device.deviceName.trim().length > 120) {
    throw new HttpError(400, "invalid_device");
  }
}

function sessionResponse(user: Parameters<typeof publicUser>[0], accessToken: string,
  refreshToken: string, accessExpiresAt: Date, refreshExpiresAt: Date): AuthSessionResponse {
  return {
    accessToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    refreshToken,
    refreshExpiresAt: refreshExpiresAt.toISOString(),
    user: publicUser(user),
  };
}

async function createSession(db: Prisma.TransactionClient, user: {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: Date;
}, deviceDetails: DeviceDetails): Promise<AuthSessionResponse> {
  const now = new Date();
  const accessToken = token();
  const refreshToken = token();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_LIFETIME_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_LIFETIME_MS);
  const device = await db.userDevice.create({
    data: { userId: user.id, platform: deviceDetails.platform, deviceName: deviceDetails.deviceName.trim() },
  });
  await db.userSession.create({
    data: {
      userId: user.id,
      deviceId: device.id,
      accessTokenHash: digest(accessToken),
      accessExpiresAt,
      refreshTokenHash: digest(refreshToken),
      expiresAt: refreshExpiresAt,
    },
  });
  return sessionResponse(user, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt);
}

export function createAuthService(db: PrismaClient) {
  return {
    async register(input: Registration) {
      const username = cleanUsername(input.username);
      validatePassword(input.password);
      validateDevice(input);
      const displayName = input.displayName.trim();
      if (!displayName || displayName.length > 100) throw new HttpError(400, "invalid_display_name");
      const passwordHash = await hashPassword(input.password);
      try {
        return await db.$transaction(async tx => {
          const user = await tx.user.create({
            data: { username, displayName, passwordHash },
          });
          return createSession(tx, user, input);
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new HttpError(409, "username_taken");
        }
        throw error;
      }
    },

    async login(input: Credentials) {
      const username = cleanUsername(input.username);
      validatePassword(input.password);
      validateDevice(input);
      const user = await db.user.findUnique({ where: { username, deletedAt: null } });
      if (!user) {
        await hashPassword(input.password);
        throw new HttpError(401, "invalid_credentials");
      }
      if (!(await verifyPassword(input.password, user.passwordHash))) {
        throw new HttpError(401, "invalid_credentials");
      }
      const upgradedHash = needsPasswordUpgrade(user.passwordHash) ? await hashPassword(input.password) : null;
      return db.$transaction(async tx => {
        const current = await lockActiveAccount(tx, user.id);
        if (!current || current.passwordHash !== user.passwordHash) throw new HttpError(401, "invalid_credentials");
        if (upgradedHash) {
          await tx.user.updateMany({ where: { id: user.id, passwordHash: user.passwordHash },
            data: { passwordHash: upgradedHash } });
        }
        return createSession(tx, user, input);
      });
    },

    async refresh(refreshToken: string) {
      if (typeof refreshToken !== "string" || refreshToken.length < 32 || refreshToken.length > 128) {
        throw new HttpError(401, "invalid_refresh_token");
      }
      const hash = digest(refreshToken);
      const now = new Date();
      const session = await db.userSession.findUnique({
        where: { refreshTokenHash: hash },
        include: { device: { include: { user: true } } },
      });
      if (!session || session.revokedAt || session.expiresAt <= now || session.device.user.deletedAt) {
        throw new HttpError(401, "invalid_refresh_token");
      }
      const accessToken = token();
      const nextRefreshToken = token();
      const accessExpiresAt = new Date(now.getTime() + ACCESS_LIFETIME_MS);
      const refreshExpiresAt = new Date(now.getTime() + REFRESH_LIFETIME_MS);
      await db.$transaction(async tx => {
        if (!await lockActiveAccount(tx, session.userId)) throw new HttpError(401, "invalid_refresh_token");
        const rotated = await tx.userSession.updateMany({
          where: { id: session.id, refreshTokenHash: hash, revokedAt: null, expiresAt: { gt: now } },
          data: {
            accessTokenHash: digest(accessToken),
            accessExpiresAt,
            refreshTokenHash: digest(nextRefreshToken),
            expiresAt: refreshExpiresAt,
          },
        });
        if (rotated.count !== 1) throw new HttpError(401, "invalid_refresh_token");
        await tx.userDevice.updateMany({
          where: { id: session.deviceId, userId: session.userId, lastSeenAt: { lt: now } },
          data: { lastSeenAt: now },
        });
      });
      return sessionResponse(session.device.user, accessToken, nextRefreshToken,
        accessExpiresAt, refreshExpiresAt);
    },

    async authenticate(accessToken: string): Promise<AuthContext> {
      const session = await db.userSession.findUnique({
        where: { accessTokenHash: digest(accessToken) },
        include: { device: { include: { user: true } } },
      });
      const now = new Date();
      if (!session || session.revokedAt || session.accessExpiresAt <= now || session.expiresAt <= now || session.device.user.deletedAt) {
        throw new HttpError(401, "unauthorized");
      }
      return { sessionId: session.id, deviceId: session.deviceId, user: publicUser(session.device.user) };
    },

    async logout(context: AuthContext) {
      await db.$transaction(async tx => {
        if (!await lockActiveAccount(tx, context.user.id)) return;
        await tx.userSession.updateMany({
          where: { id: context.sessionId, userId: context.user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.pushToken.deleteMany({ where: { userId: context.user.id, deviceId: context.deviceId } });
      });
    },

    async logoutAll(userId: string) {
      await db.$transaction(async tx => {
        if (!await lockActiveAccount(tx, userId)) return;
        await tx.userSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.pushToken.deleteMany({ where: { userId } });
      });
    },
  };
}
