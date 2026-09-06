"use node";

import { createHash } from "node:crypto";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConvexError } from "convex/values";

const artifactRegion = "ap-south-1";
const maximumAttendanceExportBytes = 10 * 1024 * 1024;
const maximumEmergencyPackBytes = 25 * 1024 * 1024;
const maximumRoundExportBytes = 50 * 1024 * 1024;

type ArtifactStorageConfiguration = {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  kmsKeyId: string;
};

export type StoredArtifact = {
  objectKey: string;
  storageRegion: string;
  storageBucket: string;
  uncompressedBytes: number;
  storedBytes: number;
  sha256: string;
};

export type StoredRoundExportFile = {
  objectKey: string;
  objectVersionId: string;
  byteCount: number;
  sha256: string;
};

export type StoredRoundExportFiles = {
  storageRegion: string;
  storageBucket: string;
  json: StoredRoundExportFile;
  csv: StoredRoundExportFile;
};

export type StoredEmergencyPackFile = StoredRoundExportFile & {
  storageRegion: string;
  storageBucket: string;
};

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConvexError({
      code: "ARTIFACT_STORE_NOT_CONFIGURED",
      message: "Private artifact storage is not configured.",
    });
  }
  return value;
}

function configuration(): ArtifactStorageConfiguration {
  const region = requiredEnvironment("ARTIFACT_S3_REGION");
  if (region !== artifactRegion) {
    throw new ConvexError({
      code: "ARTIFACT_STORE_REGION_INVALID",
      message: "Private project evidence must use the approved Mumbai storage region.",
    });
  }
  return {
    region,
    bucket: requiredEnvironment("ARTIFACT_S3_BUCKET"),
    accessKeyId: requiredEnvironment("ARTIFACT_S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnvironment("ARTIFACT_S3_SECRET_ACCESS_KEY"),
    kmsKeyId: requiredEnvironment("ARTIFACT_S3_KMS_KEY_ID"),
  };
}

function client(config: ArtifactStorageConfiguration) {
  return new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function digest(value: string | Uint8Array, encoding: "hex" | "base64") {
  return createHash("sha256").update(value).digest(encoding);
}

function opaqueKeyPart(value: string) {
  return digest(value, "hex").slice(0, 32);
}

export function artifactStorageConfigured() {
  return Boolean(
    process.env.ARTIFACT_S3_REGION?.trim() === artifactRegion &&
    process.env.ARTIFACT_S3_BUCKET?.trim() &&
    process.env.ARTIFACT_S3_ACCESS_KEY_ID?.trim() &&
    process.env.ARTIFACT_S3_SECRET_ACCESS_KEY?.trim() &&
    process.env.ARTIFACT_S3_KMS_KEY_ID?.trim(),
  );
}

export async function storeAttendanceExport(args: {
  eventId: string;
  exportId: string;
  csv: string;
}): Promise<StoredArtifact> {
  const body = Buffer.from(args.csv, "utf8");
  if (body.byteLength < 1 || body.byteLength > maximumAttendanceExportBytes) {
    throw new ConvexError({
      code: "ATTENDANCE_EXPORT_TOO_LARGE",
      message: "This attendance export is too large for one protected download.",
    });
  }
  const config = configuration();
  const sha256 = digest(body, "hex");
  const objectKey = [
    "events",
    opaqueKeyPart(args.eventId),
    "exports",
    "attendance",
    `${opaqueKeyPart(args.exportId)}.csv`,
  ].join("/");
  await client(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: body,
      ContentType: "text/csv; charset=utf-8",
      ContentLength: body.byteLength,
      ChecksumSHA256: digest(body, "base64"),
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: config.kmsKeyId,
      BucketKeyEnabled: true,
      Metadata: {
        source: "attendance-export",
        sha256,
      },
    }),
  );
  return {
    objectKey,
    storageRegion: config.region,
    storageBucket: config.bucket,
    uncompressedBytes: body.byteLength,
    storedBytes: body.byteLength,
    sha256,
  };
}

