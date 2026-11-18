#!/bin/sh
set -eu
# The official PostgreSQL entrypoint runs this only for an empty project volume.
export API_ROLE_PASSWORD="$(cat /run/secrets/db_api_password)"
psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv api_password API_ROLE_PASSWORD
CREATE ROLE messaging_api LOGIN PASSWORD :'api_password';
GRANT CONNECT ON DATABASE messaging TO messaging_api;
GRANT USAGE ON SCHEMA public TO messaging_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO messaging_api;
SQL
