#!/usr/bin/env bash
set -euo pipefail

umask 077

C2C_VAULT_NAME="kv-c2c-prod-b88416"
C2C_POSTGRES_HOST="pg-c2c-prod-b88416.postgres.database.azure.com"
C2C_RUNTIME_DIR="/srv/code2create"
C2C_R2_ACCOUNT_ID="4ee36e42cabfd44e8ce61b2a6bd637c5"

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
C2C_POSTGRES_PASSWORD_URI="$(
  jq --null-input --raw-output --arg password "${C2C_POSTGRES_PASSWORD}" '$password | @uri'
)"
C2C_INSTANCE_SECRET="$(read_secret convex-instance-secret)"
C2C_R2_ACCESS_KEY_ID="$(read_secret r2-access-key-id)"
C2C_R2_SECRET_ACCESS_KEY="$(read_secret r2-secret-access-key)"
C2C_ENV_FILE="$(mktemp)"

cleanup() {
  rm -f "${C2C_ENV_FILE}"
}
trap cleanup EXIT

cat >"${C2C_ENV_FILE}" <<EOF
INSTANCE_NAME=code2create-production
INSTANCE_SECRET=${C2C_INSTANCE_SECRET}
POSTGRES_URL=postgresql://c2cadmin:${C2C_POSTGRES_PASSWORD_URI}@${C2C_POSTGRES_HOST}:5432
CONVEX_CLOUD_ORIGIN=https://realtime.c2c.sh
CONVEX_SITE_ORIGIN=https://api.c2c.sh
NEXT_PUBLIC_DEPLOYMENT_URL=https://realtime.c2c.sh
AWS_REGION=auto
AWS_ACCESS_KEY_ID=${C2C_R2_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${C2C_R2_SECRET_ACCESS_KEY}
S3_ENDPOINT_URL=https://${C2C_R2_ACCOUNT_ID}.r2.cloudflarestorage.com
S3_STORAGE_EXPORTS_BUCKET=code2create-convex-production-exports
S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET=code2create-convex-production-imports
S3_STORAGE_MODULES_BUCKET=code2create-convex-production-modules
S3_STORAGE_FILES_BUCKET=code2create-convex-production-files
S3_STORAGE_SEARCH_BUCKET=code2create-convex-production-search
DISABLE_BEACON=true
DISABLE_METRICS_ENDPOINT=true
REDACT_LOGS_TO_CLIENT=true
MAX_BYTES_WRITTEN_PER_SECOND=16777216
APPLICATION_MAX_CONCURRENT_QUERIES=512
APPLICATION_MAX_CONCURRENT_MUTATIONS=256
APPLICATION_MAX_CONCURRENT_NODE_ACTIONS=100
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=100
APPLICATION_MAX_CONCURRENT_UPLOADS=16
ANALYZE_CONCURRENCY=24
RUST_LOG=info
EOF

install -o root -g root -m 0600 "${C2C_ENV_FILE}" "${C2C_RUNTIME_DIR}/.env"
