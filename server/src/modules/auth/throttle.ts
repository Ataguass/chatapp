import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { HttpError } from "./service.ts";

const consume = `
  local retry = 0
  for i, key in ipairs(KEYS) do
    local cap = tonumber(ARGV[i * 2 - 1])
    local count = tonumber(redis.call('GET', key) or '0')
    if count >= cap then
      retry = math.max(retry, redis.call('TTL', key), 1)
    end
  end
  if retry > 0 then return retry end
  for i, key in ipairs(KEYS) do
    if redis.call('INCR', key) == 1 then
      redis.call('EXPIRE', key, ARGV[i * 2])
    end
  end
  return 0
`;

const limits = {
  register: { source: [20, 900] },
  login: { source: [120, 300], account: [12, 900] },
  recover: { source: [40, 900], account: [8, 900] },
  account_change: { source: [60, 900], account: [10, 900] },
} satisfies Record<string, { source: number[]; account?: number[] }>;

export type AuthThrottle = (action: keyof typeof limits, source: string, username: string) => Promise<number>;

function key(scope: string, value: string) {
  const digest = createHash("sha256").update(value).digest("hex");
  return `messaging:auth:${scope}:${digest}`;
}

export function createAuthThrottle(redis: Pick<Redis, "eval">): AuthThrottle {
  return async (action, source, rawUsername) => {
    const keys = [key(action + ":source", source)];
    const { source: sourceLimit, account: accountLimit } = action === "register" ? { ...limits.register, account: null } : limits[action];
    const rules = [...sourceLimit];
    const username = rawUsername.trim().toLowerCase();
    if (accountLimit && /^[a-z0-9_]{3,32}$/.test(username)) {
      keys.push(key(action + ":account", username));
      rules.push(...accountLimit);
    }
    try {
      const retry = await redis.eval(consume, keys.length, ...keys, ...rules);
      if (typeof retry !== "number") throw new Error("Invalid rate limiter result");
      return retry;
    } catch {
      throw new HttpError(503, "auth_temporarily_unavailable");
    }
  };
}
