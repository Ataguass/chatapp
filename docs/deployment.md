# Deploying the foundation

## Obtain the host inventory

Run `bash infrastructure/scripts/oracle-inventory.sh` over the usual SSH session. It reports CPU architecture and count, RAM, swap, root disk capacity, Docker and Compose versions, container names, ports and disk usage. Port listings distinguish occupied public ports from free loopback bindings. The command reads the host and does not change application state.

Review who owns ports 80 and 443, the current reverse-proxy site configuration, available memory and free disk space. Record the existing n8n and Hermes health and routing before choosing limits for the messaging stack. Keep credentials and private hostnames out of any shared output.

## Release preparation

The native release entry point works on a dedicated application checkout with Node and pnpm installed. It also serves as the build and migration sequence for the future Compose deployment.

1. Configure a dedicated messaging database and Redis endpoint. Set `DATABASE_URL` and `REDIS_URL`, or set `DATABASE_URL_FILE` and `REDIS_URL_FILE` to files containing the complete connection strings. Each setting has a single source. Files may end in a newline.
2. When using separate PostgreSQL roles, supply `MIGRATION_DATABASE_URL` or `MIGRATION_DATABASE_URL_FILE` for DDL. Both roles must point at the same database and public schema. Grant the runtime role schema usage and the table permissions it needs. Readiness requires SELECT on `users` and `messages`.
3. Run `bash infrastructure/scripts/prepare-release.sh`. It applies pending migrations only after the build and unit/HTTP tests succeed. A failed migration stops the script. Inspect Prisma's status and the failed transaction before resolving its history.
4. Start the built API with `pnpm start` under the selected process manager. Use `NODE_ENV=production` and password-bearing database and Redis connection strings. The starting bind address is `127.0.0.1:4080`. Check that the chosen address is free. A container with a private network typically listens on `0.0.0.0` inside the container.
5. Check the origin with `bash infrastructure/scripts/check-deployment.sh http://127.0.0.1:4080`, substituting the chosen port.

## Proxy integration after inventory review

`infrastructure/caddy/messaging-api.caddy` contains one site block. It does not select a production domain or upstream. Set `MESSAGING_API_DOMAIN` to the chosen API hostname and `MESSAGING_API_UPSTREAM` to an address reachable from the actual proxy. Loopback resolves inside the proxy's own network namespace.

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

The Oracle rollout awaits the host inventory, finalized Compose configuration and an authorized deployment session. No cloud credentials are included in this repository.
