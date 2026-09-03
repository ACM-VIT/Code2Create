import { Buffer } from "node:buffer";
import { X509Certificate, createHash, createSign, verify as verifySignature } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import mime from "mime";
import { serializeDictionary } from "structured-headers";
import { z } from "zod";

import {
  currentReleaseResponseSchema,
  maximumUpdateAssetBytes,
  maximumUpdateReleaseBytes,
  noUpdateDirectiveSchema,
  releaseIdSchema,
  releaseRecordSchema,
  rollbackDirectiveSchema,
  runtimeVersionSchema,
  signedPayloadSchema,
  updateChannelSchema,
  updateHealthResponseSchema,
  updateManifestSchema,
  type ReleaseRecord,
  type SignedPayload,
  type UpdatePlatform,
} from "../src/contracts.ts";
import { readBoundedJsonResponse, readBoundedResponseText } from "../src/boundedHttpBody.ts";

const updatesDirectory = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(updatesDirectory, "../..");
const reviewerDirectory = join(repositoryRoot, "apps/reviewer");
const certificatePath = join(reviewerDirectory, "certs/certificate.pem");

const channel = updateChannelSchema.parse(process.argv[2]);
const rollback = process.argv.slice(3).includes("--rollback");
loadEnvironmentFile(join(reviewerDirectory, `.env.${channel}.local`));
loadEnvironmentFile(join(updatesDirectory, `.env.${channel}.local`));

async function publish(selectedChannel: "staging" | "production", isRollback: boolean) {
  const updatesUrl = readUpdatesUrl();
  const adminToken = requiredEnvironmentValue("C2C_UPDATES_ADMIN_TOKEN");
  if (adminToken.length < 32) {
    throw new Error("C2C_UPDATES_ADMIN_TOKEN must contain at least 32 characters.");
  }
  await verifyUpdateService(updatesUrl, selectedChannel);

  const privateKeyPath = resolvePrivateKeyPath(
    requiredEnvironmentValue("C2C_UPDATE_PRIVATE_KEY_PATH"),
  );
  const [privateKey, certificatePem] = await Promise.all([
    readFile(privateKeyPath, "utf8"),
    readFile(certificatePath, "utf8"),
  ]);
  const certificate = new X509Certificate(certificatePem);
  verifySigningPair(privateKey, certificate);

  const gitCommit = (await runAndCapture("git", ["rev-parse", "HEAD"], repositoryRoot)).trim();
  const configuredReleaseId = process.env.C2C_UPDATE_RELEASE_ID?.trim();
  const releaseId = releaseIdSchema.parse(
    configuredReleaseId !== undefined && configuredReleaseId.length > 0
      ? configuredReleaseId
      : isRollback
        ? `${gitCommit}.rollback.${compactTimestamp(new Date())}`
        : gitCommit,
  );
  const expoConfig = await readExpoConfig(selectedChannel, !isRollback, releaseId);
  const runtimeVersion = resolveRuntimeVersion(expoConfig);
  const configuredUpdatesUrl = expoConfig.updates?.url;
  if (configuredUpdatesUrl !== updatesUrl.href) {
    throw new Error("C2C_UPDATES_URL does not match the URL embedded in the Expo config.");
  }
  console.log(`Preparing ${selectedChannel} update release ${releaseId}`);

  const expectedCurrent = await getCurrentRelease(updatesUrl, runtimeVersion, adminToken);
  const existing = await getRelease(updatesUrl, releaseId, adminToken);
  if (existing) {
    validateExistingRelease(existing, selectedChannel, runtimeVersion, isRollback);
    await activateRelease(updatesUrl, releaseId, expectedCurrent.currentReleaseId, adminToken);
    await writeReceipt(selectedChannel, updatesUrl, existing);
    console.log(`Release ${releaseId} is active.`);
    return;
  }

  if (!isRollback) await requireCleanGitTree();
  const createdAt = new Date().toISOString();
  const sign = (body: string) => signPayload(body, privateKey, certificate);
  const noUpdate = sign(
    JSON.stringify(noUpdateDirectiveSchema.parse({ type: "noUpdateAvailable" })),
  );

  const release = isRollback
    ? createRollbackRelease(selectedChannel, runtimeVersion, releaseId, createdAt, noUpdate, sign)
    : await createUpdateRelease(
        selectedChannel,
        runtimeVersion,
        releaseId,
        createdAt,
        noUpdate,
        expoConfig,
        updatesUrl,
        sign,
        adminToken,
      );

  validateReleaseSize(release);
  const serializedRelease = JSON.stringify(release);
  await putJson(updatesUrl, `/admin/releases/${releaseId}`, serializedRelease, adminToken);
  await activateRelease(updatesUrl, releaseId, expectedCurrent.currentReleaseId, adminToken);
  await writeReceipt(selectedChannel, updatesUrl, release);
  console.log(`Release ${releaseId} is active.`);
}

