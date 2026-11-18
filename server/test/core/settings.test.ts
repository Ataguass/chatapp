import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConnection, settings } from "../../src/config/settings.ts";

const valid = { DATABASE_URL: "postgresql://user:pw@localhost/chat", REDIS_URL: "redis://localhost:6379" };

test("local defaults use loopback and explicit service URLs", () => {
  const config = settings(valid);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4080);
  assert.equal(config.deadline, 1500);
  assert.equal(config.databaseUrl, valid.DATABASE_URL);
});

test("bounds and numeric syntax are checked at startup", () => {
  for (const port of ["", "0", "65536", "3.4", "8e1", " 80", "-1"]) {
    assert.throws(() => settings({ ...valid, API_PORT: port }), /API_PORT/);
  }
  assert.equal(settings({ ...valid, API_PORT: "65535" }).port, 65535);
  assert.throws(() => settings({ ...valid, HEALTH_TIMEOUT_MS: "49" }), /HEALTH_TIMEOUT_MS/);
  assert.throws(() => settings({ ...valid, API_HOST: "host/path" }), /API_HOST/);
});

test("invalid or missing connection settings fail without returning credentials", () => {
  assert.throws(() => settings({}), /^Error: Missing DATABASE_URL$/);
  for (const value of ["https://user:secret@example.com/chat", "postgres://x", "postgresql://u:CHANGE_ME@localhost/chat"]) {
    assert.throws(() => settings({ ...valid, DATABASE_URL: value }), /^Error: Invalid DATABASE_URL$/);
  }
  assert.throws(() => settings({ ...valid, REDIS_URL: "postgres://secret@x/db" }), /^Error: Invalid REDIS_URL$/);
});

test("production requires service passwords and accepts TLS connection schemes", () => {
  assert.throws(() => settings({ ...valid, NODE_ENV: "production" }), /Invalid REDIS_URL/);
  const secure = settings({ ...valid, REDIS_URL: "rediss://default:a%2Fb@cache:6380", NODE_ENV: "production" });
  assert.match(secure.redisUrl, /^rediss:/);
});

test("mounted secret files ignore trailing newline and reject ambiguous sources", t => {
  const folder = mkdtempSync(join(tmpdir(), "messaging-config-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "url");
  writeFileSync(path, valid.DATABASE_URL + "\n", { mode: 0o600 });
  assert.equal(readConnection({ DATABASE_URL_FILE: path }, "DATABASE_URL"), valid.DATABASE_URL);
  assert.throws(() => readConnection({ ...valid, DATABASE_URL_FILE: path }, "DATABASE_URL"), /exactly one/);
  assert.throws(() => readConnection({ REDIS_URL_FILE: join(folder, "missing") }, "REDIS_URL"), /^Error: Unable to read REDIS_URL_FILE$/);
});
