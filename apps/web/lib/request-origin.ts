function webOrigin(request: Request) {
  const configured = process.env.CHAT_WEB_ORIGIN;
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.origin === configured && url.protocol === "https:") return configured;
    } catch { /* Invalid deployment configuration. */ }
    return null;
  }
  if (process.env.NODE_ENV === "production") return null;
  // Next can normalize the development request URL to localhost. Use the browser's Host for loopback only.
  const host = request.headers.get("host");
  if (!host) return null;
  try {
    const url = new URL(`http://${host}`);
    if (url.host === host && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.origin;
  } catch { /* Malformed Host. */ }
  return null;
}

export function rejectForeignRequest(request: Request) {
  const expected = webOrigin(request);
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const safeMethod = request.method === "GET" || request.method === "HEAD";
  if (!expected || (site && site !== "same-origin") ||
      (origin !== null ? origin !== expected : !safeMethod)) {
    return Response.json({ error: "foreign_request" }, {
      status: 403, headers: { "Cache-Control": "no-store" },
    });
  }
  return null;
}
