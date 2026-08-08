import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

const sha256Pattern = /^[a-f0-9]{64}$/;
const jsonValueSchema = z.json();

export const archiveEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["jsonl", "binary"]),
  recordCount: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(sha256Pattern),
}).strict();

export const archiveInventorySchema = z.object({
  entryCount: z.number().int().positive(),
  jsonlEntryCount: z.number().int().positive(),
  binaryEntryCount: z.number().int().nonnegative(),
  aggregateSha256: z.string().regex(sha256Pattern),
  entries: z.array(archiveEntrySchema).min(1),
}).strict();

export const storedObjectSchema = z.object({
  region: z.literal("ap-south-1"),
  bucket: z.string().min(3),
  key: z.string().min(1),
  versionId: z.string().min(1),
  byteCount: z.number().int().positive(),
  sha256: z.string().regex(sha256Pattern),
}).strict();

export const backupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("code2create-convex-logical-backup"),
  eventSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  purpose: z.enum([
    "pre_event",
    "pre_release",
    "post_event",
    "incident_safeguard",
    "manual",
  ]),
  operatorId: z.string().min(2).max(120),
  sourceDeployment: z.string().min(1).max(200),
  sourceReleaseId: z.string().min(1).max(200),
  convexCliVersion: z.string().min(1).max(40),
  exportedAt: z.string().datetime({ offset: true }),
  includesFileStorage: z.literal(true),
  archive: storedObjectSchema,
  inventory: archiveInventorySchema,
}).strict().superRefine((manifest, context) => {
  const expectedPrefix = `backups/${manifest.eventSlug}/convex/`;
  if (!manifest.archive.key.startsWith(expectedPrefix) || !manifest.archive.key.endsWith(".zip")) {
    context.addIssue({
      code: "custom",
      path: ["archive", "key"],
      message: "Backup archive key does not match its event recovery prefix.",
    });
  }
});

export type ArchiveEntry = z.infer<typeof archiveEntrySchema>;
export type ArchiveInventory = z.infer<typeof archiveInventorySchema>;
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type StoredObject = z.infer<typeof storedObjectSchema>;

export type InventoryComparison = {
  matches: boolean;
  missingPaths: string[];
  unexpectedPaths: string[];
  changedPaths: string[];
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown recovery-tool failure.";
}

function waitForChild(
  child: ReturnType<typeof spawn>,
  commandLabel: string,
  stderr: () => string,
) {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr().trim();
      const outcome = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      reject(new Error(`${commandLabel} failed (${outcome})${detail ? `: ${detail}` : "."}`));
    });
  });
}

async function captureText(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    child.kill();
    throw new Error(`Could not capture ${command} output.`);
  }
  stdout.setEncoding("utf8");
  stderr.setEncoding("utf8");
  let output = "";
  let errorOutput = "";
  stdout.on("data", (chunk: string) => {
    output += chunk;
    if (output.length > 16 * 1024 * 1024) child.kill("SIGKILL");
  });
  stderr.on("data", (chunk: string) => {
    errorOutput += chunk;
    if (errorOutput.length > 2 * 1024 * 1024) child.kill("SIGKILL");
  });
  await waitForChild(child, command, () => errorOutput);
  return output;
}

export function validateArchiveEntryPath(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("-") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw new Error(`Snapshot contains an unsafe ZIP entry: ${path || "<empty>"}.`);
  }
}

function canonicalJson(value: z.infer<typeof jsonValueSchema>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Snapshot JSON contains a non-finite number.");
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const pairs: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) throw new Error("Snapshot JSON contains an undefined value.");
    pairs.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
  }
  return `{${pairs.join(",")}}`;
}

async function inspectJsonLines(archivePath: string, entryPath: string): Promise<ArchiveEntry> {
  const child = spawn("unzip", ["-p", archivePath, entryPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    child.kill();
    throw new Error("Could not read a snapshot JSONL entry.");
  }
  stderr.setEncoding("utf8");
  let errorOutput = "";
  stderr.on("data", (chunk: string) => {
    errorOutput += chunk;
  });
  const lineHashes: string[] = [];
  const lines = createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line.trim()) throw new Error(`${entryPath} contains a blank JSONL record.`);
      const parsed: unknown = JSON.parse(line);
      const value = jsonValueSchema.parse(parsed);
      lineHashes.push(createHash("sha256").update(canonicalJson(value)).digest("hex"));
    }
  } catch (error) {
    child.kill();
    throw new Error(`Invalid snapshot entry ${entryPath}: ${errorMessage(error)}`);
  }
  await waitForChild(child, `unzip ${entryPath}`, () => errorOutput);
  lineHashes.sort();
  return {
    path: entryPath,
    kind: "jsonl",
    recordCount: lineHashes.length,
    sha256: createHash("sha256").update(lineHashes.join("\n")).digest("hex"),
  };
}