function createRollbackRelease(
  selectedChannel: "staging" | "production",
  runtimeVersion: string,
  releaseId: string,
  createdAt: string,
  noUpdate: SignedPayload,
  sign: (body: string) => SignedPayload,
) {
  const directive = rollbackDirectiveSchema.parse({
    type: "rollBackToEmbedded",
    parameters: { commitTime: createdAt },
  });
  return releaseRecordSchema.parse({
    schemaVersion: 1,
    kind: "rollback",
    channel: selectedChannel,
    runtimeVersion,
    releaseId,
    createdAt,
    noUpdate,
    directive: sign(JSON.stringify(directive)),
  });
}

async function createUpdateRelease(
  selectedChannel: "staging" | "production",
  runtimeVersion: string,
  releaseId: string,
  createdAt: string,
  noUpdate: SignedPayload,
  expoConfig: ExpoPublicConfig,
  updatesUrl: URL,
  sign: (body: string) => SignedPayload,
  adminToken: string,
) {
  const exportDirectory = await mkdtemp(join(tmpdir(), "code2create-update-"));
  try {
    await run(
      "pnpm",
      [
        "--filter",
        "@code2create/reviewer",
        "exec",
        "expo",
        "export",
        "--platform",
        "all",
        "--output-dir",
        exportDirectory,
        "--clear",
      ],
      repositoryRoot,
      nativeEnvironment(selectedChannel, true, releaseId),
    );

    const metadata = exportMetadataSchema.parse(
      JSON.parse(await readFile(join(exportDirectory, "metadata.json"), "utf8")),
    );
    const expoClient = z.json().parse(expoConfig);
    const assets = new Map<string, UploadAsset>();
    const manifests = {
      ios: await createPlatformManifest(
        "ios",
        metadata,
        exportDirectory,
        runtimeVersion,
        releaseId,
        createdAt,
        expoClient,
        updatesUrl,
        assets,
        sign,
      ),
      android: await createPlatformManifest(
        "android",
        metadata,
        exportDirectory,
        runtimeVersion,
        releaseId,
        createdAt,
        expoClient,
        updatesUrl,
        assets,
        sign,
      ),
    };

    const release = releaseRecordSchema.parse({
      schemaVersion: 1,
      kind: "update",
      channel: selectedChannel,
      runtimeVersion,
      releaseId,
      createdAt,
      noUpdate,
      platforms: manifests,
    });
    validateReleaseSize(release);
    for (const asset of assets.values()) validateAssetSize(asset);
    await forEachConcurrent([...assets.values()], 6, (asset) =>
      uploadAsset(updatesUrl, asset, adminToken),
    );
    return release;
  } finally {
    await rm(exportDirectory, { recursive: true, force: true });
  }
}

