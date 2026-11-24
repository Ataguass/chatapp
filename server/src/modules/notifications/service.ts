import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { HttpError, type AuthContext } from "../auth/service.ts";
import { lockActiveAccount } from "../auth/account-lock.ts";
import type { Logger } from "../../infrastructure/log.ts";

const googleTokenUrl = "https://oauth2.googleapis.com/token";
const fcmScope = "https://www.googleapis.com/auth/firebase.messaging";

type ServiceAccount = { project_id: string; client_email: string; private_key: string };
type FcmSettings = { projectId?: string; serviceAccountFile?: string };
export type PushResult = { status: "sent" | "invalid" | "permanent" } | { status: "retry"; delayMs: number };

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function signedAssertion(account: ServiceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: account.client_email,
    scope: fcmScope,
    aud: googleTokenUrl,
    iat: now,
    exp: now + 3600,
  }));
  const content = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(content);
  return `${content}.${signer.sign(account.private_key, "base64url")}`;
}

export function createNotificationService(db: PrismaClient, config: FcmSettings, log: Logger) {
  if (Boolean(config.projectId) !== Boolean(config.serviceAccountFile)) {
    throw new Error("FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_FILE must be set together");
  }
  let serviceAccount: ServiceAccount | null = null;
  if (config.serviceAccountFile) {
    const parsed = JSON.parse(readFileSync(config.serviceAccountFile, "utf8")) as Partial<ServiceAccount>;
    if (typeof parsed.project_id !== "string" || typeof parsed.client_email !== "string" ||
        typeof parsed.private_key !== "string" || !parsed.private_key.includes("PRIVATE KEY")) {
      throw new Error("Invalid Firebase service account file");
    }
    if (parsed.project_id !== config.projectId) throw new Error("FCM project ID does not match service account");
    serviceAccount = parsed as ServiceAccount;
  }
  let accessToken: { value: string; expiresAt: number } | undefined;
  let accessTokenPromise: Promise<string> | undefined;

  async function googleAccessToken(serviceAccount: ServiceAccount, stop: AbortSignal) {
    if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value;
    accessTokenPromise ??= (async () => {
      const response = await fetch(googleTokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: signedAssertion(serviceAccount),
        }),
        signal: AbortSignal.any([stop, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error("FCM OAuth request failed");
      const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
        throw new Error("FCM OAuth response invalid");
      }
      accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
      return accessToken.value;
    })().finally(() => { accessTokenPromise = undefined; });
    return accessTokenPromise;
  }

  async function send(token: string, data: Record<string, string>, stop: AbortSignal): Promise<PushResult> {
    if (!serviceAccount || !config.projectId) return { status: "permanent" };
    const bearer = await googleAccessToken(serviceAccount, stop);
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: {
        token,
        notification: { title: "New message", body: "Open Chatapp to view your message" },
        data,
        android: { priority: "high" },
        apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
        webpush: { headers: { Urgency: "high" } },
      } }),
      signal: AbortSignal.any([stop, AbortSignal.timeout(10_000)]),
    });
    if (response.ok) return { status: "sent" };
    const error = await response.json().catch(() => null) as {
      error?: { status?: string; details?: Array<{ errorCode?: string }> };
    } | null;
    const invalid = error?.error?.details?.some(item => item.errorCode === "UNREGISTERED");
    if (invalid) return { status: "invalid" };
    if (response.status === 401) accessToken = undefined;
    log("push.delivery_failed", { status: response.status });
    if (response.status !== 429 && response.status < 500) return { status: "permanent" };
    const retryAfter = response.headers.get("Retry-After") ?? "";
    const parsed = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    return { status: "retry", delayMs: Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000 };
  }

  return {
    enabled: Boolean(serviceAccount),
    send,
    async preferences(userId: string) {
      const row = await db.user.findUnique({ where: { id: userId, deletedAt: null }, select: { pushEnabled: true } });
      if (!row) throw new HttpError(401, "unauthorized");
      return row;
    },

    async setPreferences(userId: string, pushEnabled: boolean) {
      const changed = await db.user.updateMany({ where: { id: userId, deletedAt: null }, data: { pushEnabled } });
      if (!changed.count) throw new HttpError(401, "unauthorized");
      return { pushEnabled };
    },
    async register(context: AuthContext, value: unknown) {
      if (typeof value !== "string" || value.trim().length < 16 || value.length > 4096 || value.trim() !== value) {
        throw new HttpError(400, "invalid_push_token");
      }
      const { user: { id: userId }, deviceId, sessionId } = context;
      await db.$transaction(async tx => {
        const user = await lockActiveAccount(tx, userId);
        const now = new Date();
        const session = await tx.userSession.findFirst({ where: {
          id: sessionId, userId, deviceId, revokedAt: null, accessExpiresAt: { gt: now }, expiresAt: { gt: now },
        }, select: { id: true } });
        if (!user || !session) throw new HttpError(401, "unauthorized");
        await tx.pushToken.upsert({
          where: { token: value },
          create: { token: value, userId, deviceId, provider: "fcm" },
          update: { userId, deviceId, provider: "fcm", updatedAt: now },
        });
      });
    },

    async remove(userId: string, deviceId: string) {
      await db.pushToken.deleteMany({ where: { userId, deviceId } });
    },

  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
