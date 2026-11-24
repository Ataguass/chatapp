import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";

const BLOCK_SIZE = 8;
const current = { N: 1 << 15, r: BLOCK_SIZE, p: 3, maxmem: 64 * 1024 * 1024 };
const legacy = { ...current, N: 1 << 14, p: 1 };
const KEY_LENGTH = 64;
const DUMMY_SALT = Buffer.alloc(16, 0x5a);

function derive(password: string, salt: Buffer, options: ScryptOptions = current) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

function prefix(options: typeof current) {
  return `scrypt$${options.N}$${options.r}$${options.p}$`;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${prefix(current)}${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function needsPasswordUpgrade(encoded: string) {
  return encoded.startsWith(prefix(legacy));
}

export async function verifyPassword(password: string, encoded: string) {
  const parts = encoded.split("$");
  const options = encoded.startsWith(prefix(current)) ? current :
    needsPasswordUpgrade(encoded) ? legacy : null;
  if (parts.length !== 6 || !options) {
    await derive(password, DUMMY_SALT);
    return false;
  }
  try {
    const salt = Buffer.from(parts[4], "base64url");
    const expected = Buffer.from(parts[5], "base64url");
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) {
      await derive(password, DUMMY_SALT);
      return false;
    }
    const actual = await derive(password, salt, options);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