async function createPlatformManifest(
  platform: UpdatePlatform,
  metadata: ExportMetadata,
  exportDirectory: string,
  runtimeVersion: string,
  releaseId: string,
  createdAt: string,
  expoClient: z.infer<ReturnType<typeof z.json>>,
  updatesUrl: URL,
  uploadAssets: Map<string, UploadAsset>,
  sign: (body: string) => SignedPayload,
) {
  const platformMetadata = metadata.fileMetadata[platform];
  const launchAsset = await describeAsset(
    exportDirectory,
    platformMetadata.bundle,
    "bundle",
    "application/javascript",
    updatesUrl,
    uploadAssets,
  );
  const assets = await Promise.all(
    platformMetadata.assets.map(async (asset) => {
      const extension = normalizeExtension(asset.ext || extname(asset.path));
      const contentType = mime.getType(extension);
      if (contentType === null || contentType.length === 0) {
        throw new Error(`No MIME type is known for ${asset.path}.`);
      }
      return describeAsset(
        exportDirectory,
        asset.path,
        extension,
        contentType,
        updatesUrl,
        uploadAssets,
      );
    }),
  );
  const updateId = deterministicUuid(`${releaseId}:${platform}`);
  const manifest = updateManifestSchema.parse({
    id: updateId,
    createdAt,
    runtimeVersion,
    assets,
    launchAsset,
    metadata: {},
    extra: { expoClient },
  });
  return {
    updateId,
    manifest: sign(JSON.stringify(manifest)),
  };
}

async function describeAsset(
  exportDirectory: string,
  relativePath: string,
  extension: string,
  contentType: string,
  updatesUrl: URL,
  uploadAssets: Map<string, UploadAsset>,
) {
  const path = resolveExportPath(exportDirectory, relativePath);
  const buffer = await readFile(path);
  const bytes = Uint8Array.from(buffer);
  const key = createHash("sha256").update(bytes).digest("hex");
  const hash = createHash("sha256").update(bytes).digest("base64url");
  const existing = uploadAssets.get(key);
  if (existing && existing.contentType !== contentType) {
    throw new Error(`Asset ${key} was exported with two content types.`);
  }
  if (!existing) uploadAssets.set(key, { key, bytes, contentType });

  return {
    hash,
    key,
    fileExtension: `.${normalizeExtension(extension)}`,
    contentType,
    url: new URL(`/assets/${key}`, updatesUrl.origin).href,
  };
}

function signPayload(body: string, privateKey: string, certificate: X509Certificate) {
  const signer = createSign("RSA-SHA256");
  signer.update(body, "utf8");
  signer.end();
  const rawSignature = signer.sign(privateKey);
  if (!verifySignature("RSA-SHA256", Buffer.from(body), certificate.publicKey, rawSignature)) {
    throw new Error("The update signing key does not match the embedded certificate.");
  }
  return signedPayloadSchema.parse({
    body,
    signature: serializeDictionary({
      sig: Buffer.from(rawSignature).toString("base64"),
      keyid: "main",
    }),
  });
}

function verifySigningPair(privateKey: string, certificate: X509Certificate) {
  signPayload("code2create-signing-check", privateKey, certificate);
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
    throw new Error("The update signing certificate is not currently valid.");
  }
}

async function uploadAsset(updatesUrl: URL, asset: UploadAsset, adminToken: string) {
  const response = await updateFetch(
    new URL(`/admin/assets/${asset.key}`, updatesUrl.origin),
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": asset.contentType,
      },
      body: asset.bytes,
    },
    120_000,
  );
  if (!response.ok) throw await responseError(response, `upload asset ${asset.key}`);
}

async function verifyUpdateService(updatesUrl: URL, selectedChannel: "staging" | "production") {
  const response = await updateFetch(new URL("/health", updatesUrl.origin));
  if (!response.ok) throw await responseError(response, "check update service");
  const health = updateHealthResponseSchema.parse(
    await readBoundedJsonResponse(response, 4 * 1_024),
  );
  if (health.channel !== selectedChannel) {
    throw new Error(
      `The ${selectedChannel} publisher points at the ${health.channel} update service.`,
    );
  }
}

