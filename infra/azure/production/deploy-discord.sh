#!/usr/bin/env bash
set -euo pipefail

C2C_REPOSITORY_ROOT="$({
  cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
  pwd
})"
C2C_RELEASE_ID="${1:-$(git -C "${C2C_REPOSITORY_ROOT}" rev-parse HEAD)}"

if [[ ! "${C2C_RELEASE_ID}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The Discord release ID must be a full Git commit SHA." >&2
  exit 1
fi

C2C_REMOTE_SCRIPT="$(
  printf "bash -s -- '%s' <<'C2C_DISCORD_DEPLOY'\n" "${C2C_RELEASE_ID}"
  cat <<'C2C_DISCORD_DEPLOY'
set -euo pipefail
C2C_RELEASE_ID="$1"
C2C_SOURCE_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${C2C_SOURCE_DIR}"
}
trap cleanup EXIT
curl --fail --location --silent --show-error \
  "https://github.com/ACM-VIT/Code2Create/archive/${C2C_RELEASE_ID}.tar.gz" \
  --output "${C2C_SOURCE_DIR}/source.tar.gz"
tar --extract --gzip --file "${C2C_SOURCE_DIR}/source.tar.gz" --directory "${C2C_SOURCE_DIR}"
C2C_CHECKOUT="$(find "${C2C_SOURCE_DIR}" -mindepth 1 -maxdepth 1 -type d -name 'Code2Create-*' -print -quit)"
if [[ -z "${C2C_CHECKOUT}" ]]; then
  echo 'The Discord deployment archive did not contain a repository checkout.' >&2
  exit 1
fi
bash "${C2C_CHECKOUT}/infra/azure/production/deploy-discord-on-host.sh" "${C2C_RELEASE_ID}"
C2C_DISCORD_DEPLOY
  printf '%s\n' 'C2C_DISCORD_DEPLOY'
)"

C2C_DEPLOY_RESULT="$(
  az vm run-command invoke \
    --resource-group rg-code2create-production \
    --name vm-c2c-production-app \
    --command-id RunShellScript \
    --scripts "${C2C_REMOTE_SCRIPT}" \
    --query 'value[].message' \
    --output tsv
)"
printf '%s\n' "${C2C_DEPLOY_RESULT}"
if [[ "${C2C_DEPLOY_RESULT}" != *"Deployed Discord support bridge ${C2C_RELEASE_ID}."* ]]; then
  echo 'The remote command did not confirm a healthy Discord deployment.' >&2
  exit 1
fi
