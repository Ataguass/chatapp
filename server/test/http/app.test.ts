import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { createApp } from "../../src/app.ts";

async function listening(t: TestContext, ready: () => Promise<boolean>) {
  const logs: unknown[] = [];
  const app = createApp(ready, (event, fields) => logs.push({ event, fields }));
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  return { url: "http://127.0.0.1:" + (server.address() as AddressInfo).port, logs };
}

test("live remains available during dependency failure and ready returns 503", async t => {
  const { url } = await listening(t, async () => false);
  const live = await fetch(url + "/health/live");
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "live" });
  const ready = await fetch(url + "/health/ready");
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { status: "unavailable" });
});

test("healthy instance returns noncacheable readiness and a server-generated request ID", async t => {
  const { url } = await listening(t, async () => true);
  const result = await fetch(url + "/health/ready", { headers: { "X-Request-Id": "untrusted" } });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: "ready" });
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.match(result.headers.get("x-request-id")!, /^[a-f0-9-]{36}$/);
});

test("unknown paths, query strings and authorization headers stay out of logs", async t => {
  const { url, logs } = await listening(t, async () => true);
  const result = await fetch(url + "/groups/join/private-invite?q=private-username",
    { headers: { Authorization: "Bearer private-token" } });
  assert.equal(result.status, 404);
  assert.deepEqual(await result.json(), { error: "not_found" });
  assert.match(JSON.stringify(logs), /unmatched/);
  assert.doesNotMatch(JSON.stringify(logs), /private-/);
});

test("unexpected health errors produce a generic JSON response", async t => {
  const { url } = await listening(t, async () => { throw new Error("sensitive internal data"); });
  const result = await fetch(url + "/health/ready");
  assert.equal(result.status, 500);
  assert.deepEqual(await result.json(), { error: "internal_error" });
});
