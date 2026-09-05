import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const deployScript = resolve(import.meta.dirname, "../../../../infra/azure/production/deploy-discord.sh");
const release = "a".repeat(40);

for (const outcome of ["healthy", "failed", "wrong_release"]) {
  test(`Discord deployment handles Azure's sh runner and ${outcome} result`, () => {
    const directory = mkdtempSync(join(tmpdir(), "discord deploy test "));
    try {
      const bin = join(directory, "bin");
      const remoteTmp = join(directory, "remote temp");
      const checkout = join(directory, `Code2Create-${release}`);
      const hostScriptDirectory = join(checkout, "infra/azure/production");
      for (const path of [bin, remoteTmp, hostScriptDirectory]) mkdirSync(path, { recursive: true });
      writeFileSync(join(hostScriptDirectory, "deploy-discord-on-host.sh"), [
        "set -eu",
        'if [ "$C2C_TEST_OUTCOME" = failed ]; then echo "Bot is unhealthy" >&2; exit 1; fi',
        'if [ "$C2C_TEST_OUTCOME" = wrong_release ]; then set -- wrong; fi',
        'printf "Deployed Discord support bridge %s.\\n" "$1"',
      ].join("\n"));
      const archive = join(directory, "source.tar.gz");
      const packed = spawnSync("tar", ["-czf", archive, "-C", directory, `Code2Create-${release}`]);
      assert.equal(packed.status, 0, packed.stderr.toString());
      writeFileSync(join(bin, "curl"), [
        "#!/bin/sh",
        "set -eu",
        'while [ "$1" != --output ]; do shift; done',
        'cp "$C2C_TEST_ARCHIVE" "$2"',
      ].join("\n"), { mode: 0o755 });
      writeFileSync(join(bin, "az"), [
        "#!/bin/sh",
        "set -eu",
        'while [ "$1" != --scripts ]; do shift; done',
        // Azure reports success even when its remote shell exits nonzero.
        'sh -c "$2" 2>&1 || true',
      ].join("\n"), { mode: 0o755 });
      const result = spawnSync("bash", [deployScript, release], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: remoteTmp,
          C2C_TEST_ARCHIVE: archive,
          C2C_TEST_OUTCOME: outcome,
        },
      });
      assert.equal(result.status, outcome === "healthy" ? 0 : 1, result.stdout + result.stderr);
      if (outcome === "healthy") {
        assert.match(result.stdout, new RegExp(`Deployed Discord support bridge ${release}\\.`));
      } else {
        assert.match(result.stderr, /did not confirm a healthy Discord deployment/u);
      }
      assert.deepEqual(readdirSync(remoteTmp), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
