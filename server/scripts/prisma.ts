import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readConnection } from "../src/config/settings.ts";

const commands: Record<string, string[]> = {
  generate: ["generate"],
  validate: ["validate"],
  dev: ["migrate", "dev"],
  deploy: ["migrate", "deploy"],
  status: ["migrate", "status"],
  diff: ["migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma",
    "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"],
};

function run() {
  const action = process.argv[2];
  if (!Object.hasOwn(commands, action)) throw new Error("Unknown Prisma operation");
  if (action === "dev" && process.env.NODE_ENV === "production") throw new Error("Development migration requested in production");
  const migration = !["generate", "validate"].includes(action);
  const separate = process.env.MIGRATION_DATABASE_URL || process.env.MIGRATION_DATABASE_URL_FILE;
  const key = migration && separate ? "MIGRATION_DATABASE_URL" : "DATABASE_URL";
  const databaseUrl = readConnection(process.env, key);
  const manifest = createRequire(import.meta.url).resolve("prisma/package.json");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  const cli = resolve(dirname(manifest), typeof bin === "string" ? bin : bin.prisma);
  const result = spawnSync(process.execPath, [cli, ...commands[action], ...process.argv.slice(3)], {
    stdio: "inherit", env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return result.status ?? 1;
}
try { process.exitCode = run(); }
catch (error) {
  const safe = error instanceof Error && /^(Missing |Invalid |Set exactly |Unable to read |Development migration|Unknown Prisma)/.test(error.message);
  console.error(safe ? (error as Error).message : "Prisma CLI unavailable");
  process.exitCode = 1;
}
