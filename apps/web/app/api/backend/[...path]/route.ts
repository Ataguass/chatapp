import { cookies } from "next/headers";
import { clearSession, getAccessToken } from "@/lib/server-auth";

const apiUrl = () => (process.env.MESSAGING_API_URL ?? "http://127.0.0.1:4080").replace(/\/$/, "");
const forwardedHeaders = [
  "content-type", "x-file-name", "x-client-message-id", "x-reply-to-message-id", "x-message-text", "content-encoding",
];

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (!path?.length || path.some(part => part === "." || part === "..")) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const jar = await cookies();
  const accessToken = await getAccessToken(jar);
  if (!accessToken) return Response.json({ error: "unauthorized" }, { status: 401 });

  const headers = new Headers({ Authorization: `Bearer ${accessToken}` });
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const method = request.method.toUpperCase();
  const init: RequestInit & { duplex?: "half" } = { method, headers, cache: "no-store", signal: request.signal };
  if (method !== "GET" && method !== "HEAD") {
    if (request.headers.get("content-type")?.includes("application/json")) {
      init.body = await request.text();
    } else if (request.body) {
      init.body = request.body;
      init.duplex = "half";
    }
  }
  const target = `${apiUrl()}/v1/${path.map(encodeURIComponent).join("/")}${new URL(request.url).search}`;
  const upstream = await fetch(target, init);
  if (upstream.status === 401) clearSession(jar);
  const responseHeaders = new Headers();
  for (const name of ["content-type", "content-length", "content-disposition", "cache-control", "x-content-type-options"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
