import { cookies } from "next/headers";
import { backendUrl, clearSession, getAccessToken } from "@/lib/server-auth";

export async function GET(request: Request) {
  const jar = await cookies();
  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  const accessToken = await getAccessToken(jar, forceRefresh);
  if (!accessToken) return Response.json({ error: "unauthorized" }, { status: 401 });
  const response = await fetch(backendUrl("/v1/auth/me"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) {
    clearSession(jar);
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json({ accessToken, accessExpiresAt: Number(jar.get("chat_access_expiry")?.value ?? 0) }, {
    headers: { "Cache-Control": "no-store" },
  });
}
