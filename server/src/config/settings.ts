import { readFileSync } from "node:fs";
import { isIP } from "node:net";

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
  return {
    host,
    port: integer(env, "API_PORT", 4080, 1, 65535),
    deadline: integer(env, "HEALTH_TIMEOUT_MS", 1500, 50, 10000),
    databaseUrl: readConnection(env, "DATABASE_URL"),
    redisUrl: readConnection(env, "REDIS_URL"),
  };
}
