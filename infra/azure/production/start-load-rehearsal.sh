#!/usr/bin/env bash
set -euo pipefail

umask 077

C2C_LOAD_RUNTIME_DIR="/srv/code2create-load-20260902"
C2C_PRODUCTION_RUNTIME_DIR="/srv/code2create"
C2C_VAULT_NAME="kv-c2c-prod-b88416"
C2C_POSTGRES_HOST="pg-c2c-prod-b88416.postgres.database.azure.com"
C2C_POSTGRES_DATABASE="code2create_production_load_20260902"
C2C_POSTGRES_CLIENT_IMAGE="postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
C2C_CONTAINER_NAME="c2c-load-backend"
C2C_IMAGE="ghcr.io/get-convex/convex-backend@sha256:1f2044e3eac463ac78973b136c0baf72d4ada602611d853d6f99f280e29e0a98"

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
C2C_POSTGRES_PASSWORD_URI="$({
  jq --null-input --raw-output --arg password "${C2C_POSTGRES_PASSWORD}" '$password | @uri'
})"
C2C_INSTANCE_SECRET="$(read_secret load-convex-instance-secret-20260902)"
C2C_ORIGIN_CERTIFICATE="$(read_secret cloudflare-origin-certificate)"
C2C_ORIGIN_PRIVATE_KEY="$(read_secret cloudflare-origin-private-key)"
C2C_ENV_FILE="$(mktemp)"
C2C_CERTIFICATE_TEMP_FILE="$(mktemp)"
C2C_PRIVATE_KEY_TEMP_FILE="$(mktemp)"

cleanup() {
  rm -f \
    "${C2C_ENV_FILE}" \
    "${C2C_CERTIFICATE_TEMP_FILE}" \
    "${C2C_PRIVATE_KEY_TEMP_FILE}"
}
trap cleanup EXIT

mkdir -p "${C2C_LOAD_RUNTIME_DIR}/data"
chmod 0700 "${C2C_LOAD_RUNTIME_DIR}" "${C2C_LOAD_RUNTIME_DIR}/data"

C2C_DATABASE_EXISTS="$(
  docker run --rm \
    --network code2create-production_default \
    --env "PGPASSWORD=${C2C_POSTGRES_PASSWORD}" \
    "${C2C_POSTGRES_CLIENT_IMAGE}" \
    psql \
      "host=${C2C_POSTGRES_HOST} port=5432 dbname=postgres user=c2cadmin sslmode=require connect_timeout=10" \
      --no-align \
      --tuples-only \
      --command "SELECT 1 FROM pg_database WHERE datname = '${C2C_POSTGRES_DATABASE}'"
)"
if [[ "${C2C_DATABASE_EXISTS}" != "1" ]]; then
  docker run --rm \
    --network code2create-production_default \
    --env "PGPASSWORD=${C2C_POSTGRES_PASSWORD}" \
    "${C2C_POSTGRES_CLIENT_IMAGE}" \
    psql \
      "host=${C2C_POSTGRES_HOST} port=5432 dbname=postgres user=c2cadmin sslmode=require connect_timeout=10" \
      --set ON_ERROR_STOP=1 \
      --command "CREATE DATABASE ${C2C_POSTGRES_DATABASE}"
fi

cat >"${C2C_ENV_FILE}" <<EOF
INSTANCE_NAME=code2create-production-load-20260902
INSTANCE_SECRET=${C2C_INSTANCE_SECRET}
POSTGRES_URL=postgresql://c2cadmin:${C2C_POSTGRES_PASSWORD_URI}@${C2C_POSTGRES_HOST}:5432
CONVEX_CLOUD_ORIGIN=https://realtime-load.c2c.sh
CONVEX_SITE_ORIGIN=https://api-load.c2c.sh
NEXT_PUBLIC_DEPLOYMENT_URL=https://realtime-load.c2c.sh
DISABLE_BEACON=true
DISABLE_METRICS_ENDPOINT=true
REDACT_LOGS_TO_CLIENT=true
MAX_BYTES_WRITTEN_PER_SECOND=16777216
APPLICATION_MAX_CONCURRENT_QUERIES=512
APPLICATION_MAX_CONCURRENT_MUTATIONS=256
APPLICATION_MAX_CONCURRENT_NODE_ACTIONS=100
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=100
RUST_LOG=info
EOF
install -o root -g root -m 0600 "${C2C_ENV_FILE}" "${C2C_LOAD_RUNTIME_DIR}/.env"

if docker container inspect "${C2C_CONTAINER_NAME}" >/dev/null 2>&1; then
  docker rm --force "${C2C_CONTAINER_NAME}" >/dev/null
fi

docker run --detach \
  --name "${C2C_CONTAINER_NAME}" \
  --restart unless-stopped \
  --stop-signal SIGINT \
  --stop-timeout 30 \
  --ulimit nofile=65536:65536 \
  --network code2create-production_default \
  --env-file "${C2C_LOAD_RUNTIME_DIR}/.env" \
  --mount "type=bind,source=${C2C_LOAD_RUNTIME_DIR}/data,target=/convex/data" \
  "${C2C_IMAGE}" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "${C2C_CONTAINER_NAME}" curl --fail --silent http://127.0.0.1:3210/version >/dev/null; then
    break
  fi
  sleep 2
done
docker exec "${C2C_CONTAINER_NAME}" curl --fail --silent http://127.0.0.1:3210/version >/dev/null

C2C_CADDY_FILE="${C2C_PRODUCTION_RUNTIME_DIR}/Caddyfile"
C2C_CADDY_BACKUP="${C2C_PRODUCTION_RUNTIME_DIR}/Caddyfile.pre-load-20260902"
if [[ ! -f "${C2C_CADDY_BACKUP}" ]]; then
  cp --preserve=mode,ownership,timestamps "${C2C_CADDY_FILE}" "${C2C_CADDY_BACKUP}"
fi
printf '%s\n' "${C2C_ORIGIN_CERTIFICATE}" >"${C2C_CERTIFICATE_TEMP_FILE}"
printf '%s\n' "${C2C_ORIGIN_PRIVATE_KEY}" >"${C2C_PRIVATE_KEY_TEMP_FILE}"
C2C_CADDY_DATA="$(docker volume inspect code2create-production_caddy_data --format '{{.Mountpoint}}')"
install --mode 0644 "${C2C_CERTIFICATE_TEMP_FILE}" "${C2C_CADDY_DATA}/c2c-origin.pem"
install --mode 0600 "${C2C_PRIVATE_KEY_TEMP_FILE}" "${C2C_CADDY_DATA}/c2c-origin-private-key.pem"
cp --preserve=mode,ownership,timestamps "${C2C_CADDY_BACKUP}" "${C2C_CADDY_FILE}"
cat >>"${C2C_CADDY_FILE}" <<'EOF'

realtime-load.c2c.sh {
	tls /data/c2c-origin.pem /data/c2c-origin-private-key.pem
	reverse_proxy c2c-load-backend:3210
}

api-load.c2c.sh {
	tls /data/c2c-origin.pem /data/c2c-origin-private-key.pem
	reverse_proxy c2c-load-backend:3211
}
EOF

if ! docker exec code2create-production-caddy-1 caddy validate --config /etc/caddy/Caddyfile; then
  if [[ -f "${C2C_CADDY_BACKUP}" ]]; then
    cp --preserve=mode,ownership,timestamps "${C2C_CADDY_BACKUP}" "${C2C_CADDY_FILE}"
  fi
  exit 1
fi
docker exec code2create-production-caddy-1 caddy reload --config /etc/caddy/Caddyfile

echo "The isolated load backend is healthy and routed."
