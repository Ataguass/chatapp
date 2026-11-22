# Deploying the foundation

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

The Compose configuration is prepared but has not been deployed. Before rollout, recheck disk space, finalize the API hostname and DNS, and follow the acceptance checks above. No cloud credentials are included in this repository.
