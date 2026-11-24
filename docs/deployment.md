# Deploying Chatapp

## Private web beta

Use a dedicated release directory and the Compose project `chatapp-beta`. The web container listens on host loopback at `127.0.0.1:4300`, the API at `127.0.0.1:4080`, and the database and Redis stay on the Compose network. The public Caddy site serves the web app and forwards `/socket.io/` to the API on the same origin. Its browser password protects both paths, in addition to individual Chatapp accounts.

In the release directory, create an ignored `.env.beta` with `CHAT_WEB_ORIGIN` set to the exact HTTPS URL. On a fresh release with its own empty `secrets/` directory, run:

```bash
bash infrastructure/scripts/create-compose-secrets.sh
compose=(docker compose --env-file .env.beta -p chatapp-beta -f docker-compose.yml -f docker-compose.beta.yml)
"${compose[@]}" config --quiet
"${compose[@]}" build api web
"${compose[@]}" up -d --wait postgres redis
"${compose[@]}" run --rm --no-deps api pnpm db:deploy
"${compose[@]}" up -d --no-build --wait api web
curl -fsS http://127.0.0.1:4080/health/ready
curl -fsS http://127.0.0.1:4300/ -o /dev/null
```

Render the beta site block with `bash infrastructure/scripts/render-chatapp-beta-caddy.sh HOST BETA_USERNAME HASH_FILE`. `HOST` is the hostname or public IPv4 address without `https://`. `HASH_FILE` contains only a bcrypt hash from `caddy hash-password`. A public IPv4 address uses Let's Encrypt's short-lived IP certificates. A DNS hostname uses Caddy's normal certificate automation. Keep the beta password private. The production runtime has no extra public HTTP API origin to configure.

