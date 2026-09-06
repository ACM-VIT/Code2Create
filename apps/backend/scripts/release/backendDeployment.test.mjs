import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../../../../.github/workflows/backend-deploy.yml"),
  "utf8",
);

test("production deployment bypasses the Cloudflare request timeout through an ephemeral origin rule", () => {
  assert.match(workflow, /C2C_PRODUCTION_ORIGIN_IP: 20\.204\.40\.131/u);
  assert.match(workflow, /az network nsg rule create/u);
  assert.match(workflow, /--source-address-prefixes "\$\{runner_ip\}\/32"/u);
  assert.match(workflow, /realtime\.c2c\.sh # code2create-backend-deploy/u);
  assert.match(workflow, /az network nsg rule delete/u);
  assert.match(workflow, /sudo sed -i '\/# code2create-backend-deploy\$\/d' \/etc\/hosts/u);
  assert.match(workflow, /if: \$\{\{ always\(\)/u);
});
