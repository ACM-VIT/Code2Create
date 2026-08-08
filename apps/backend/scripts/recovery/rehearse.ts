import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  archiveInventorySchema,
  backupArchiveDescriptor,
  compareInventories,
  inspectConvexSnapshot,
  readBackupManifest,
  sha256File,
  storedObjectSchema,
  type ArchiveInventory,
  type InventoryComparison,
  type StoredObject,
} from "./archive.ts";
import {
  exportStagingSnapshot,
  productionDeployment,
  replaceStagingFromSnapshot,
  stagingDeployment,
  workspaceRoot,
} from "./commands.ts";
import {
  downloadExactRecoveryObject,
  uploadVersionedRecoveryFile,
} from "./storage.ts";

const snapshotProofSchema = z.object({
  fileName: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteCount: z.number().int().positive(),
  inventory: archiveInventorySchema,
}).strict();

const comparisonSchema = z.object({
  matches: z.boolean(),
  missingPaths: z.array(z.string()),
  unexpectedPaths: z.array(z.string()),
  changedPaths: z.array(z.string()),
}).strict();

const baseResultSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("code2create-staging-restore-rehearsal"),
  eventSlug: z.string(),
  operatorId: z.string(),
  reason: z.string(),
  stagingDeployment: z.string(),
  sourceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceArchive: storedObjectSchema,
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  preRestore: z.object({
    backup: storedObjectSchema,
    inventory: archiveInventorySchema,
  }).optional(),
  postRestore: snapshotProofSchema.optional(),
  comparison: comparisonSchema.optional(),
});

const passedResultSchema = baseResultSchema.extend({
  status: z.literal("passed"),
  preRestore: z.object({
    backup: storedObjectSchema,
    inventory: archiveInventorySchema,
  }),
  postRestore: snapshotProofSchema,
  comparison: comparisonSchema.extend({ matches: z.literal(true) }),
}).strict();

const failedResultSchema = baseResultSchema.extend({
  status: z.literal("failed"),
  error: z.string().min(1).max(800),
}).strict();

const rehearsalResultSchema = z.discriminatedUnion("status", [
  passedResultSchema,
  failedResultSchema,
]);

type SnapshotProof = z.infer<typeof snapshotProofSchema>;

