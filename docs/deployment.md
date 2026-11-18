# Deploying the foundation

## Obtain the host inventory

Run `bash infrastructure/scripts/oracle-inventory.sh` over the usual SSH session. It reports CPU architecture and count, RAM, swap, root disk capacity, Docker and Compose versions, container names, ports and disk usage. Port listings distinguish occupied public ports from free loopback bindings. The command reads the host and does not change application state.

Review who owns ports 80 and 443, the current reverse-proxy site configuration, available memory and free disk space. Record the existing n8n and Hermes health and routing before choosing limits for the messaging stack. Keep credentials and private hostnames out of any shared output.

## Compose deployment on ARM64

The repository's Compose file creates the `messaging-foundation` project. It runs PostgreSQL, an ephemeral Redis cache, one migration job and the API. Only the API publishes a host port, on loopback. Persistent database and media volumes belong to this project. Docker rotates each service's logs at 5 MB with two files. Budget disk for the database, media, backups and future image updates as well as the initial image layers.

### Build away from the VPS

The **ARM64 Compose** workflow runs on an ARM64 GitHub-hosted runner. It builds and boots the stack, tests migrations and probes both HTTP endpoints. After merging, use **Actions → ARM64 Compose → Run workflow** on the intended revision to export the tested image as an artifact. The artifact name ends with the full Git commit SHA. Keep the checkout, image and Compose file at that same revision.

Download the artifact to your workstation and unzip it there. Transfer the image using an SSH account with existing Docker access. Streaming avoids keeping a second image archive on the server. Replace the SSH destination with your usual login.

```bash
gzip -dc messaging-api-arm64.tar.gz | ssh YOUR_SSH_DESTINATION docker image load
```

Alternatively build on another ARM64 machine with `docker build -f infrastructure/docker/Dockerfile -t messaging-api:$(git rev-parse HEAD) .` and transfer using `docker image save`. The Compose file expects the application image to have already been loaded into the target Docker daemon.

### Start on the selected host

1. Use the host inventory and the existing Docker operator's `docker system df` to assess capacity on the filesystem containing Docker's data directory. Check published ports with `docker ps` and TCP listeners with `ss -lnt`. Use the existing administrative session to inspect the proxy, volumes and project names. Confirm the new project name is unused on first deployment. The API port defaults to 4080 and can be changed with `MESSAGING_API_PORT`.
2. From the matching Git checkout, run the commands below after checking disk headroom. The two vendor images are pulled only if missing. The database is initialized with a dedicated bootstrap account, and migrations run under that account. The HTTP service receives its own read-only database login. Future write endpoints need explicit grants.
3. Keep the generated credentials together with the database backup. The initialization script reuses an existing set. Restoring the data volume requires its matching credentials.

```bash
export MESSAGING_IMAGE="messaging-api:$(git rev-parse HEAD)"
export MESSAGING_API_PORT=4080
python3 infrastructure/scripts/init-compose-secrets.py
docker compose config -q
docker image inspect "$MESSAGING_IMAGE" --format '{{.Architecture}} {{.Size}} bytes'
docker compose up -d --wait --wait-timeout 150
bash infrastructure/scripts/check-deployment.sh "http://127.0.0.1:$MESSAGING_API_PORT"
```

For native development or deployment, `bash infrastructure/scripts/prepare-release.sh` installs locked dependencies, generates Prisma, builds, tests and migrates the configured PostgreSQL database. See the [local setup](../README.md#start-locally) for its configuration.

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

Oracle acceptance requires running these checks on the selected VPS and confirming its public HTTPS route with the existing proxy operator.
