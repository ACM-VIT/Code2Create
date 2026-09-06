#!/usr/bin/env bash
set -euo pipefail

C2C_AWS_REGION="${AWS_REGION:-ap-south-1}"
C2C_INSTANCE_ID="$(aws ec2 describe-instances \
  --region "${C2C_AWS_REGION}" \
  --filters \
    Name=tag:Name,Values=code2create-production-backend \
    Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)"

if [[ -z "${C2C_INSTANCE_ID}" || "${C2C_INSTANCE_ID}" == "None" ]]; then
  echo "The production backend EC2 instance was not found." >&2
  exit 1
fi

C2C_HOST="$(aws ec2 describe-instances \
  --region "${C2C_AWS_REGION}" \
  --instance-ids "${C2C_INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)"

exec ssh \
  -i "${C2C_SSH_KEY:-${HOME}/.ssh/code2create-production-aws}" \
  -o StrictHostKeyChecking=accept-new \
  "ubuntu@${C2C_HOST}" "$@"
