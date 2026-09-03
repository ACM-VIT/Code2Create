import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  GetObjectAttributesCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { sha256File, storedObjectSchema, type StoredObject } from "./archive.ts";

type RecoveryStorageConfiguration = {
  region: "ap-south-1";
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  kmsKeyId: string;
};

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} through the recovery operator's secret manager.`);
  return value;
}

export function recoveryStorageConfiguration(): RecoveryStorageConfiguration {
  const region = requiredEnvironment("C2C_RECOVERY_S3_REGION");
  if (region !== "ap-south-1") {
    throw new Error("Recovery objects must use the approved ap-south-1 region.");
  }
  return {
    region,
    bucket: requiredEnvironment("C2C_RECOVERY_S3_BUCKET"),
    accessKeyId: requiredEnvironment("C2C_RECOVERY_S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnvironment("C2C_RECOVERY_S3_SECRET_ACCESS_KEY"),
    kmsKeyId: requiredEnvironment("C2C_RECOVERY_S3_KMS_KEY_ID"),
  };
}

function client(config: RecoveryStorageConfiguration) {
  return new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function checksumBase64(sha256: string) {
  return Buffer.from(sha256, "hex").toString("base64");
}

export async function uploadVersionedRecoveryFile(args: {
  path: string;
  key: string;
  contentType: string;
  sha256: string;
  metadata: Record<string, string>;
}): Promise<StoredObject> {
  const config = recoveryStorageConfiguration();
  const fileStats = await stat(args.path);
  if (!fileStats.isFile() || fileStats.size < 1) throw new Error("Recovery upload is empty.");
  const checksum = checksumBase64(args.sha256);
  const s3 = client(config);
  const uploaded = await s3.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: args.key,
      Body: createReadStream(args.path),
      ContentLength: fileStats.size,
      ContentType: args.contentType,
      ChecksumSHA256: checksum,
      IfNoneMatch: "*",
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: config.kmsKeyId,
      BucketKeyEnabled: true,
      Metadata: args.metadata,
    }),
  );
  const versionId = uploaded.VersionId?.trim();
  if (!versionId) {
    throw new Error("Recovery bucket versioning is required; S3 returned no object version.");
  }
  const [attributes, head] = await Promise.all([
    s3.send(
      new GetObjectAttributesCommand({
        Bucket: config.bucket,
        Key: args.key,
        VersionId: versionId,
        ObjectAttributes: ["Checksum", "ObjectSize"],
      }),
    ),
    s3.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: args.key,
        VersionId: versionId,
      }),
    ),
  ]);
  if (
    attributes.ObjectSize !== fileStats.size ||
    attributes.Checksum?.ChecksumSHA256 !== checksum ||
    head.ServerSideEncryption !== "aws:kms" ||
    !head.SSEKMSKeyId ||
    head.BucketKeyEnabled !== true
  ) {
    throw new Error("S3 read-back attributes or encryption do not match the recovery file.");
  }
  return storedObjectSchema.parse({
    region: config.region,
    bucket: config.bucket,
    key: args.key,
    versionId,
    byteCount: fileStats.size,
    sha256: args.sha256,
  });
}

export async function downloadExactRecoveryObject(args: {
  object: StoredObject;
  destinationPath: string;
}) {
  const config = recoveryStorageConfiguration();
  if (args.object.region !== config.region || args.object.bucket !== config.bucket) {
    throw new Error("The manifest points to a different recovery bucket or region.");
  }
  const response = await client(config).send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: args.object.key,
      VersionId: args.object.versionId,
      ChecksumMode: "ENABLED",
    }),
  );
  const body = response.Body;
  if (!(body instanceof Readable)) throw new Error("S3 returned no readable backup body.");
  try {
    await pipeline(body, createWriteStream(args.destinationPath, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    await rm(args.destinationPath, { force: true });
    throw error;
  }
  const [downloadStats, sha256] = await Promise.all([
    stat(args.destinationPath),
    sha256File(args.destinationPath),
  ]);
  if (
    downloadStats.size !== args.object.byteCount ||
    sha256 !== args.object.sha256 ||
    response.VersionId !== args.object.versionId ||
    (response.ChecksumSHA256 !== undefined &&
      response.ChecksumSHA256 !== checksumBase64(args.object.sha256))
  ) {
    throw new Error("The exact downloaded S3 backup version failed checksum validation.");
  }
}
