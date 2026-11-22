import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { HttpError } from "../auth/service.ts";
import type { Logger } from "../../infrastructure/log.ts";

const googleTokenUrl = "https://oauth2.googleapis.com/token";
const fcmScope = "https://www.googleapis.com/auth/firebase.messaging";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ServiceAccount = { project_id: string; client_email: string; private_key: string };
type FcmSettings = { projectId?: string; serviceAccountFile?: string };

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

  async function googleAccessToken(serviceAccount: ServiceAccount) {
    if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value;
    accessTokenPromise ??= (async () => {
      const response = await fetch(googleTokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: signedAssertion(serviceAccount),
        }),
        signal: AbortSignal.timeout(10_000),
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

  async function send(token: string, title: string, body: string, data: Record<string, string>) {
    if (!serviceAccount || !config.projectId) return "disabled" as const;
    const bearer = await googleAccessToken(serviceAccount);
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: {
        token,
        notification: { title, body },
        data,
        android: { priority: "high" },
        apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
        webpush: { headers: { Urgency: "high" } },
      } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return "sent" as const;
    const error = await response.json().catch(() => null) as {
      error?: { status?: string; details?: Array<{ errorCode?: string }> };
    } | null;
    const invalid = error?.error?.details?.some(item => item.errorCode === "UNREGISTERED");
    if (invalid) return "invalid" as const;
    log("push.delivery_failed", { status: response.status });
    return "failed" as const;
  }

  return {
    async register(userId: string, deviceId: string, value: unknown) {
      if (typeof value !== "string" || value.trim().length < 16 || value.length > 4096 || value.trim() !== value) {
        throw new HttpError(400, "invalid_push_token");
      }
      if (!uuidPattern.test(userId) || !uuidPattern.test(deviceId)) throw new HttpError(401, "unauthorized");
      await db.pushToken.upsert({
        where: { token: value },
        create: { token: value, userId, deviceId, provider: "fcm" },
        update: { userId, deviceId, provider: "fcm", updatedAt: new Date() },
      });
    },

    async remove(userId: string, deviceId: string) {
      await db.pushToken.deleteMany({ where: { userId, deviceId } });
    },

    async notifyNewMessage(conversationId: string, messageId: string) {
      if (!serviceAccount || !config.projectId) return;
      const message = await db.message.findFirst({
        where: { id: messageId, conversationId, deletedAt: null },
        select: { senderId: true, sender: { select: { user: { select: { displayName: true } } } } },
      });
      if (!message) return;
      const recipients = await db.conversationMember.findMany({
        where: { conversationId, leftAt: null, userId: { not: message.senderId } },
        select: { user: { select: { pushTokens: { select: { id: true, token: true } } } } },
      });
      const tokens = recipients.flatMap(member => member.user.pushTokens);
      const title = "New message";
      const body = `${message.sender.user.displayName} sent you a message`;
      let sent = 0;
      for (let i = 0; i < tokens.length; i += 20) {
        const batch = tokens.slice(i, i + 20);
        const results = await Promise.all(batch.map(async pushToken => {
          try {
            const result = await send(pushToken.token, title, body, { type: "message", conversationId, messageId });
            if (result === "invalid") {
              await db.pushToken.deleteMany({ where: { id: pushToken.id } });
            }
            return result;
          } catch {
            log("push.delivery_failed", { reason: "transport_error" });
            return "failed" as const;
          }
        }));
        sent += results.filter(result => result === "sent").length;
      }
      if (sent) log("push.delivered", { count: sent });
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
