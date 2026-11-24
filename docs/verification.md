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

GitHub Actions configuration and shell syntax were checked locally during the foundation milestone.

## Backend release verification

The Linux production API and web images built successfully. The backend passed 15 core and HTTP tests and 22 integration tests against disposable PostgreSQL 16 and Redis 7.4 containers.

| Check | Observed result |
| --- | --- |
| Fresh migrations and upgrade from the ten-migration beta schema | All 18 migrations applied. Prisma found no schema drift. |
| Upgrade with an existing chat message | The original ID and position survived. The sync endpoint returned subsequent edits. |
| Device revocation and account changes | Old access and refresh tokens were rejected. Account deletion removed personal records and retained the peer's messages. |
| Groups and reconnect | Invite limits and roles were enforced. Removed members lost history access. Edits, reactions, and personal deletions synchronized. |
| Private media and stories | Tests covered oversize and invalid files, range requests, forwarding, audience checks, blocks and expiry. |
| Notifications and administration | A test transport exercised durable retries. Mutes, read positions and blocks prevented dispatch. Admin routes enforced the configured privilege. |
| Direct calls | Two local WebSocket clients established signaling. Call history was private, and blocking ended the selected call. |
| Compiled web proxy | Secure HttpOnly cookies, device listing, story publishing and password-change cookie clearing passed. |

These checks used local infrastructure. Firebase delivery to a real device and TURN relay between Wi-Fi and cellular clients require separate environment verification.

## Chat UI and calling verification

The production web build was exercised in Chromium at desktop, tablet, 375 px phone, and phone landscape sizes. The browser checks covered sending and replying, forwarding, both deletion scopes, saving a profile, notification preferences, device revocation, group invitation redemption, and publishing a story.

For the direct-call test, each browser ran on its own isolated Docker network. Both fetched short-lived credentials from Chatapp's `/v1/calls/ice` API. With WebRTC forced to use relay candidates, each browser selected a Coturn UDP relay pair and received audio RTP. In the video test, both browsers also decoded video frames. Both calls appeared in call history. A physical phone on cellular data remains a separate test.

### LiveKit capacity sample

LiveKit 1.13.11 ran locally with a two-CPU and 1 GiB container limit. The official LiveKit CLI 2.20.1 ran each VP8 workload for 25 seconds with the 3×3 subscriber layout. CPU and memory peaks below are sampled Docker readings. Throughput is the CLI's combined receive bitrate across subscribers.

| Audio and video publishers | Subscribers | Tracks received | Packet loss | Sampled peak CPU | Sampled peak memory | Subscriber throughput |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | 3 | 18 of 18 | 0% | 21.7% | 80 MiB | 14.0 Mbps |
| 6 | 6 | 72 of 72 | 0% | 39.5% | 115 MiB | 25.4 Mbps |

These measurements come from Docker Desktop on a local x86-64 host. Benchmark the Oracle VPS during normal n8n and Hermes activity before enabling group video there. [LiveKit load-test reference](https://docs.livekit.io/reference/developer-tools/livekit-cli/perf/)
