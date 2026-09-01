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

export CONVEX_SELF_HOSTED_URL="https://realtime.c2c.sh"
export CONVEX_SELF_HOSTED_ADMIN_KEY="$(read_secret convex-admin-key)"
export CONVEX_DEPLOYMENT=""

cat >"${C2C_ENV_FILE}" <<EOF
C2C_DEPLOYMENT_ENVIRONMENT=production
AUTH_SITE_URL=https://api.c2c.sh
PARTICIPANT_SITE_URL=https://c2c.sh
OPERATIONS_SITE_URL=https://ops.c2c.sh
BETTER_AUTH_SECRET=$(read_secret better-auth-secret)
GOOGLE_CLIENT_ID=$(read_secret google-client-id)
GOOGLE_CLIENT_SECRET=$(read_secret google-client-secret)
INITIAL_SUPREME_EMAILS=technicaldirector.acmvit@gmail.com
INITIAL_EVENT_SLUG=code2create-7
OPENAI_API_KEY=$(read_secret openai-api-key)
NOVELTY_GLOBAL_REQUESTS_PER_MINUTE=1800
NOVELTY_INDEX_REQUESTS_PER_MINUTE=300
GITHUB_APP_ID=$(read_secret github-app-id)
GITHUB_APP_SLUG=code2create-7-0
GITHUB_APP_CLIENT_ID=$(read_secret github-app-client-id)
GITHUB_APP_CLIENT_SECRET=$(read_secret github-app-client-secret)
GITHUB_WEBHOOK_SECRET=$(read_secret github-webhook-secret)
PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION=production-v1
PROVIDER_TOKEN_ENCRYPTION_KEY=$(read_secret provider-token-encryption-key)
INTELLIGENCE_WORKER_URL=https://intelligence.c2c.sh
INTELLIGENCE_INGRESS_SECRET=$(read_secret intelligence-ingress-secret)
INTELLIGENCE_CALLBACK_SECRET=$(read_secret intelligence-callback-secret)
INTELLIGENCE_READ_SECRET=$(read_secret intelligence-read-secret)
INTELLIGENCE_STREAM_SECRET=$(read_secret intelligence-stream-secret)
ATTENDANCE_WRAPPING_KEY_VERSION=production-v1
ATTENDANCE_WRAPPING_KEY=$(read_secret attendance-wrapping-key)
EMAIL_EVENT_CALLBACK_SECRET=$(read_secret email-event-callback-secret)
OUTBOUND_CALL_WORKER_URL=https://voice.c2c.sh
OUTBOUND_CALL_REQUEST_SECRET=$(read_secret outbound-call-request-secret)
OUTBOUND_CALL_EVENT_SECRET=$(read_secret outbound-call-event-secret)
EOF

(
  cd "${C2C_REPOSITORY_ROOT}/apps/backend"
  pnpm exec convex env set --from-file "${C2C_ENV_FILE}" --force
)

echo "Configured the production Convex environment. No event or application window was changed."