async function inspectBinary(archivePath: string, entryPath: string): Promise<ArchiveEntry> {
  const child = spawn("unzip", ["-p", archivePath, entryPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    child.kill();
    throw new Error("Could not read a snapshot binary entry.");
  }
  stderr.setEncoding("utf8");
  let errorOutput = "";
  stderr.on("data", (chunk: string) => {
    errorOutput += chunk;
  });
  const hasher = createHash("sha256");
  await Promise.all([
    pipeline(stdout, hasher),
    waitForChild(child, `unzip ${entryPath}`, () => errorOutput),
  ]);
  return { path: entryPath, kind: "binary", sha256: hasher.digest("hex") };
}

export async function inspectConvexSnapshot(archivePath: string): Promise<ArchiveInventory> {
  const archiveStats = await stat(archivePath);
  if (!archiveStats.isFile() || archiveStats.size < 1) {
    throw new Error("The Convex snapshot ZIP is empty or missing.");
  }
  const listed = await captureText("unzip", ["-Z1", archivePath]);
  const paths = listed
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter((path) => path && !path.endsWith("/"));
  if (paths.length === 0) throw new Error("The Convex snapshot ZIP contains no files.");
  const uniquePaths = new Set<string>();
  for (const path of paths) {
    validateArchiveEntryPath(path);
    if (uniquePaths.has(path)) throw new Error(`Snapshot contains duplicate entry ${path}.`);
    uniquePaths.add(path);
  }
  const entries: ArchiveEntry[] = [];
  for (const path of [...uniquePaths].sort()) {
    entries.push(
      path.endsWith(".jsonl")
        ? await inspectJsonLines(archivePath, path)
        : await inspectBinary(archivePath, path),
    );
  }
  const jsonlEntryCount = entries.filter((entry) => entry.kind === "jsonl").length;
  if (jsonlEntryCount === 0) {
    throw new Error("The ZIP is not a Convex snapshot: it contains no JSONL entries.");
  }
  return archiveInventorySchema.parse({
    entryCount: entries.length,
    jsonlEntryCount,
    binaryEntryCount: entries.length - jsonlEntryCount,
    aggregateSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
  });
}

export async function sha256File(path: string) {
  const hasher = createHash("sha256");
  await pipeline(createReadStream(path), hasher);
  return hasher.digest("hex");
}

export async function backupArchiveDescriptor(path: string) {
  const [fileStats, sha256] = await Promise.all([stat(path), sha256File(path)]);
  if (!fileStats.isFile() || fileStats.size < 1) throw new Error("Backup archive is empty.");
  return { byteCount: fileStats.size, sha256 };
}

export async function readBackupManifest(path: string): Promise<BackupManifest> {
  const contents = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(contents);
  return backupManifestSchema.parse(parsed);
}

export function compareInventories(
  expected: ArchiveInventory,
  actual: ArchiveInventory,
): InventoryComparison {
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const missingPaths = [...expectedByPath.keys()].filter((path) => !actualByPath.has(path));
  const unexpectedPaths = [...actualByPath.keys()].filter((path) => !expectedByPath.has(path));
  const changedPaths = [...expectedByPath.entries()]
    .filter(([path, entry]) => {
      const actualEntry = actualByPath.get(path);
      return (
        actualEntry !== undefined &&
        (actualEntry.kind !== entry.kind ||
          actualEntry.sha256 !== entry.sha256 ||
          actualEntry.recordCount !== entry.recordCount)
      );
    })
    .map(([path]) => path);
  return {
    matches:
      expected.aggregateSha256 === actual.aggregateSha256 &&
      missingPaths.length === 0 &&
      unexpectedPaths.length === 0 &&
      changedPaths.length === 0,
    missingPaths,
    unexpectedPaths,
    changedPaths,
  };
}
