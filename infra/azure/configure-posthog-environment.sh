#!/usr/bin/env bash
set -euo pipefail

umask 077

C2C_ENVIRONMENT="${1:?Pass staging or production.}"
C2C_REPOSITORY_ROOT="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  pwd
)"

case "${C2C_ENVIRONMENT}" in
  staging)
    C2C_VAULT_NAME="kv-c2c-stg-b88416"
    C2C_CONVEX_URL="https://realtime-staging.c2c.sh"
    ;;
  production)
    C2C_VAULT_NAME="kv-c2c-prod-b88416"
    C2C_CONVEX_URL="https://realtime.c2c.sh"
    ;;
  *)
    echo "Environment must be staging or production." >&2
    exit 1
    ;;
esac

C2C_ENV_FILE="$(mktemp)"

cleanup() {
  rm -f "${C2C_ENV_FILE}"
}
trap cleanup EXIT

read_secret() {
  local secret_name="$1"
  az keyvault secret show \
    --vault-name "${C2C_VAULT_NAME}" \
    --name "${secret_name}" \
    --query value \
    --output tsv
}

export CONVEX_SELF_HOSTED_URL="${C2C_CONVEX_URL}"
export CONVEX_SELF_HOSTED_ADMIN_KEY="$(read_secret convex-admin-key)"
export CONVEX_DEPLOYMENT=""

printf 'POSTHOG_PROJECT_TOKEN=%s\nPOSTHOG_HOST=https://i.c2c.sh\n' \
  "$(read_secret posthog-project-token)" >"${C2C_ENV_FILE}"

(
  cd "${C2C_REPOSITORY_ROOT}/apps/backend"
  pnpm exec convex env set --from-file "${C2C_ENV_FILE}" --force
)

echo "Configured ${C2C_ENVIRONMENT} Convex PostHog ingestion."