function requiredOption(value: string | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Pass ${label}.`);
  return normalized;
}

function safeTimestamp(date: Date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Restore rehearsal failed.";
  return message.slice(0, 800);
}

function boundedComparison(comparison: InventoryComparison): InventoryComparison {
  return {
    matches: comparison.matches,
    missingPaths: comparison.missingPaths.slice(0, 50),
    unexpectedPaths: comparison.unexpectedPaths.slice(0, 50),
    changedPaths: comparison.changedPaths.slice(0, 50),
  };
}

async function snapshotProof(path: string): Promise<SnapshotProof> {
  const [descriptor, inventory] = await Promise.all([
    backupArchiveDescriptor(path),
    inspectConvexSnapshot(path),
  ]);
  return snapshotProofSchema.parse({
    fileName: basename(path),
    sha256: descriptor.sha256,
    byteCount: descriptor.byteCount,
    inventory,
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", default: false },
      manifest: { type: "string" },
      "staging-deployment": { type: "string" },
      "confirm-staging-deployment": { type: "string" },
      "operator-id": { type: "string" },
      reason: { type: "string" },
      "output-directory": {
        type: "string",
        default: join(workspaceRoot, "outputs", "recovery"),
      },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) {
    console.log(`Usage: pnpm recovery:rehearse [options]

Required:
  --manifest <backup manifest path>
  --staging-deployment <exact C2C_STAGING_DEPLOYMENT value>
  --confirm-staging-deployment <same exact staging value>
  --operator-id <event person or operator reference>
  --reason <rehearsal reason>

Optional:
  --output-directory <path>  Defaults to outputs/recovery

This command never targets production. It backs up staging before replacement,
imports the exact versioned production snapshot, re-exports staging, and compares
every JSONL record and stored file.`);
    return;
  }
  const manifestPath = resolve(requiredOption(values.manifest, "--manifest"));
  const manifest = await readBackupManifest(manifestPath);
  productionDeployment(manifest.sourceDeployment);
  const target = stagingDeployment(
    requiredOption(values["staging-deployment"], "--staging-deployment"),
    requiredOption(
      values["confirm-staging-deployment"],
      "--confirm-staging-deployment",
    ),
  );
  const operatorId = z
    .string()
    .min(2)
    .max(120)
    .parse(requiredOption(values["operator-id"], "--operator-id"));
  const reason = z
    .string()
    .min(5)
    .max(300)
    .parse(requiredOption(values.reason, "--reason"));
  const outputDirectory = resolve(
    requiredOption(values["output-directory"], "--output-directory"),
  );
  await mkdir(outputDirectory, { recursive: true });
  const startedAt = new Date();
  const baseName = `restore-${manifest.eventSlug}-${safeTimestamp(startedAt)}-${randomUUID().slice(0, 8)}`;
  const downloadedPath = join(outputDirectory, `${baseName}-source.zip`);
  const preRestorePath = join(outputDirectory, `${baseName}-before.zip`);
  const postRestorePath = join(outputDirectory, `${baseName}-after.zip`);
  const resultPath = join(outputDirectory, `${baseName}.result.json`);
  const sourceManifestSha256 = await sha256File(manifestPath);

  let preRestore: { backup: StoredObject; inventory: ArchiveInventory } | undefined;
  let postRestore: SnapshotProof | undefined;
  let comparison: InventoryComparison | undefined;
  let failure: string | undefined;

  try {
    await downloadExactRecoveryObject({
      object: manifest.archive,
      destinationPath: downloadedPath,
    });
    const downloadedInventory = await inspectConvexSnapshot(downloadedPath);
    const inputComparison = compareInventories(manifest.inventory, downloadedInventory);
    if (!inputComparison.matches) {
      throw new Error("The downloaded backup inventory does not match its versioned manifest.");
    }

    await exportStagingSnapshot(target, preRestorePath);
    await chmod(preRestorePath, 0o600);
    const preProof = await snapshotProof(preRestorePath);
    const preBackupKey = [
      "backups",
      manifest.eventSlug,
      "staging-before-restore",
      `${safeTimestamp(startedAt)}-${preProof.sha256.slice(0, 16)}.zip`,
    ].join("/");
    const preBackup = await uploadVersionedRecoveryFile({
      path: preRestorePath,
      key: preBackupKey,
      contentType: "application/zip",
      sha256: preProof.sha256,
      metadata: {
        kind: "staging-pre-restore",
        event: manifest.eventSlug,
        source: manifest.archive.sha256.slice(0, 24),
      },
    });
    preRestore = { backup: preBackup, inventory: preProof.inventory };

    await replaceStagingFromSnapshot(target, downloadedPath);
    await exportStagingSnapshot(target, postRestorePath);
    await chmod(postRestorePath, 0o600);
    postRestore = await snapshotProof(postRestorePath);
    comparison = boundedComparison(compareInventories(manifest.inventory, postRestore.inventory));
    if (!comparison.matches) {
      throw new Error("The staging re-export differs from the production backup inventory.");
    }
  } catch (error) {
    failure = safeError(error);
  }

  const finishedAt = new Date();
  const result = failure
    ? failedResultSchema.parse({
        schemaVersion: 1,
        kind: "code2create-staging-restore-rehearsal",
        status: "failed",
        eventSlug: manifest.eventSlug,
        operatorId,
        reason,
        stagingDeployment: target,
        sourceManifestSha256,
        sourceArchive: manifest.archive,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        ...(preRestore ? { preRestore } : {}),
        ...(postRestore ? { postRestore } : {}),
        ...(comparison ? { comparison } : {}),
        error: failure,
      })
    : passedResultSchema.parse({
        schemaVersion: 1,
        kind: "code2create-staging-restore-rehearsal",
        status: "passed",
        eventSlug: manifest.eventSlug,
        operatorId,
        reason,
        stagingDeployment: target,
        sourceManifestSha256,
        sourceArchive: manifest.archive,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        preRestore,
        postRestore,
        comparison,
      });
  const checkedResult = rehearsalResultSchema.parse(result);
  await writeFile(resultPath, `${JSON.stringify(checkedResult, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const resultSha256 = await sha256File(resultPath);
  const storedResult = await uploadVersionedRecoveryFile({
    path: resultPath,
    key: [
      "backups",
      manifest.eventSlug,
      "rehearsals",
      `${safeTimestamp(finishedAt)}-${resultSha256.slice(0, 16)}.result.json`,
    ].join("/"),
    contentType: "application/json",
    sha256: resultSha256,
    metadata: {
      kind: "staging-restore-rehearsal",
      event: manifest.eventSlug,
      status: checkedResult.status,
    },
  });
  console.log(
    JSON.stringify(
      {
        status: checkedResult.status,
        resultPath,
        resultVersionId: storedResult.versionId,
        preRestoreVersionId: preRestore?.backup.versionId,
        comparison: checkedResult.comparison,
      },
      null,
      2,
    ),
  );
  if (failure) throw new Error(failure);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Restore rehearsal failed.");
  process.exitCode = 1;
});
