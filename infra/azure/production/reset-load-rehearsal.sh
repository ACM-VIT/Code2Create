#!/usr/bin/env bash
set -euo pipefail

umask 077

C2C_LOAD_RUNTIME_DIR="/srv/code2create-load-20260902"
C2C_VAULT_NAME="kv-c2c-prod-b88416"
C2C_POSTGRES_HOST="pg-c2c-prod-b88416.postgres.database.azure.com"
C2C_POSTGRES_DATABASE="code2create_production_load_20260902"
C2C_POSTGRES_CLIENT_IMAGE="postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
C2C_CONTAINER_NAME="c2c-load-backend"

C2C_ACCESS_TOKEN="$({
  curl --fail --silent --show-error \
    --header 'Metadata: true' \
    'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net'
} | jq --raw-output '.access_token')"

read_secret() {
  local secret_name="$1"
  curl --fail --silent --show-error \
    --header "Authorization: Bearer ${C2C_ACCESS_TOKEN}" \
    "https://${C2C_VAULT_NAME}.vault.azure.net/secrets/${secret_name}?api-version=7.4" \
    | jq --raw-output '.value'
}

C2C_POSTGRES_PASSWORD="$(read_secret postgres-app-password)"

if docker container inspect "${C2C_CONTAINER_NAME}" >/dev/null 2>&1; then
  docker rm --force "${C2C_CONTAINER_NAME}" >/dev/null
fi

docker run --rm \
  --network code2create-production_default \
  --env "PGPASSWORD=${C2C_POSTGRES_PASSWORD}" \
  "${C2C_POSTGRES_CLIENT_IMAGE}" \
  psql \
    "host=${C2C_POSTGRES_HOST} port=5432 dbname=postgres user=c2cadmin sslmode=require connect_timeout=10" \
    --set ON_ERROR_STOP=1 \
    --command "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${C2C_POSTGRES_DATABASE}' AND pid <> pg_backend_pid();" \
    --command "DROP DATABASE IF EXISTS ${C2C_POSTGRES_DATABASE};"

if [[ -d "${C2C_LOAD_RUNTIME_DIR}/data" ]]; then
  find "${C2C_LOAD_RUNTIME_DIR}/data" -mindepth 1 -delete
fi

echo "The isolated load database and local state were removed."
