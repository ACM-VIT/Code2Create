#!/usr/bin/env bash
set -euo pipefail

C2C_VAULT_NAME="kv-c2c-prod-b88416"
C2C_REPOSITORY_ROOT="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
  pwd
)"
C2C_RELEASE_ID="${1:-$(git -C "${C2C_REPOSITORY_ROOT}" rev-parse HEAD)}"

export CONVEX_SELF_HOSTED_URL="https://realtime.c2c.sh"
export CONVEX_SELF_HOSTED_ADMIN_KEY="$(
  az keyvault secret show \
    --vault-name "${C2C_VAULT_NAME}" \
    --name convex-admin-key \
    --query value \
    --output tsv
)"
export CONVEX_DEPLOYMENT=""

(
  cd "${C2C_REPOSITORY_ROOT}/apps/backend"
  pnpm exec convex deploy \
    --typecheck enable \
    --codegen enable \
    --message "${C2C_RELEASE_ID}"
)
