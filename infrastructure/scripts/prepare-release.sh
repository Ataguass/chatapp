#!/usr/bin/env bash
# Run from a dedicated application checkout with the messaging service credentials.
# This command applies pending migrations to the configured database.
set -euo pipefail
cd "$(dirname "$0")/../.."
pnpm install --frozen-lockfile --prod=false
pnpm db:validate
pnpm generate
pnpm build
pnpm test
pnpm db:deploy
pnpm db:status
