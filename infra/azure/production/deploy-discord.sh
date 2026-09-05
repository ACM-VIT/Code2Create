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

# GitHub supplies a short-lived archive URL; the VM never receives the GitHub credential.
C2C_ARCHIVE_URL="$(
  gh auth token --hostname github.com | pnpm exec node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const token = readFileSync(0, "utf8").trim();
    if (!token) throw new Error("Sign in with gh before deploying Discord.");
    const response = await fetch(
      `https://api.github.com/repos/ACM-VIT/Code2Create/tarball/${process.argv[1]}`,
      {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "code2create-deploy",
        },
      },
    );
    const location = response.headers.get("location");
    if (response.status !== 302 || !location)
      throw new Error(`GitHub archive request failed: HTTP ${response.status}`);
    const url = new URL(location);
    if (url.protocol !== "https:" || url.hostname !== "codeload.github.com")
      throw new Error("GitHub returned an unexpected archive download host.");
    process.stdout.write(url.href);
  ' "${C2C_RELEASE_ID}"
)"

C2C_REMOTE_SCRIPT="$(
  printf "bash -s -- %q %q <<'C2C_DISCORD_DEPLOY'\n" "${C2C_RELEASE_ID}" "${C2C_ARCHIVE_URL}"
  cat <<'C2C_DISCORD_DEPLOY'
set -euo pipefail
C2C_RELEASE_ID="$1"
C2C_ARCHIVE_URL="$2"
C2C_SOURCE_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${C2C_SOURCE_DIR}"
}
trap cleanup EXIT
curl --fail --location --silent --show-error \
  "${C2C_ARCHIVE_URL}" \
  --output "${C2C_SOURCE_DIR}/source.tar.gz"
C2C_CHECKOUT="${C2C_SOURCE_DIR}/checkout"
mkdir "${C2C_CHECKOUT}"
tar --extract --gzip --strip-components=1 --file "${C2C_SOURCE_DIR}/source.tar.gz" --directory "${C2C_CHECKOUT}"
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
