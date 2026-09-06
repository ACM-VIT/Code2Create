#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes ca-certificates curl docker.io docker-compose-v2 jq wireguard
systemctl enable --now docker
usermod --append --groups docker ubuntu
install -d -o ubuntu -g ubuntu -m 0750 /srv/code2create
install -d -o root -g root -m 0700 /srv/code2create/secrets
