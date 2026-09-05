#!/usr/bin/env bash
set -euo pipefail

umask 077

C2C_VAULT_NAME="kv-c2c-prod-b88416"
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

C2C_DISCORD_BOT_TOKEN="$(read_secret discord-bot-token)"
C2C_DISCORD_BRIDGE_SECRET="$(read_secret discord-support-bridge-secret)"
C2C_ENV_FILE="$(mktemp)"

cleanup() {
  rm -f "${C2C_ENV_FILE}"
}
trap cleanup EXIT

cat >"${C2C_ENV_FILE}" <<EOF
DISCORD_BOT_TOKEN=${C2C_DISCORD_BOT_TOKEN}
DISCORD_GUILD_ID=1411784063571988722
DISCORD_OPEN_CATEGORY_ID=1412182400401936394
DISCORD_CLOSED_CATEGORY_ID=1544633324776067212
DISCORD_ALLOWED_ROLE_IDS=1411787267244032010,1412173230717800538
DISCORD_SUPPORT_BRIDGE_SECRET=${C2C_DISCORD_BRIDGE_SECRET}
CONVEX_SITE_URL=https://api.c2c.sh
OPERATIONS_SITE_URL=https://ops.c2c.sh
C2C_EVENT_SLUG=code2create-7
PORT=8080
EOF

install -o root -g root -m 0600 "${C2C_ENV_FILE}" "${C2C_RUNTIME_DIR}/.discord.env"
