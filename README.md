# Messaging platform

Milestone 1 contains the runnable HTTP service, shared health contract and PostgreSQL migrations for the private messaging platform. The server listens on loopback by default. Its two public routes report liveness and readiness. Product routes and clients begin with the messaging MVP.

## Start locally

Use Node.js 22.18 or newer on the 22.x or 24.x line, pnpm 10.32.1, PostgreSQL 16 and Redis 7. Start with a dedicated PostgreSQL database owned by your development role and a reachable Redis instance. The API uses the PostgreSQL `public` schema.

1. Run `corepack enable` if pnpm is unavailable. From the repository root, run `pnpm install --frozen-lockfile`.
2. Copy `server/.env.example` to `server/.env` and restrict the copy with `chmod 600 server/.env`. Set `DATABASE_URL` and `REDIS_URL` to the credentials of your development services. URL-encode reserved characters in credentials.
3. Run the following commands from the repository root.

```bash
pnpm db:validate
pnpm generate
pnpm db:deploy
pnpm build
pnpm start
```

From a second terminal, run `bash infrastructure/scripts/check-deployment.sh http://127.0.0.1:4080`. The script checks both the HTTP status and response body. Use `pnpm dev` for source watch mode after generating the Prisma client.

## Foundation checks

| Command | What it verifies |
| --- | --- |
| `pnpm test` | Configuration, secret loading, deadlines, concurrency, shutdown readiness, HTTP responses and log redaction |
| `pnpm test:integration` | Redis PING, SQL constraints and concurrent duplicate sends. Run against a disposable, migrated test database. |
| `pnpm db:deploy` | Applies pending checked-in migrations. Safe to rerun on the same schema. |
| `pnpm db:status` | Compares applied migration history with this checkout |
| `pnpm db:drift` | Compares the live schema with the Prisma data model. A nonzero result means a difference or an error. |
| `pnpm db:dev --name change_name` | Creates a new migration using a disposable development database and a role with shadow-database access |
| `bash infrastructure/scripts/prepare-release.sh` | Installs the lockfile, builds, runs unit and HTTP tests, then **applies migrations** to the configured database |

GitHub Actions repeats the build, migrations, real-service tests and smoke checks on an ephemeral runner. It has read-only repository permissions.

## Workspace

| Path | Responsibility |
| --- | --- |
| `server/src` | Express app, settings, database and cache probes, lifecycle and structured logs |
| `server/prisma` | PostgreSQL schema and two transactional baseline migrations |
| `server/test` | Core, HTTP and service integration tests |
| `packages/shared-types` | Health response types shared with future clients |
| `infrastructure/caddy` | Isolated API site block for review with the existing proxy configuration |
| `infrastructure/scripts` | Read-only Oracle inventory, release preparation and deployment checks |
| `.github/workflows` | CI for the foundation |

## Oracle handoff

Run the inventory script on the VPS that hosts n8n and Hermes.

```bash
bash infrastructure/scripts/oracle-inventory.sh
```

The Compose project runs the database, Redis, migrations and API with a loopback port for the existing proxy. Build the ARM64 image off-host using the [deployment instructions](docs/deployment.md). Local verification results are in [Verification](docs/verification.md).
