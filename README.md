# Messaging platform

The backend foundation includes username/password authentication, profiles and discovery, user blocking, direct and private group conversations, invitation links, persistent messaging with private media attachments, basic FCM push notifications, read receipts, replies, reactions, edits and soft deletion. The server listens on loopback by default; Docker publishes it only on host loopback behind the existing Caddy proxy.

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

## Web chat app

The Next.js App Router client lives in `apps/web`. It includes account registration and login, conversation search, direct chats, group creation, live text messaging, and private attachment uploads. Its same-origin API routes keep access and refresh tokens in HTTP-only cookies; Socket.IO receives a short-lived access token only in memory. Copy `apps/web/.env.example` to `apps/web/.env.local`, then run `pnpm install --frozen-lockfile` and `pnpm dev:web`. The backend must be running at `http://127.0.0.1:4080`, with `http://127.0.0.1:3000` allowed in `SOCKET_ALLOWED_ORIGINS`. On a local development machine, use the Docker Compose stack described in [Deployment](docs/deployment.md) to provide the API, PostgreSQL and Redis.

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
| `server/src/modules/auth` | Password hashing, token sessions and authentication routes |
| `server/src/modules/users` | Profiles, username search and user blocking |
| `server/src/modules/conversations` | Direct and group conversation creation, membership, roles and invitation links |
| `server/src/modules/messages` | Text and media messages, private attachment storage, read receipts, replies, reactions, edits and deletion |
| `apps/web` | Next.js browser client and same-origin authenticated API proxy |
| `server/prisma` | PostgreSQL schema and transactional migrations for identity, conversations, messaging and group invites |
| `server/test` | Core, HTTP and service integration tests |
| `packages/shared-types` | Shared health, account, conversation, group and message contracts |
| `infrastructure/caddy` | Isolated API site block for review with the existing proxy configuration |
| `infrastructure/scripts` | Read-only Oracle inventory, release preparation and deployment checks |
| `.github/workflows` | CI for the foundation |

## MVP API

See [API contracts](docs/api.md) for authentication, profile, conversation and message endpoints.

## Cost policy

Keep the MVP on free tiers and the existing VPS. Firebase Cloud Messaging is the free-first push provider for Android and web; defer iOS remote push until an Apple Developer account is available. Do not add paid services or upgrade Firebase billing without discussing it first.

## Oracle handoff

The inventory script can be rerun on the VPS before deployment or after host changes.

```bash
bash infrastructure/scripts/oracle-inventory.sh
```

The inventory has been reviewed. The Compose manifest, resource budgets and proxy integration are documented in [Deployment](docs/deployment.md). Local verification results are in [Verification](docs/verification.md).

The isolated [Docker Compose deployment](docs/deployment.md#compose-deployment) uses a private PostgreSQL/Redis pair and exposes only the API on host loopback for the existing Caddy proxy. It has not been deployed to the VPS.