async function getCurrentRelease(updatesUrl: URL, runtimeVersion: string, adminToken: string) {
  const url = new URL("/admin/current", updatesUrl.origin);
  url.searchParams.set("runtimeVersion", runtimeVersion);
  const response = await updateFetch(url, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!response.ok) throw await responseError(response, "read current release");
  return currentReleaseResponseSchema.parse(await readBoundedJsonResponse(response, 4 * 1_024));
}

async function getRelease(updatesUrl: URL, releaseId: string, adminToken: string) {
  const response = await updateFetch(new URL(`/admin/releases/${releaseId}`, updatesUrl.origin), {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await responseError(response, "read release");
  return releaseRecordSchema.parse(await readBoundedJsonResponse(response, 10 * 1_024 * 1_024));
}

async function putJson(updatesUrl: URL, path: string, body: string, adminToken: string) {
  const response = await updateFetch(new URL(path, updatesUrl.origin), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body,
  });
  if (!response.ok) throw await responseError(response, `write ${path}`);
}

function validateAssetSize(asset: UploadAsset) {
  if (asset.bytes.byteLength > maximumUpdateAssetBytes) {
    throw new Error(`Update asset ${asset.key} exceeds the service limit.`);
  }
  return asset;
}

function validateReleaseSize(release: ReleaseRecord) {
  if (Buffer.byteLength(JSON.stringify(release), "utf8") > maximumUpdateReleaseBytes) {
    throw new Error("The update release metadata exceeds the service limit.");
  }
}

async function activateRelease(
  updatesUrl: URL,
  releaseId: string,
  expectedCurrentReleaseId: string | null,
  adminToken: string,
) {
  const response = await updateFetch(
    new URL(`/admin/releases/${releaseId}/activate`, updatesUrl.origin),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedCurrentReleaseId }),
    },
  );
  if (!response.ok) throw await responseError(response, "activate release");
}

async function responseError(response: Response, operation: string) {
  let detail = "The response body was unavailable.";
  try {
    detail = (await readBoundedResponseText(response, 4 * 1_024)).slice(0, 1_000);
  } catch {
    // The status and operation remain sufficient when an error body is malformed or oversized.
  }
  return new Error(`${operation} failed (${response.status}): ${detail}`);
}

function updateFetch(input: string | URL | Request, init: RequestInit = {}, timeoutMs = 30_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("The update request timeout must be a positive integer.");
  }
  const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return fetch(input, {
    ...init,
    signal: callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal,
  });
}

async function readExpoConfig(
  selectedChannel: "staging" | "production",
  requireNativeConfiguration: boolean,
  releaseId: string,
) {
  const output = await runAndCapture(
    "pnpm",
    ["--filter", "@code2create/reviewer", "exec", "expo", "config", "--type", "public", "--json"],
    repositoryRoot,
    nativeEnvironment(selectedChannel, requireNativeConfiguration, releaseId),
  );
  return expoPublicConfigSchema.parse(JSON.parse(output));
}

function resolveRuntimeVersion(config: ExpoPublicConfig) {
  if (typeof config.runtimeVersion === "string") {
    if (config.runtimeVersion !== config.version) {
      throw new Error("The resolved runtime version must match the application version.");
    }
    return runtimeVersionSchema.parse(config.runtimeVersion);
  }
  if (config.runtimeVersion?.policy !== "appVersion") {
    throw new Error("Reviewer updates must use the appVersion runtime policy.");
  }
  return runtimeVersionSchema.parse(config.version);
}

function readUpdatesUrl() {
  const url = new URL(requiredEnvironmentValue("C2C_UPDATES_URL"));
  if (url.protocol !== "https:" || url.pathname !== "/manifest" || url.search || url.hash) {
    throw new Error("C2C_UPDATES_URL must be an HTTPS URL ending at /manifest.");
  }
  return url;
}

