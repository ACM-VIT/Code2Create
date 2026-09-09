"use node";

import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { imageSize } from "image-size";
import { ConvexError } from "convex/values";
import { photoMaximumBytes } from "./galleryPhotos";
import { env } from "../_generated/server";

export function photoStorage() {
  const accountId = env.PHOTO_R2_ACCOUNT_ID;
  const accessKeyId = env.PHOTO_R2_ACCESS_KEY_ID;
  const secretAccessKey = env.PHOTO_R2_SECRET_ACCESS_KEY;
  const bucket = env.PHOTO_R2_BUCKET;
  const origin = env.PHOTO_PUBLIC_ORIGIN;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !origin) {
    throw new ConvexError("Photo uploads are not configured yet.");
  }
  if (
    !/^[a-f0-9]{32}$/.test(accountId) ||
    new URL(origin).protocol !== "https:"
  ) {
    throw new Error("Invalid photo storage configuration.");
  }
  return {
    bucket,
    client: new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED",
    }),
  };
}

export function inspectPhoto(
  bytes: Uint8Array,
  expected: { byteCount: number; sha256: string; contentType: string },
) {
  if (
    bytes.byteLength !== expected.byteCount ||
    bytes.byteLength > photoMaximumBytes ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  ) {
    throw new ConvexError(
      "The uploaded file does not match the selected original. Please retry.",
    );
  }
  let dimensions;
  try {
    dimensions = imageSize(bytes);
  } catch {
    throw new ConvexError("This file is not a supported photo.");
  }
  const contentTypes: Record<string, string> = {
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
  };
  if (contentTypes[dimensions.type ?? ""] !== expected.contentType)
    throw new ConvexError("The photo format does not match its file type.");
  const rotated =
    dimensions.orientation !== undefined &&
    dimensions.orientation >= 5 &&
    dimensions.orientation <= 8;
  const width = rotated ? dimensions.height : dimensions.width;
  const height = rotated ? dimensions.width : dimensions.height;
  if (
    !width ||
    !height ||
    width > 30000 ||
    height > 30000 ||
    width * height > 100_000_000
  ) {
    throw new ConvexError(
      "Choose a photo up to 100 megapixels and 30,000 pixels per side.",
    );
  }
  return { width, height };
}

export function photoDownloadDisposition(fileName: string) {
  const fallback = fileName.replace(/[^a-zA-Z0-9._ -]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
