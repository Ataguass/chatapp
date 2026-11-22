#!/usr/bin/env bash
set -euo pipefail

secret_dir="secrets"
files=(postgres_password redis_password database_url redis_url)

for file in "${files[@]}"; do
  if [[ -e "$secret_dir/$file" ]]; then
    echo "Refusing to overwrite existing $secret_dir/$file" >&2
    exit 1
  fi
done

umask 077
mkdir -p "$secret_dir"
chmod 700 "$secret_dir"

postgres_password=$(openssl rand -hex 32)
redis_password=$(openssl rand -hex 32)

printf '%s' "$postgres_password" > "$secret_dir/postgres_password"
printf '%s' "$redis_password" > "$secret_dir/redis_password"
printf 'postgresql://messaging:%s@postgres:5432/messaging' "$postgres_password" > "$secret_dir/database_url"
printf 'redis://default:%s@redis:6379/0' "$redis_password" > "$secret_dir/redis_url"
chmod 600 "$secret_dir"/*

echo "Created private Compose secrets in $secret_dir/"