function resolvePrivateKeyPath(value: string) {
  return isAbsolute(value) ? value : resolve(repositoryRoot, value);
}

function requiredEnvironmentValue(name: string) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`Set ${name}.`);
  return value;
}

function nativeEnvironment(
  selectedChannel: "staging" | "production",
  requireNativeConfiguration: boolean,
  releaseId: string,
) {
  return {
    ...process.env,
    C2C_NATIVE_BUILD: requireNativeConfiguration ? "true" : "false",
    EXPO_PUBLIC_DEPLOYMENT_ENVIRONMENT: selectedChannel,
    EXPO_PUBLIC_RELEASE_ID: releaseId,
  };
}

function loadEnvironmentFile(path: string) {
  if (existsSync(path)) process.loadEnvFile(path);
}

async function requireCleanGitTree() {
  const status = await runAndCapture("git", ["status", "--porcelain"], repositoryRoot);
  if (status.trim()) throw new Error("Commit the working tree before publishing an app update.");
}

function resolveExportPath(exportDirectory: string, filePath: string) {
  const resolved = resolve(exportDirectory, filePath);
  const pathFromRoot = relative(exportDirectory, resolved);
  if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || isAbsolute(pathFromRoot)) {
    throw new Error(`Export metadata contains an unsafe path: ${filePath}`);
  }
  return resolved;
}

function normalizeExtension(value: string) {
  const extension = value.replace(/^\./u, "").toLowerCase();
  if (!/^[a-z0-9]+$/u.test(extension)) throw new Error(`Invalid asset extension: ${value}`);
  return extension;
}

function deterministicUuid(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function compactTimestamp(date: Date) {
  return date.toISOString().replaceAll(/[-:.]/gu, "");
}

async function forEachConcurrent<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
) {
  for (let index = 0; index < values.length; index += concurrency) {
    await Promise.all(values.slice(index, index + concurrency).map(operation));
  }
}

async function writeReceipt(
  selectedChannel: "staging" | "production",
  updatesUrl: URL,
  release: ReleaseRecord,
) {
  const path = join(
    repositoryRoot,
    "outputs/updates",
    selectedChannel,
    `${release.releaseId}.json`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ endpoint: updatesUrl.href, activatedAt: new Date().toISOString(), release }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Wrote release receipt to ${path}`);
}

function validateExistingRelease(
  release: ReleaseRecord,
  selectedChannel: "staging" | "production",
  runtimeVersion: string,
  isRollback: boolean,
) {
  if (
    release.channel !== selectedChannel ||
    release.runtimeVersion !== runtimeVersion ||
    (release.kind === "rollback") !== isRollback
  ) {
    throw new Error("The existing release ID belongs to a different release configuration.");
  }
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}

async function runAndCapture(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(Buffer.concat(chunks).toString("utf8"));
      else rejectPromise(new Error(`${command} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}

interface UploadAsset {
  key: string;
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

const exportPlatformMetadataSchema = z.object({
  bundle: z.string().min(1),
  assets: z.array(
    z.object({
      path: z.string().min(1),
      ext: z.string(),
    }),
  ),
});

const exportMetadataSchema = z.object({
  version: z.number().int(),
  bundler: z.string().min(1),
  fileMetadata: z.object({
    ios: exportPlatformMetadataSchema,
    android: exportPlatformMetadataSchema,
  }),
});

type ExportMetadata = z.infer<typeof exportMetadataSchema>;

const expoPublicConfigSchema = z
  .object({
    version: runtimeVersionSchema,
    runtimeVersion: z.union([runtimeVersionSchema, z.object({ policy: z.literal("appVersion") })]),
    updates: z.object({
      url: z.url().refine((value) => value.startsWith("https://")),
    }),
  })
  .loose();

type ExpoPublicConfig = z.infer<typeof expoPublicConfigSchema>;

await publish(channel, rollback);
