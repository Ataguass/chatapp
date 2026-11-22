import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;
type SecretName = "DATABASE_URL" | "REDIS_URL" | "MIGRATION_DATABASE_URL";

export function readConnection(env: Environment, name: SecretName): string {
  const path = env[name + "_FILE"];
  const inline = env[name];
  if (path && inline) throw new Error(`Set exactly one source for ${name}`);
  let raw = inline;
  if (path) {
    try {
      raw = readFileSync(path, "utf8").trim();
    } catch {
      throw new Error(`Unable to read ${name}_FILE`);
    }
  }
  if (!raw) throw new Error(`Missing ${name}`);
  const redis = name === "REDIS_URL";
  try {
    const url = new URL(raw);
    const protocols = redis ? ["redis:", "rediss:"] : ["postgres:", "postgresql:"];
    if (!protocols.includes(url.protocol) || !url.hostname || url.hash ||
        (!redis && url.pathname.length < 2) || raw.includes("CHANGE_ME")) {
      throw new Error();
    }
    if (env.NODE_ENV === "production" && !url.password) throw new Error();
  } catch {
    throw new Error(`Invalid ${name}`);
  }
  return raw;
}

function integer(env: Environment, key: string, fallback: number, min: number, max: number) {
  const raw = env[key] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

export function settings(env: Environment) {
  const host = env.API_HOST ?? "127.0.0.1";
  if (!isIP(host) && host !== "localhost") throw new Error("Invalid API_HOST");
  const socketAllowedOrigins = (env.SOCKET_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  for (const origin of socketAllowedOrigins) {
    try {
      const url = new URL(origin);
      if (!(["http:", "https:"].includes(url.protocol)) || url.origin !== origin || url.username || url.password) {
        throw new Error();
      }
    } catch {
      throw new Error("Invalid SOCKET_ALLOWED_ORIGINS");
    }
  }
  const mediaStoragePath = resolve(env.MEDIA_STORAGE_PATH ?? "data/media");
  const fcmProjectId = env.FCM_PROJECT_ID?.trim() || undefined;
  const fcmServiceAccountPath = env.FCM_SERVICE_ACCOUNT_FILE?.trim();
  const fcmServiceAccountFile = fcmServiceAccountPath ? resolve(fcmServiceAccountPath) : undefined;
  if (Boolean(fcmProjectId) !== Boolean(fcmServiceAccountFile) ||
      (fcmProjectId && !/^[a-z0-9][a-z0-9-]{4,62}[a-z0-9]$/.test(fcmProjectId))) {
    throw new Error("Invalid Firebase Cloud Messaging configuration");
  }
  return {
    host,
    port: integer(env, "API_PORT", 4080, 1, 65535),
    deadline: integer(env, "HEALTH_TIMEOUT_MS", 1500, 50, 10000),
    maxGroupMembers: integer(env, "MAX_GROUP_MEMBERS", 100, 2, 500),
    mediaStoragePath,
    mediaLimits: {
      image: integer(env, "MEDIA_IMAGE_MAX_BYTES", 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
      video: integer(env, "MEDIA_VIDEO_MAX_BYTES", 50 * 1024 * 1024, 1024, 500 * 1024 * 1024),
      audio: integer(env, "MEDIA_AUDIO_MAX_BYTES", 20 * 1024 * 1024, 1024, 200 * 1024 * 1024),
      document: integer(env, "MEDIA_DOCUMENT_MAX_BYTES", 25 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    },
    fcmProjectId,
    fcmServiceAccountFile,
    databaseUrl: readConnection(env, "DATABASE_URL"),
    redisUrl: readConnection(env, "REDIS_URL"),
    socketAllowedOrigins,
  };
}
