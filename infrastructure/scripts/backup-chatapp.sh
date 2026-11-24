#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# != 2 || ! $1 =~ ^chatapp-[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Usage: bash $0 chatapp-PROJECT BACKUP_PARENT_DIRECTORY" >&2
  exit 2
fi
project=$1
mkdir -p -- "$2"
backup_parent=$(cd -- "$2" && pwd -P)
root=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
cd -- "$root"
compose=(docker compose --project-name "$project" -f docker-compose.yml)

api_container=$("${compose[@]}" ps --all --quiet api)
if [[ -n $api_container && $(docker inspect --format '{{.State.Running}} {{.State.Restarting}}' "$api_container") != 'false false' ]]; then
  echo "Stop the API for $project before taking a database and media snapshot." >&2
  exit 1
fi

destination="$backup_parent/$project-$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -e $destination ]]; then
  echo "Backup already exists: $destination" >&2
  exit 1
fi
staging=$(mktemp -d "$backup_parent/.chatapp-backup.XXXXXXXX")
trap 'rm -f -- "$staging/database.dump" "$staging/media.tar.gz" "$staging/SHA256SUMS"; rmdir -- "$staging"' EXIT

"${compose[@]}" exec -T postgres pg_dump -U messaging -d messaging --format=custom --no-owner --no-acl > "$staging/database.dump"
"${compose[@]}" run --rm --no-deps -T --entrypoint tar api \
  --exclude='./.*.part' -C /var/lib/messaging/media -czf - . </dev/null > "$staging/media.tar.gz"
[[ -s $staging/database.dump && -s $staging/media.tar.gz ]]
(cd -- "$staging" && sha256sum database.dump media.tar.gz > SHA256SUMS)
mv -T -- "$staging" "$destination"
trap - EXIT
printf 'Backup written to %s\n' "$destination"
