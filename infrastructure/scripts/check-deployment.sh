#!/usr/bin/env bash
# Run on the host or from outside it with an explicit API origin.
set -euo pipefail
origin=${1:?Usage: check-deployment.sh http[s]://your-api-origin}
origin=${origin%/}
for endpoint in live ready; do
  body=$(curl --fail --silent --show-error --connect-timeout 3 --max-time 6 "$origin/health/$endpoint")
  python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin) == {"status": sys.argv[1]} else 1)' "$endpoint" <<<"$body"
  printf '%s passed\n' "$endpoint"
done