export async function storeEmergencyPack(args: {
  eventId: string;
  packId: string;
  html: string;
}): Promise<StoredEmergencyPackFile> {
  const body = Buffer.from(args.html, "utf8");
  if (body.byteLength < 1 || body.byteLength > maximumEmergencyPackBytes) {
    throw new ConvexError({
      code: "EMERGENCY_PACK_TOO_LARGE",
      message: "This emergency pack is too large for one protected print document.",
    });
  }
  const config = configuration();
  const sha256 = digest(body, "hex");
  const objectKey = [
    "events",
    opaqueKeyPart(args.eventId),
    "exports",
    "emergency-packs",
    opaqueKeyPart(args.packId),
    "pack.html",
  ].join("/");
  const response = await client(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: body,
      ContentType: "text/html; charset=utf-8",
      CacheControl: "private, no-store, max-age=0",
      ContentLength: body.byteLength,
      ChecksumSHA256: digest(body, "base64"),
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: config.kmsKeyId,
      BucketKeyEnabled: true,
      Metadata: {
        source: "emergency-pack",
        sha256,
      },
    }),
  );
  if (!response.VersionId) {
    throw new ConvexError({
      code: "ARTIFACT_STORE_VERSIONING_REQUIRED",
      message: "Private emergency packs require S3 bucket versioning.",
    });
  }
  const stored = await client(config).send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      VersionId: response.VersionId,
    }),
  );
  if (!stored.Body) {
    throw new ConvexError({
      code: "EMERGENCY_PACK_UNAVAILABLE",
      message: "The emergency pack could not be read back from private storage.",
    });
  }
  const storedBody = await stored.Body.transformToByteArray();
  if (
    stored.ContentLength !== body.byteLength ||
    storedBody.byteLength !== body.byteLength ||
    digest(storedBody, "hex") !== sha256
  ) {
    throw new ConvexError({
      code: "EMERGENCY_PACK_CHECKSUM_MISMATCH",
      message: "The stored emergency pack does not match its generated document.",
    });
  }
  return {
    objectKey,
    objectVersionId: response.VersionId,
    storageRegion: config.region,
    storageBucket: config.bucket,
    byteCount: body.byteLength,
    sha256,
  };
}

async function putRoundExportFile(args: {
  config: ArtifactStorageConfiguration;
  objectKey: string;
  body: Buffer;
  contentType: string;
  kind: "json" | "csv";
}) {
  if (args.body.byteLength < 1 || args.body.byteLength > maximumRoundExportBytes) {
    throw new ConvexError({
      code: "ROUND_EXPORT_TOO_LARGE",
      message: `The round ${args.kind.toUpperCase()} export exceeds the protected file limit.`,
    });
  }
  const sha256 = digest(args.body, "hex");
  const response = await client(args.config).send(
    new PutObjectCommand({
      Bucket: args.config.bucket,
      Key: args.objectKey,
      Body: args.body,
      ContentType: args.contentType,
      ContentLength: args.body.byteLength,
      ChecksumSHA256: digest(args.body, "base64"),
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: args.config.kmsKeyId,
      BucketKeyEnabled: true,
      Metadata: {
        source: "round-export",
        kind: args.kind,
        sha256,
      },
    }),
  );
  if (!response.VersionId) {
    throw new ConvexError({
      code: "ARTIFACT_STORE_VERSIONING_REQUIRED",
      message: "Private round exports require S3 bucket versioning.",
    });
  }
  return {
    objectKey: args.objectKey,
    objectVersionId: response.VersionId,
    byteCount: args.body.byteLength,
    sha256,
  } satisfies StoredRoundExportFile;
}

async function verifyStoredFile(args: {
  config: ArtifactStorageConfiguration;
  file: StoredRoundExportFile;
}) {
  if (
    args.file.byteCount < 1 ||
    args.file.byteCount > maximumRoundExportBytes ||
    !/^[a-f0-9]{64}$/.test(args.file.sha256)
  ) {
    throw new ConvexError({
      code: "ROUND_EXPORT_MANIFEST_INVALID",
      message: "The round export file manifest is invalid.",
    });
  }
  const response = await client(args.config).send(
    new GetObjectCommand({
      Bucket: args.config.bucket,
      Key: args.file.objectKey,
      VersionId: args.file.objectVersionId,
    }),
  );
  if (!response.Body) {
    throw new ConvexError({
      code: "ROUND_EXPORT_UNAVAILABLE",
      message: "A round export file could not be read from private storage.",
    });
  }
  const body = await response.Body.transformToByteArray();
  if (
    response.ContentLength !== args.file.byteCount ||
    body.byteLength !== args.file.byteCount ||
    digest(body, "hex") !== args.file.sha256
  ) {
    throw new ConvexError({
      code: "ROUND_EXPORT_CHECKSUM_MISMATCH",
      message: "A round export file does not match its recorded checksum.",
    });
  }
}

