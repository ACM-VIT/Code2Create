#!/usr/bin/env bash
set -euo pipefail

umask 077

C2C_VAULT_NAME="kv-c2c-prod-b88416"
C2C_REPOSITORY_ROOT="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
  pwd
)"
C2C_ENV_FILE="$(mktemp)"
C2C_PHONE_VERIFICATION_MESSAGE_TEMPLATE=$'Your Code2Create verification code is {{code}}. It expires in 10 minutes. Do not share it.\n\n@c2c.sh #{{code}}'

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
CONVEX_SITE_URL=https://api.c2c.sh
PARTICIPANT_SITE_URL=https://c2c.sh
OPERATIONS_SITE_URL=https://ops.c2c.sh
BETTER_AUTH_SECRET=$(read_secret better-auth-secret)
GOOGLE_CLIENT_ID=$(read_secret google-client-id)
GOOGLE_CLIENT_SECRET=$(read_secret google-client-secret)
CLOUDFLARE_EMAIL_ACCOUNT_ID=$(read_secret cloudflare-email-account-id)
CLOUDFLARE_EMAIL_API_TOKEN=$(read_secret cloudflare-email-api-token)
CLOUDFLARE_EMAIL_FROM=$(read_secret cloudflare-email-from)
WALLET_DOWNLOAD_SIGNING_SECRET=$(read_secret wallet-download-signing-secret)
GOOGLE_WALLET_ISSUER_ID=$(read_secret google-wallet-issuer-id)
GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL=$(read_secret google-wallet-service-account-email)
GOOGLE_WALLET_PRIVATE_KEY=$(read_secret google-wallet-private-key)
APPLE_WALLET_PASS_TYPE_IDENTIFIER=$(read_secret apple-wallet-pass-type-identifier)
APPLE_WALLET_TEAM_IDENTIFIER=$(read_secret apple-wallet-team-identifier)
APPLE_WALLET_WWDR_CERTIFICATE_BASE64=$(read_secret apple-wallet-wwdr-certificate-base64)
APPLE_WALLET_SIGNER_CERTIFICATE_BASE64=$(read_secret apple-wallet-signer-certificate-base64)
APPLE_WALLET_SIGNER_KEY_BASE64=$(read_secret apple-wallet-signer-key-base64)
APPLE_WALLET_SIGNER_KEY_PASSPHRASE=$(read_secret apple-wallet-signer-key-passphrase)
INITIAL_SUPREME_EMAILS=technicaldirector.acmvit@gmail.com
INITIAL_EVENT_SLUG=code2create-7
OPENAI_API_KEY=$(read_secret openai-api-key)
POSTHOG_PROJECT_TOKEN=$(read_secret posthog-project-token)
POSTHOG_HOST=https://i.c2c.sh
NOVELTY_GLOBAL_REQUESTS_PER_MINUTE=1800
NOVELTY_INDEX_REQUESTS_PER_MINUTE=300
PHONE_VERIFICATION_HMAC_SECRET=$(read_secret phone-verification-hmac-secret)
SMS_AWS_REGION=ap-south-1
SMS_AWS_ACCESS_KEY_ID=$(read_secret sms-aws-access-key-id)
SMS_AWS_SECRET_ACCESS_KEY=$(read_secret sms-aws-secret-access-key)
GITHUB_APP_ID=$(read_secret github-app-id)
GITHUB_APP_CLIENT_ID=$(read_secret github-app-client-id)
GITHUB_APP_CLIENT_SECRET=$(read_secret github-app-client-secret)
GITHUB_CLIENT_ID=$(read_secret github-client-id)
GITHUB_CLIENT_SECRET=$(read_secret github-client-secret)
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
DISCORD_SUPPORT_ACTOR_EMAIL=technicaldirector.acmvit@gmail.com
DISCORD_SUPPORT_BRIDGE_SECRET=$(read_secret discord-support-bridge-secret)
EOF

(
  cd "${C2C_REPOSITORY_ROOT}/apps/backend"
  pnpm exec convex env set --from-file "${C2C_ENV_FILE}" --force
  printf '%s' "${C2C_PHONE_VERIFICATION_MESSAGE_TEMPLATE}" \
    | pnpm exec convex env set PHONE_VERIFICATION_MESSAGE_TEMPLATE
)

echo "Configured the production Convex environment. No event or application window was changed."
