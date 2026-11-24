import { cookies } from "next/headers";
import { backendUrl, getAccessToken } from "@/lib/server-auth";
import { rejectForeignRequest } from "@/lib/request-origin";

async function socketToken(request: Request, forceRefresh: boolean) {
  const rejected = rejectForeignRequest(request);
  if (rejected) return rejected;
  const jar = await cookies();
  const accessToken = await getAccessToken(jar, forceRefresh);
  if (!accessToken) return Response.json({ error: "unauthorized" }, { status: 401 });
  const response = await fetch(backendUrl("/v1/auth/me"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ accessToken, accessExpiresAt: Number(jar.get("chat_access_expiry")?.value ?? 0) }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export const GET = (request: Request) => socketToken(request, false);
export const POST = (request: Request) => socketToken(request, true);