export async function storeRoundExport(args: {
  eventId: string;
  roundId: string;
  exportId: string;
  json: string;
  csv: string;
}): Promise<StoredRoundExportFiles> {
  const config = configuration();
  const prefix = [
    "events",
    opaqueKeyPart(args.eventId),
    "exports",
    "rounds",
    opaqueKeyPart(args.roundId),
    opaqueKeyPart(args.exportId),
  ].join("/");
  const [json, csv] = await Promise.all([
    putRoundExportFile({
      config,
      objectKey: `${prefix}/round.json`,
      body: Buffer.from(args.json, "utf8"),
      contentType: "application/json; charset=utf-8",
      kind: "json",
    }),
    putRoundExportFile({
      config,
      objectKey: `${prefix}/scorecards.csv`,
      body: Buffer.from(args.csv, "utf8"),
      contentType: "text/csv; charset=utf-8",
      kind: "csv",
    }),
  ]);
  const files = {
    storageRegion: config.region,
    storageBucket: config.bucket,
    json,
    csv,
  } satisfies StoredRoundExportFiles;
  await verifyRoundExport(files);
  return files;
}

export async function verifyRoundExport(files: StoredRoundExportFiles) {
  const config = configuration();
  if (files.storageRegion !== config.region || files.storageBucket !== config.bucket) {
    throw new ConvexError({
      code: "ARTIFACT_STORE_MISMATCH",
      message: "This round export belongs to another storage configuration.",
    });
  }
  await Promise.all([
    verifyStoredFile({ config, file: files.json }),
    verifyStoredFile({ config, file: files.csv }),
  ]);
}

export async function signRoundExportDownload(args: {
  files: StoredRoundExportFiles;
  kind: "json" | "csv";
}) {
  const config = configuration();
  if (args.files.storageRegion !== config.region || args.files.storageBucket !== config.bucket) {
    throw new ConvexError({
      code: "ARTIFACT_STORE_MISMATCH",
      message: "This round export belongs to another storage configuration.",
    });
  }
  const file = args.files[args.kind];
  const name = args.kind === "json" ? "code2create-round.json" : "code2create-scorecards.csv";
  const contentType = args.kind === "json" ? "application/json" : "text/csv; charset=utf-8";
  return getSignedUrl(
    client(config),
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: file.objectKey,
      VersionId: file.objectVersionId,
      ResponseContentDisposition: `attachment; filename="${name}"`,
      ResponseContentType: contentType,
    }),
    { expiresIn: 60 },
  );
}

export async function signAttendanceExportDownload(args: {
  objectKey: string;
  storageRegion: string;
  storageBucket: string;
  expiresInSeconds: number;
}) {
  const config = configuration();
  if (args.storageRegion !== config.region || args.storageBucket !== config.bucket) {
    throw new ConvexError({
      code: "ARTIFACT_STORE_MISMATCH",
      message: "This attendance export belongs to another storage configuration.",
    });
  }
  if (
    !Number.isSafeInteger(args.expiresInSeconds) ||
    args.expiresInSeconds < 1 ||
    args.expiresInSeconds > 60
  ) {
    throw new ConvexError({
      code: "EXPORT_DOWNLOAD_EXPIRY_INVALID",
      message: "This attendance download expiry is invalid.",
    });
  }
  return getSignedUrl(
    client(config),
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: args.objectKey,
      ResponseContentDisposition: 'attachment; filename="code2create-attendance.csv"',
      ResponseContentType: "text/csv; charset=utf-8",
    }),
    { expiresIn: args.expiresInSeconds },
  );
}

export async function signEmergencyPackDownload(args: {
  objectKey: string;
  objectVersionId: string;
  storageRegion: string;
  storageBucket: string;
  expiresInSeconds: number;
}) {
  const config = configuration();
  if (args.storageRegion !== config.region || args.storageBucket !== config.bucket) {
    throw new ConvexError({
      code: "ARTIFACT_STORE_MISMATCH",
      message: "This emergency pack belongs to another storage configuration.",
    });
  }
  if (
    !Number.isSafeInteger(args.expiresInSeconds) ||
    args.expiresInSeconds < 1 ||
    args.expiresInSeconds > 60
  ) {
    throw new ConvexError({
      code: "EMERGENCY_PACK_PRINT_EXPIRY_INVALID",
      message: "This emergency-pack print-link expiry is invalid.",
    });
  }
  return getSignedUrl(
    client(config),
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: args.objectKey,
      VersionId: args.objectVersionId,
      ResponseCacheControl: "private, no-store, max-age=0",
      ResponseContentDisposition: 'inline; filename="code2create-emergency-pack.html"',
      ResponseContentType: "text/html; charset=utf-8",
    }),
    { expiresIn: args.expiresInSeconds },
  );
}
