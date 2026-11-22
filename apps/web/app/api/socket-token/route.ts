import { cookies } from "next/headers";
import { backendUrl, clearSession, getAccessToken } from "@/lib/server-auth";

export async function GET() {
  const jar = await cookies();
  const accessToken = await getAccessToken(jar);
  if (!accessToken) return Response.json({ error: "unauthorized" }, { status: 401 });
  const response = await fetch(backendUrl("/v1/auth/me"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) {
    clearSession(jar);
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json({ accessToken }, { headers: { "Cache-Control": "no-store" } });
}
