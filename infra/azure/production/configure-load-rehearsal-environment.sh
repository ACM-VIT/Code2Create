#!/usr/bin/env bash
set -euo pipefail

umask 077

C2C_VAULT_NAME="kv-c2c-prod-b88416"
C2C_REPOSITORY_ROOT="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
  pwd
)"
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

export CONVEX_SELF_HOSTED_URL="https://realtime-load.c2c.sh"
export CONVEX_SELF_HOSTED_ADMIN_KEY="$(read_secret load-convex-admin-key-20260902)"
export CONVEX_DEPLOYMENT=""

cat >"${C2C_ENV_FILE}" <<EOF
C2C_DEPLOYMENT_ENVIRONMENT=production
AUTH_SITE_URL=https://api-load.c2c.sh
PARTICIPANT_SITE_URL=https://c2c.sh
OPERATIONS_SITE_URL=https://ops.c2c.sh
BETTER_AUTH_SECRET=$(read_secret better-auth-secret)
GOOGLE_CLIENT_ID=$(read_secret google-client-id)
GOOGLE_CLIENT_SECRET=$(read_secret google-client-secret)
INITIAL_SUPREME_EMAILS=load-organizer@example.test
INITIAL_EVENT_SLUG=load-capacity-20260902
OPENAI_API_KEY=$(read_secret openai-api-key)
NOVELTY_GLOBAL_REQUESTS_PER_MINUTE=1800
NOVELTY_INDEX_REQUESTS_PER_MINUTE=300
INTELLIGENCE_WORKER_URL=https://intelligence-load.c2c.sh
INTELLIGENCE_INGRESS_SECRET=$(read_secret load-intelligence-ingress-secret-20260902)
INTELLIGENCE_CALLBACK_SECRET=$(read_secret load-intelligence-callback-secret-20260902)
INTELLIGENCE_READ_SECRET=$(read_secret load-intelligence-read-secret-20260902)
INTELLIGENCE_STREAM_SECRET=$(read_secret load-intelligence-stream-secret-20260902)
EOF

(
  cd "${C2C_REPOSITORY_ROOT}/apps/backend"
  pnpm exec convex env set --from-file "${C2C_ENV_FILE}" --force
)

echo "Configured only the isolated production load-rehearsal environment."
