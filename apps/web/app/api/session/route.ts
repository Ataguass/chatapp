import { cookies } from "next/headers";
import { backendUrl, clearSession, getAccessToken, saveSession } from "@/lib/server-auth";
import { rejectForeignRequest } from "@/lib/request-origin";

type SessionPayload = {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

const maxLoginBytes = 16 * 1024;

async function readCredentials(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > maxLoginBytes) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function currentUser(accessToken: string) {
  return fetch(backendUrl("/v1/auth/me"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
}

async function forwardAccountRequest(path: string, body: Record<string, string>, token?: string, method = "POST") {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const upstream = await fetch(backendUrl(path), {
    method, headers, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  const retryAfter = upstream?.headers.get("retry-after");
  if (retryAfter) responseHeaders.set("Retry-After", retryAfter);
  if (upstream?.status === 204) return new Response(null, { status: 204, headers: responseHeaders });
  const payload = await upstream?.json().catch(() => null);
  return Response.json(payload ?? { error: "service_unavailable" }, {
    status: upstream?.status ?? 502, headers: responseHeaders,
  });
}

export async function GET(request: Request) {
  const rejected = rejectForeignRequest(request);
  if (rejected) return rejected;
  const jar = await cookies();
  let token = await getAccessToken(jar);
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
  let response = await currentUser(token);
  if (response.status === 401) {
    token = await getAccessToken(jar, true);
    if (token) response = await currentUser(token);
  }
  if (!response.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(await response.json(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const rejected = rejectForeignRequest(request);
  if (rejected) return rejected;
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "invalid_request" }, { status: 415 });
  }
  const input = await readCredentials(request);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const body = input as Record<string, unknown>;
  if (body.action === "reset_password") {
    if (typeof body.username !== "string" || typeof body.code !== "string" || typeof body.password !== "string") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    return forwardAccountRequest("/v1/auth/password-reset", {
      username: body.username, code: body.code, password: body.password,
    });
  }
  if (body.action === "recovery_codes") {
    if (typeof body.password !== "string") return Response.json({ error: "invalid_request" }, { status: 400 });
    const token = await getAccessToken(await cookies());
    if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
    return forwardAccountRequest("/v1/auth/recovery-codes", { password: body.password }, token);
  }
  if (body.action === "change_password") {
    if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const jar = await cookies();
    const token = await getAccessToken(jar);
    if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
    const response = await forwardAccountRequest("/v1/auth/password", {
      currentPassword: body.currentPassword, newPassword: body.newPassword,
    }, token);
    if (response.status === 204) clearSession(jar);
    return response;
  }
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
  if (body.action === "register") {
    payload.displayName = typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim() : body.username;
  }
  const endpoint = body.action === "register" ? "register" : "login";
  const response = await fetch(backendUrl(`/v1/auth/${endpoint}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({ error: "service_unavailable" })) as Record<string, unknown>;
  if (!response.ok) {
    const headers = new Headers({ "Cache-Control": "no-store" });
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    return Response.json(data, { status: response.status, headers });
  }
  if (typeof data.accessToken !== "string" || typeof data.refreshToken !== "string" ||
      typeof data.accessExpiresAt !== "string" || typeof data.refreshExpiresAt !== "string") {
    return Response.json({ error: "invalid_session_response" }, { status: 502 });
  }
  saveSession(await cookies(), data as unknown as SessionPayload);
  return Response.json(data.user, { status: response.status, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
  const rejected = rejectForeignRequest(request);
  if (rejected) return rejected;
  const jar = await cookies();
  const token = await getAccessToken(jar);
  if (new URL(request.url).searchParams.get("account") === "1") {
    if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
    const input = await readCredentials(request) as { username?: unknown; password?: unknown } | null;
    if (typeof input?.username !== "string" || typeof input.password !== "string") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const response = await forwardAccountRequest("/v1/auth/account", {
      username: input.username, password: input.password,
    }, token, "DELETE");
    if (response.status === 204) clearSession(jar);
    return response;
  }
  const signOutEverywhere = new URL(request.url).searchParams.get("all") === "1";
  if (signOutEverywhere && !token) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (token) {
    const response = await fetch(backendUrl(signOutEverywhere ? "/v1/auth/logout-all" : "/v1/auth/logout"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!response || (!response.ok && (signOutEverywhere || response.status !== 401))) {
      return Response.json({ error: "sign_out_failed" }, { status: response?.status === 401 ? 401 : 502 });
    }
  }
  clearSession(jar);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
