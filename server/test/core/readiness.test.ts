import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createReadiness } from "../../src/infrastructure/readiness.ts";

const succeeds = async () => {};
test("both dependencies must pass and recovery is observed on the next check", async () => {
  let cacheUp = false;
  const transitions: string[] = [];
  const health = createReadiness({ postgresql: succeeds, redis: async () => {
    if (!cacheUp) throw new Error("connection lost");
  } }, 100, (name, ok) => transitions.push(name + "=" + ok));
  assert.equal(await health.ready(), false);
  assert.equal(await health.ready(), false);
  cacheUp = true;
  assert.equal(await health.ready(), true);
  assert.deepEqual(transitions, ["postgresql=true", "redis=false", "redis=true"]);
});

test("concurrent HTTP readiness requests share dependency work", async () => {
  const gate = Promise.withResolvers<void>();
  let queries = 0;
  const health = createReadiness({ postgresql: () => { queries++; return gate.promise; }, redis: succeeds }, 150);
  const requests = Array.from({ length: 20 }, () => health.ready());
  gate.resolve();
  assert.deepEqual(await Promise.all(requests), Array(20).fill(true));
  assert.equal(queries, 1);
});

test("a blocked probe times out and polling cannot multiply the outstanding query", async () => {
  const gate = Promise.withResolvers<void>();
  let probes = 0;
  const health = createReadiness({ postgresql: () => { probes++; return gate.promise; }, redis: succeeds }, 15);
  assert.equal(await health.ready(), false);
  assert.equal(await health.ready(), false);
  assert.equal(probes, 1);
  gate.resolve();
  await setImmediate();
  assert.equal(await health.ready(), true);
  assert.equal(probes, 2);
});

test("a failing SQL probe makes the instance unavailable", async () => {
  const health = createReadiness({ postgresql: async () => { throw new Error("missing table"); }, redis: succeeds }, 100);
  assert.equal(await health.ready(), false);
});

test("shutdown changes in-flight and future readiness results", async () => {
  const gate = Promise.withResolvers<void>();
  const health = createReadiness({ postgresql: () => gate.promise, redis: succeeds }, 150);
  const inFlight = health.ready();
  health.drain();
  assert.equal(await health.ready(), false);
  gate.resolve();
  assert.equal(await inFlight, false);
});
