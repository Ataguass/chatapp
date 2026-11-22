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

async function rotate(jar: CookieJar) {
  const refreshToken = jar.get(refreshCookie)?.value;
  if (!refreshToken) return null;
  const response = await fetch(`${apiUrl()}/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
  });
  if (!response.ok) {
    clearSession(jar);
    return null;
  }
  const session = await response.json() as SessionPayload;
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
