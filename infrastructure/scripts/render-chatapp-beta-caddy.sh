#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 || ! $1 =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ || $1 != *.* || ! $2 =~ ^[A-Za-z0-9_-]{3,32}$ ]]; then
  echo "Usage: bash $0 HOSTNAME_OR_IPV4 BETA_USERNAME BCRYPT_HASH_FILE" >&2
  exit 2
fi
site=$1
username=$2
hash=$(cat -- "$3")
if [[ ! $hash =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]]; then
  echo 'Expected a bcrypt hash from caddy hash-password.' >&2
  exit 1
fi

root=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
while IFS= read -r line; do
  case $line in
    *CHATAPP_TLS*)
      if [[ $site =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        printf '\ttls {\n\t\tissuer acme {\n\t\t\tdir https://acme-v02.api.letsencrypt.org/directory\n\t\t\tprofile shortlived\n\t\t}\n\t}\n'
      fi ;;
    *)
      line=${line//CHATAPP_SITE/$site}
      line=${line//CHATAPP_BETA_USER/$username}
      line=${line//CHATAPP_BETA_HASH/$hash}
      printf '%s\n' "$line" ;;
  esac
done < "$root/infrastructure/caddy/chatapp-beta.caddy.example"
