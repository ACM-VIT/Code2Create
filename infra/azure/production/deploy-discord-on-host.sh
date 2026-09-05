#!/usr/bin/env bash
set -euo pipefail

C2C_REPOSITORY_ROOT="$({
  cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
  pwd
})"
C2C_RUNTIME_DIR="/srv/code2create"
C2C_RELEASE_ID="${1:-$(git -C "${C2C_REPOSITORY_ROOT}" rev-parse HEAD)}"
C2C_CONTAINER_NAME="code2create-discord-production-support-1"
C2C_HAD_PREVIOUS_IMAGE=false

if [[ ! "${C2C_RELEASE_ID}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The Discord release ID must be a full Git commit SHA." >&2
  exit 1
fi

if docker image inspect code2create-discord:current >/dev/null 2>&1; then
  docker tag code2create-discord:current code2create-discord:previous
  C2C_HAD_PREVIOUS_IMAGE=true
fi

docker build \
  --file "${C2C_REPOSITORY_ROOT}/apps/discord/Dockerfile" \
  --label "org.opencontainers.image.revision=${C2C_RELEASE_ID}" \
  --tag code2create-discord:candidate \
  "${C2C_REPOSITORY_ROOT}"
docker tag code2create-discord:candidate code2create-discord:current

install -o root -g root -m 0644 \
  "${C2C_REPOSITORY_ROOT}/infra/azure/production/discord-compose.yml" \
  "${C2C_RUNTIME_DIR}/discord-compose.yml"
install -o root -g root -m 0755 \
  "${C2C_REPOSITORY_ROOT}/infra/azure/production/render-discord-runtime-env.sh" \
  "${C2C_RUNTIME_DIR}/render-discord-runtime-env.sh"
install -o root -g root -m 0644 \
  "${C2C_REPOSITORY_ROOT}/infra/azure/production/code2create-discord.service" \
  /etc/systemd/system/code2create-discord.service

systemctl daemon-reload
systemctl enable code2create-discord.service >/dev/null
if systemctl restart code2create-discord.service; then
  for _attempt in {1..18}; do
    if [[ "$(docker inspect --format '{{.State.Health.Status}}' "${C2C_CONTAINER_NAME}" 2>/dev/null)" == "healthy" ]]; then
      echo "Deployed Discord support bridge ${C2C_RELEASE_ID}."
      exit 0
    fi
    sleep 5
  done
fi

echo "The Discord support bridge failed its health check; rolling back." >&2
if [[ "${C2C_HAD_PREVIOUS_IMAGE}" == true ]]; then
  docker tag code2create-discord:previous code2create-discord:current
  systemctl restart code2create-discord.service
else
  systemctl stop code2create-discord.service
fi
exit 1
