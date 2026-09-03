import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  backupArchiveDescriptor,
  backupManifestSchema,
  inspectConvexSnapshot,
  sha256File,
} from "./archive.ts";
import {
  convexCliVersion,
  exportProductionSnapshot,
  productionDeployment,
  workspaceRoot,
} from "./commands.ts";
import { uploadVersionedRecoveryFile } from "./storage.ts";

const purposeSchema = z.enum([
  "pre_event",
  "pre_release",
  "post_event",
  "incident_safeguard",
  "manual",
]);

function requiredOption(value: string | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Pass ${label}.`);
  return normalized;
}

function safeTimestamp(date: Date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function shortDigest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", default: false },
      "event-slug": { type: "string" },
      purpose: { type: "string" },
      "operator-id": { type: "string" },
      "source-deployment": { type: "string" },
      "source-release-id": { type: "string" },
      "output-directory": {
        type: "string",
        default: join(workspaceRoot, "outputs", "recovery"),
      },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) {
    console.log(`Usage: pnpm recovery:backup [options]

Required:
  --event-slug <slug>
  --purpose <pre_event|pre_release|post_event|incident_safeguard|manual>
  --operator-id <event person or operator reference>
  --source-deployment <exact C2C_PRODUCTION_DEPLOYMENT value>
  --source-release-id <recorded release identifier>

Optional:
  --output-directory <path>  Defaults to outputs/recovery`);
    return;
  }
  const eventSlug = z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .parse(requiredOption(values["event-slug"], "--event-slug"));
  const purpose = purposeSchema.parse(requiredOption(values.purpose, "--purpose"));
  const operatorId = z
    .string()
    .min(2)
    .max(120)
    .parse(requiredOption(values["operator-id"], "--operator-id"));
  const sourceDeployment = productionDeployment(
    requiredOption(values["source-deployment"], "--source-deployment"),
  );
  const sourceReleaseId = z
    .string()
    .min(1)
    .max(200)
    .parse(requiredOption(values["source-release-id"], "--source-release-id"));
  const outputDirectory = resolve(requiredOption(values["output-directory"], "--output-directory"));
  await mkdir(outputDirectory, { recursive: true });

  const exportedAt = new Date();
  const baseName = `convex-${eventSlug}-${safeTimestamp(exportedAt)}-${randomUUID().slice(0, 8)}`;
  const archivePath = join(outputDirectory, `${baseName}.zip`);
  const manifestPath = join(outputDirectory, `${baseName}.manifest.json`);
  const receiptPath = join(outputDirectory, `${baseName}.receipt.json`);

  await exportProductionSnapshot(sourceDeployment, archivePath);
  await chmod(archivePath, 0o600);
  const [descriptor, inventory, cliVersion] = await Promise.all([
    backupArchiveDescriptor(archivePath),
    inspectConvexSnapshot(archivePath),
    convexCliVersion(),
  ]);
  const objectBase = [
    "backups",
    eventSlug,
    "convex",
    `${safeTimestamp(exportedAt)}-${descriptor.sha256.slice(0, 16)}`,
  ].join("/");
  const archive = await uploadVersionedRecoveryFile({
    path: archivePath,
    key: `${objectBase}.zip`,
    contentType: "application/zip",
    sha256: descriptor.sha256,
    metadata: {
      kind: "convex-logical-backup",
      event: eventSlug,
      purpose,
      release: shortDigest(sourceReleaseId),
    },
  });
  const manifest = backupManifestSchema.parse({
    schemaVersion: 1,
    kind: "code2create-convex-logical-backup",
    eventSlug,
    purpose,
    operatorId,
    sourceDeployment,
    sourceReleaseId,
    convexCliVersion: cliVersion,
    exportedAt: exportedAt.toISOString(),
    includesFileStorage: true,
    archive,
    inventory,
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const manifestSha256 = await sha256File(manifestPath);
  const storedManifest = await uploadVersionedRecoveryFile({
    path: manifestPath,
    key: `${objectBase}.manifest.json`,
    contentType: "application/json",
    sha256: manifestSha256,
    metadata: {
      kind: "convex-backup-manifest",
      event: eventSlug,
      backup: descriptor.sha256.slice(0, 24),
    },
  });
  const receipt = {
    schemaVersion: 1,
    kind: "code2create-convex-backup-receipt",
    archivePath,
    manifestPath,
    manifest: storedManifest,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        status: "stored",
        archivePath,
        manifestPath,
        receiptPath,
        archiveSha256: archive.sha256,
        archiveVersionId: archive.versionId,
        manifestVersionId: storedManifest.versionId,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Backup export failed.");
  process.exitCode = 1;
});
