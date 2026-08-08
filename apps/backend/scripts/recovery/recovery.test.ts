import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  backupManifestSchema,
  compareInventories,
  inspectConvexSnapshot,
  validateArchiveEntryPath,
} from "./archive.ts";
import { productionDeployment, stagingDeployment } from "./commands.ts";

function waitForZip(child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`zip failed with exit ${code ?? "unknown"}.`));
    });
  });
}

async function makeSnapshot(
  parent: string,
  name: string,
  records: ReadonlyArray<{ _id: string; value: number }>,
) {
  const source = join(parent, name);
  await Promise.all([
    mkdir(join(source, "users"), { recursive: true }),
    mkdir(join(source, "_storage"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(source, "users", "documents.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    ),
    writeFile(
      join(source, "_storage", "documents.jsonl"),
      `${JSON.stringify({ _id: "storage-id", contentType: "text/plain" })}\n`,
    ),
    writeFile(join(source, "_storage", "storage-id"), "stored bytes"),
    writeFile(
      join(source, "generated_schema.jsonl"),
      `${JSON.stringify({ tableName: "users" })}\n`,
    ),
  ]);
  const archive = join(parent, `${name}.zip`);
  await waitForZip(
    spawn("zip", ["-q", "-r", archive, "."], {
      cwd: source,
      stdio: "ignore",
    }),
  );
  return archive;
}

test("snapshot inventory is semantic and detects changed records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "c2c-recovery-test-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const original = await makeSnapshot(directory, "original", [
    { _id: "a", value: 1 },
    { _id: "b", value: 2 },
  ]);
  const reordered = await makeSnapshot(directory, "reordered", [
    { _id: "b", value: 2 },
    { _id: "a", value: 1 },
  ]);
  const changed = await makeSnapshot(directory, "changed", [
    { _id: "a", value: 1 },
    { _id: "b", value: 3 },
  ]);

  const [originalInventory, reorderedInventory, changedInventory] = await Promise.all([
    inspectConvexSnapshot(original),
    inspectConvexSnapshot(reordered),
    inspectConvexSnapshot(changed),
  ]);
  assert.deepEqual(compareInventories(originalInventory, reorderedInventory), {
    matches: true,
    missingPaths: [],
    unexpectedPaths: [],
    changedPaths: [],
  });
  const difference = compareInventories(originalInventory, changedInventory);
  assert.equal(difference.matches, false);
  assert.deepEqual(difference.changedPaths, ["users/documents.jsonl"]);
});

test("snapshot entry validation rejects traversal and option-like paths", () => {
  assert.throws(() => validateArchiveEntryPath("../secret"), /unsafe ZIP entry/u);
  assert.throws(() => validateArchiveEntryPath("-option"), /unsafe ZIP entry/u);
  assert.throws(() => validateArchiveEntryPath("folder\\file"), /unsafe ZIP entry/u);
  assert.doesNotThrow(() => validateArchiveEntryPath("teams/documents.jsonl"));
});

test("restore target must be the exact configured staging deployment", (context) => {
  const previousProduction = process.env.C2C_PRODUCTION_DEPLOYMENT;
  const previousStaging = process.env.C2C_STAGING_DEPLOYMENT;
  context.after(() => {
    if (previousProduction === undefined) delete process.env.C2C_PRODUCTION_DEPLOYMENT;
    else process.env.C2C_PRODUCTION_DEPLOYMENT = previousProduction;
    if (previousStaging === undefined) delete process.env.C2C_STAGING_DEPLOYMENT;
    else process.env.C2C_STAGING_DEPLOYMENT = previousStaging;
  });
  process.env.C2C_PRODUCTION_DEPLOYMENT = "production-deployment";
  process.env.C2C_STAGING_DEPLOYMENT = "team:code2create:staging";

  assert.equal(
    stagingDeployment("team:code2create:staging", "team:code2create:staging"),
    "team:code2create:staging",
  );
  assert.throws(
    () => stagingDeployment("production-deployment", "production-deployment"),
    /must exactly match/u,
  );
  assert.throws(
    () => stagingDeployment("team:code2create:staging", "wrong"),
    /must exactly match/u,
  );
  process.env.C2C_STAGING_DEPLOYMENT = "team:code2create:prod";
  assert.throws(
    () => stagingDeployment("team:code2create:prod", "team:code2create:prod"),
    /refuses production/u,
  );
  assert.equal(productionDeployment("production-deployment"), "production-deployment");
  assert.throws(() => productionDeployment("dev"), /must exactly match/u);
});

test("backup manifest binds the archive to its event prefix", () => {
  const base = {
    schemaVersion: 1,
    kind: "code2create-convex-logical-backup",
    eventSlug: "code2create-7",
    purpose: "pre_event",
    operatorId: "person-1",
    sourceDeployment: "production-deployment",
    sourceReleaseId: "release-1",
    convexCliVersion: "1.43.0",
    exportedAt: "2026-08-06T00:00:00.000Z",
    includesFileStorage: true,
    archive: {
      region: "ap-south-1",
      bucket: "private-recovery-bucket",
      key: "backups/code2create-7/convex/backup.zip",
      versionId: "version-1",
      byteCount: 1,
      sha256: "a".repeat(64),
    },
    inventory: {
      entryCount: 1,
      jsonlEntryCount: 1,
      binaryEntryCount: 0,
      aggregateSha256: "b".repeat(64),
      entries: [
        {
          path: "users/documents.jsonl",
          kind: "jsonl",
          recordCount: 1,
          sha256: "c".repeat(64),
        },
      ],
    },
  };
  assert.equal(backupManifestSchema.safeParse(base).success, true);
  assert.equal(
    backupManifestSchema.safeParse({
      ...base,
      archive: { ...base.archive, key: "events/another-prefix/backup.zip" },
    }).success,
    false,
  );
});
