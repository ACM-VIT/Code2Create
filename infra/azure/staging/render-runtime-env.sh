#!/usr/bin/env bash
set -euo pipefail

umask 077

C2C_VAULT_NAME="kv-c2c-stg-b88416"
C2C_POSTGRES_HOST="pg-c2c-stg-b88416.postgres.database.azure.com"
C2C_RUNTIME_DIR="/srv/code2create"

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
C2C_INSTANCE_SECRET="$(read_secret convex-instance-secret)"
C2C_ENV_FILE="$(mktemp)"

cleanup() {
  rm -f "${C2C_ENV_FILE}"
}
trap cleanup EXIT

cat >"${C2C_ENV_FILE}" <<EOF
INSTANCE_NAME=code2create-staging
INSTANCE_SECRET=${C2C_INSTANCE_SECRET}
POSTGRES_URL=postgresql://c2cadmin:${C2C_POSTGRES_PASSWORD}@${C2C_POSTGRES_HOST}:5432
CONVEX_CLOUD_ORIGIN=https://realtime-staging.c2c.sh
CONVEX_SITE_ORIGIN=https://api-staging.c2c.sh
NEXT_PUBLIC_DEPLOYMENT_URL=https://realtime-staging.c2c.sh
DISABLE_BEACON=false
DISABLE_METRICS_ENDPOINT=true
REDACT_LOGS_TO_CLIENT=true
RUST_LOG=info
EOF

install -o root -g root -m 0600 "${C2C_ENV_FILE}" "${C2C_RUNTIME_DIR}/.env"
