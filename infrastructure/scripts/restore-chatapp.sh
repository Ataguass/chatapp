#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 || ! $1 =~ ^chatapp-restore-[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Usage: bash $0 chatapp-restore-UNIQUE_ID BACKUP_DIRECTORY" >&2
  exit 2
fi
project=$1
backup=$(cd -- "$2" && pwd -P)
root=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
cd -- "$root"
compose=(docker compose --project-name "$project" -f docker-compose.yml)

for file in database.dump media.tar.gz SHA256SUMS; do
  [[ -f $backup/$file && ! -L $backup/$file ]] || { echo "Missing regular backup file: $file" >&2; exit 1; }
done
(cd -- "$backup" && sha256sum database.dump media.tar.gz | cmp -s - SHA256SUMS) || {
  echo 'Backup checksum verification failed.' >&2; exit 1;
}
tar -tzf "$backup/media.tar.gz" | awk '
  $0 == "./" { next }
  $0 ~ /^\.\/[0123456789abcdef-]+$/ && length($0) == 38 { next }
  { exit 1 }
' || { echo 'Backup contains an unexpected media path.' >&2; exit 1; }
tar -tvzf "$backup/media.tar.gz" | awk '
  substr($1, 1, 1) == "-" { next }
  substr($1, 1, 1) == "d" && $NF == "./" { next }
  { exit 1 }
' || { echo 'Backup contains an unsupported media entry.' >&2; exit 1; }

[[ -z $("${compose[@]}" ps --all --quiet api) ]] || { echo 'Use a fresh restore project without an API container.' >&2; exit 1; }
table_count=$("${compose[@]}" exec -T postgres psql -X -U messaging -d messaging -Atq \
  -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')")
[[ $table_count == 0 ]] || { echo 'The restore database must be empty.' >&2; exit 1; }

"${compose[@]}" run --rm --no-deps -T --entrypoint sh api -ec \
  'test -z "$(ls -A /var/lib/messaging/media)"' </dev/null || { echo 'The restore media volume must be empty.' >&2; exit 1; }
"${compose[@]}" exec -T postgres pg_restore -U messaging -d messaging \
  --exit-on-error --single-transaction --no-owner --no-acl < "$backup/database.dump"
"${compose[@]}" run --rm --no-deps -T --entrypoint tar api \
  --no-same-owner --no-same-permissions -C /var/lib/messaging/media -xzf - < "$backup/media.tar.gz"
printf 'Restored database and media into %s\n' "$project"
