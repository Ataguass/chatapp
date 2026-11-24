import { cookies } from "next/headers";
import { getAccessToken } from "@/lib/server-auth";
import { rejectForeignRequest } from "@/lib/request-origin";

const apiUrl = () => (process.env.MESSAGING_API_URL ?? "http://127.0.0.1:4080").replace(/\/$/, "");
const forwardedHeaders = [
  "content-type", "x-file-name", "x-client-message-id", "x-reply-to-message-id", "x-message-text", "content-encoding", "range",
];
const proxiedResources = new Set(["conversations", "users", "push", "stories", "media", "calls", "reports", "admin"]);

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const rejected = rejectForeignRequest(request);
  if (rejected) return rejected;
  const { path } = await context.params;
  if (!path?.length || !proxiedResources.has(path[0]) || path.some(part => part === "." || part === ".." || /[\\/]/.test(part))) {
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
  const init: RequestInit & { duplex?: "half" } = { method, headers, cache: "no-store", signal: request.signal, redirect: "error" };
  if (method !== "GET" && method !== "HEAD" && request.body) {
    init.body = request.body;
    init.duplex = "half";
    const contentLength = request.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);
  }
  const target = `${apiUrl()}/v1/${path.map(encodeURIComponent).join("/")}${new URL(request.url).search}`;
  const upstream = await fetch(target, init);
  const responseHeaders = new Headers();
  for (const name of ["content-type", "content-length", "content-disposition", "cache-control", "x-content-type-options",
    "accept-ranges", "content-range"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("Cache-Control", "no-store");
  // An early size rejection may leave unread body bytes on the incoming HTTP connection.
  if (upstream.status === 413) responseHeaders.set("Connection", "close");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
