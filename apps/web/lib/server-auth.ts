import { cookies } from "next/headers";

export const accessCookie = "chat_access";
const refreshCookie = "chat_refresh";
const expiryCookie = "chat_access_expiry";
const apiUrl = () => (process.env.MESSAGING_API_URL ?? "http://127.0.0.1:4080").replace(/\/$/, "");
type CookieJar = Awaited<ReturnType<typeof cookies>>;
type SessionPayload = {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};
const rotations = new Map<string, Promise<SessionPayload | null>>();

function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires,
  };
}

export function saveSession(jar: CookieJar, session: SessionPayload) {
  jar.set(accessCookie, session.accessToken, cookieOptions(new Date(session.accessExpiresAt)));
  jar.set(refreshCookie, session.refreshToken, cookieOptions(new Date(session.refreshExpiresAt)));
  jar.set(expiryCookie, String(Date.parse(session.accessExpiresAt)), cookieOptions(new Date(session.accessExpiresAt)));
}

export function clearSession(jar: CookieJar) {
  jar.delete(accessCookie);
  jar.delete(refreshCookie);
  jar.delete(expiryCookie);
}

async function requestRotation(refreshToken: string) {
  const response = await fetch(`${apiUrl()}/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  return response.ok ? await response.json() as SessionPayload : null;
}

async function rotate(jar: CookieJar) {
  const refreshToken = jar.get(refreshCookie)?.value;
  if (!refreshToken || !/^[a-zA-Z0-9_-]{43}$/.test(refreshToken)) return null;
  let pending = rotations.get(refreshToken);
  if (!pending) {
    pending = requestRotation(refreshToken).finally(() => rotations.delete(refreshToken));
    rotations.set(refreshToken, pending);
  }
  const session = await pending;
  if (!session) return null;
  saveSession(jar, session);
  return session.accessToken;
}

export async function getAccessToken(jar: CookieJar, forceRefresh = false) {
  if (forceRefresh) return rotate(jar);
  const token = jar.get(accessCookie)?.value;
  const expiresAt = Number(jar.get(expiryCookie)?.value ?? 0);
  if (token && expiresAt > Date.now() + 30_000) return token;
  return rotate(jar);
}

export function backendUrl(path: string) {
  return `${apiUrl()}${path}`;
}
