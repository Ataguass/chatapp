import { cookies } from "next/headers";
import { backendUrl, clearSession, getAccessToken, saveSession } from "@/lib/server-auth";

type SessionPayload = {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

async function currentUser(accessToken: string) {
  return fetch(backendUrl("/v1/auth/me"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
}

export async function GET() {
  const jar = await cookies();
  let token = await getAccessToken(jar);
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
  let response = await currentUser(token);
  if (response.status === 401) {
    token = await getAccessToken(jar, true);
    if (token) response = await currentUser(token);
  }
  if (!response.ok) {
    clearSession(jar);
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(await response.json(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let input: unknown;
  try { input = await request.json(); } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const body = input as Record<string, unknown>;
  if ((body.action !== "login" && body.action !== "register") || typeof body.username !== "string" ||
      typeof body.password !== "string" ||
      (body.displayName !== undefined && typeof body.displayName !== "string")) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const payload: Record<string, string> = {
    username: body.username,
    password: body.password,
    platform: "web",
    deviceName: "Web browser",
  };
  if (body.action === "register") payload.displayName = typeof body.displayName === "string" ? body.displayName : body.username;
  const endpoint = body.action === "register" ? "register" : "login";
  const response = await fetch(backendUrl(`/v1/auth/${endpoint}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({ error: "service_unavailable" })) as Record<string, unknown>;
  if (!response.ok) return Response.json(data, { status: response.status });
  if (typeof data.accessToken !== "string" || typeof data.refreshToken !== "string" ||
      typeof data.accessExpiresAt !== "string" || typeof data.refreshExpiresAt !== "string") {
    return Response.json({ error: "invalid_session_response" }, { status: 502 });
  }
  saveSession(await cookies(), data as unknown as SessionPayload);
  return Response.json(data.user, { status: response.status, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE() {
  const jar = await cookies();
  const token = await getAccessToken(jar);
  if (token) {
    await fetch(backendUrl("/v1/auth/logout"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }).catch(() => undefined);
  }
  clearSession(jar);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