Before activating the beta, back up the existing Caddy configuration and validate the merged full configuration with the running Caddy version. The existing server bind mounts its Caddyfile as a single file. Preserve its inode when applying an approved edit so reloads and container restarts read the new contents. After reloading, verify TLS with normal certificate validation, check unauthenticated web and socket requests return `401`, and sign in with a beta account to check live delivery. Confirm that n8n and both Hermes units still work. If activation fails, restore the Caddyfile backup in place and reload it. [Caddy HTTPS documentation](https://caddyserver.com/docs/automatic-https) · [Let's Encrypt IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)

### Optional backend services

The private beta can run on PostgreSQL and Redis with the optional services disabled. Enable Firebase message notifications by mounting the service-account JSON read-only in the API and setting `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_FILE` to the project and the path inside the container. The worker runs with the API and PostgreSQL retains pending notifications during restarts.

For a configured Coturn deployment, mount the shared secret as a separate read-only file and set `CALL_TURN_SECRET_FILE` to its in-container path. Set `CALL_ICE_URLS` to the reachable TURN and optional STUN URLs. The API issues short-lived credentials, and the clients obtain them from `/v1/calls/ice`. Validate a relay-only call between separate networks before relying on it. The existing private beta proxy continues to handle HTTPS and Socket.IO.

Set `SYSTEM_ADMIN_USER_IDS` only for accounts entrusted with reports and upload rules. An empty value disables all system administration access. Configure it on the API container.

### Back up and rehearse recovery

Stop the beta web and API before a backup so the database and private media agree. Leave PostgreSQL up. Restart the beta web and API after the script completes, even if it reports an error.

```bash
"${compose[@]}" stop web api
bash infrastructure/scripts/backup-chatapp.sh chatapp-beta "$HOME/chatapp-backups"
"${compose[@]}" up -d --no-build api web
```

The backup contains a PostgreSQL archive, a media archive, and checksums. It will contain sensitive messages and password hashes once people use the app. Keep backup directories private and retain a securely stored copy off the VPS. Retain volume credentials separately. The restore script accepts only a fresh `chatapp-restore-*` project and verifies checksums and empty destinations before restoring:

```bash
restore_project=chatapp-restore-drill
docker image tag chatapp-beta-api "$restore_project-api"
docker compose -p "$restore_project" -f docker-compose.yml up -d --wait postgres
bash infrastructure/scripts/restore-chatapp.sh "$restore_project" /absolute/path/to/backup-directory
```

Use a new restore project on each drill. Check the restored schema, sample messages and attachment bytes before treating the archive as recoverable. The restoration procedure does not overwrite the active database or media volume.

## Compose deployment

The Compose project is isolated from the existing `n8n` and `rideflow` projects. It starts its own PostgreSQL database and Redis cache; it does not attach to, migrate, or publish either existing service. PostgreSQL and Redis have no host port bindings. The API is bound only to `127.0.0.1:4080`, following the existing Caddy container's host-network proxy pattern.

The current VPS inventory showed 2 CPU cores, 11 GiB RAM and 7.9 GiB free disk, with Caddy already using ports 80/443 and other applications using 5432/6379. The Compose services have conservative CPU and memory limits to fit this host. Check free disk before building: the root filesystem was already 83% full. Do not remove Docker images, volumes or containers to make room without identifying their owners and confirming backups.

From the repository root on the VPS:

```bash
bash infrastructure/scripts/create-compose-secrets.sh
docker compose build api
docker compose up -d postgres redis
docker compose run --rm --no-deps api pnpm db:deploy
docker compose up -d api
docker compose ps
```

The secret setup script creates random 256-bit passwords and connection URL files under the ignored `secrets/` directory, with owner-only permissions. Back up these files securely: the database URL and Redis URL are needed to reconnect to the stored data. Never commit or share them. The API image currently includes the workspace toolchain so the same image can run checked-in Prisma migrations; the server process itself starts the compiled API.

For local development, copy the secret script output into the same checkout and use the same Compose commands. The API health check stays unhealthy until both baseline migrations have been applied.

## Existing Caddy integration

Set `CHAT_WEB_ORIGIN` to the exact public HTTPS origin on the production web server. Browser session and proxy mutations require the same origin. Set `API_TRUSTED_PROXY_IPS` only to exact immediate proxy addresses that overwrite untrusted forwarding headers. Otherwise API source limits use the immediate peer IP, so requests from a shared web proxy share a source budget.

The current Caddy container uses host networking and reads `/home/ubuntu/n8n/Caddyfile`. Preserve its existing site blocks. Choose the API hostname after DNS is pointed at the VPS, append the site block from `infrastructure/caddy/messaging-api.caddy` with that literal hostname, then validate before reloading:

```bash
docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

The proxy reaches the API at `127.0.0.1:4080`; no new public listener is created. These commands are instructions only and have not been run on the VPS.

## Refresh the host inventory

The deployment plan uses the inventory already collected for this VPS. Rerun `bash infrastructure/scripts/oracle-inventory.sh` over the usual SSH session before deployment if the host has changed. It reports CPU architecture and count, RAM, swap, root disk capacity, Docker and Compose versions, container names, ports and disk usage. The command reads the host and does not change application state.

Review who owns ports 80 and 443, the current reverse-proxy site configuration, available memory and free disk space. Record the existing n8n and Hermes health and routing before choosing limits for the messaging stack. Keep credentials and private hostnames out of any shared output.

## Release preparation

The native release entry point works on a dedicated application checkout with Node and pnpm installed. It also serves as the build and migration sequence for the future Compose deployment.

1. Configure a dedicated messaging database and Redis endpoint. Set `DATABASE_URL` and `REDIS_URL`, or set `DATABASE_URL_FILE` and `REDIS_URL_FILE` to files containing the complete connection strings. Each setting has a single source. Files may end in a newline.
2. When using separate PostgreSQL roles, supply `MIGRATION_DATABASE_URL` or `MIGRATION_DATABASE_URL_FILE` for DDL. Both roles must point at the same database and public schema. Grant the runtime role schema usage and the table permissions it needs. Readiness requires SELECT on `users` and `messages`.
3. Run `bash infrastructure/scripts/prepare-release.sh`. It applies pending migrations only after the build and unit/HTTP tests succeed. A failed migration stops the script. Inspect Prisma's status and the failed transaction before resolving its history.
4. Start the built API with `pnpm start` under the selected process manager. Use `NODE_ENV=production` and password-bearing database and Redis connection strings. The starting bind address is `127.0.0.1:4080`. Check that the chosen address is free. A container with a private network typically listens on `0.0.0.0` inside the container.
5. Check the origin with `bash infrastructure/scripts/check-deployment.sh http://127.0.0.1:4080`, substituting the chosen port.

## Proxy integration after inventory review

`infrastructure/caddy/messaging-api.caddy` contains one site block. Replace its hostname with the chosen API hostname. The current Caddy container uses host networking, so it can reach the API published on host loopback at `127.0.0.1:4080`.

For an existing Caddy deployment, review the merged configuration and validate it with the same Caddy binary and environment as the running proxy. A different existing proxy can route the hostname to the same private API upstream. Choose DNS, certificate handling and any proxy reload only after inspecting the current setup.

## Oracle acceptance

| Check on the VPS | Expected result |
| --- | --- |
| Container/network/volume inventory | Messaging resources belong to a distinct Compose project |
| `pnpm db:status` against the messaging database | Both baseline migrations applied |
| Both health endpoints through the public HTTPS API domain | HTTP 200 and the expected JSON bodies |
| Simulated messaging Redis outage in a test deployment | Readiness returns 503, liveness stays 200, readiness recovers on reconnect |
| Compare pre/post routing and health for n8n and Hermes | Same routes and healthy services |
| Review published listeners and volumes | PostgreSQL, Redis and future private media are reachable only by intended services |

Before upgrading the private beta, recheck disk space and run the backup drill. Apply checked-in migrations to the Chatapp database only. The standalone public API exposure described above is a separate deployment option. No cloud credentials are included in this repository.
