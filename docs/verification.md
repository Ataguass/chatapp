# Foundation verification

The source was exercised on Linux x86-64 with Node.js 22.18.0, pnpm 10.32.1, Prisma 6.19.3, PostgreSQL 16.15, Redis 7.4.7 and Caddy 2.10.2. The database and cache used disposable local credentials.

| Check | Observed result |
| --- | --- |
| Frozen dependency install, Prisma validation and client generation | Passed |
| TypeScript compilation | Passed |
| Core and HTTP tests | 14 passed |
| Database and Redis integration tests | 8 passed |
| Six simultaneous inserts with the same client message ID | One message persisted and five duplicates were rejected |
| Fresh PostgreSQL database | Both migrations applied |
| Second migration run / migration status / schema diff | No pending migrations, database up to date, no difference detected |
| API before schema migration | Liveness 200, readiness 503 |
| API with migrated database and authenticated Redis | Liveness and readiness 200 |
| Caddy validation and loopback HTTP proxy | Site block validated and both proxied endpoint bodies matched |
| Stop Redis, then restart it | Liveness 200 throughout the sampled outage, readiness 503 during the outage and 200 after reconnect |
| Stop PostgreSQL, then restart it | Liveness 200 throughout the sampled outage, readiness 503 during the outage and 200 after reconnect |
| SIGTERM after recovery | Clean process exit with status 0 |

GitHub Actions configuration and shell syntax were checked locally. A hosted workflow run, Oracle deployment, public TLS and coexistence checks with n8n and Hermes require their respective environments. The first-release product acceptance tests for registration, message delivery, uploads, devices and push belong to later work in Release 1.
