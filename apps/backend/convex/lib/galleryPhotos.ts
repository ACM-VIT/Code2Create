import { ConvexError } from "convex/values";

export const photoMaximumBytes = 50 * 1024 * 1024;
export const photoContentTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;
export const photoUploadLifetime = 60 * 60_000;

export function validatePhotoInput(input: {
  fileName: string;
  caption: string;
  contentType: string;
  byteCount: number;
  sha256: string;
  clientOperationId: string;
}) {
  if (!photoContentTypes.some((type) => type === input.contentType)) {
    throw new ConvexError("Choose a JPEG, PNG, WebP, or AVIF photo.");
  }
  if (
    !Number.isSafeInteger(input.byteCount) ||
    input.byteCount < 1 ||
    input.byteCount > photoMaximumBytes
  ) {
    throw new ConvexError("Each photo must be between 1 byte and 50 MB.");
  }
  if (
    !input.fileName.trim() ||
    input.fileName.length > 180 ||
    [...input.fileName].some(
      (char) =>
        char.charCodeAt(0) < 32 ||
        char.charCodeAt(0) === 127 ||
        char === "/" ||
        char === "\\",
    )
  ) {
    throw new ConvexError(
      "Choose a photo with a valid filename (up to 180 characters).",
    );
  }
  if (input.caption.trim().length > 300)
    throw new ConvexError("Captions can contain up to 300 characters.");
  if (
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !/^[a-f0-9-]{36}$/.test(input.clientOperationId)
  ) {
    throw new ConvexError(
      "The upload identifier is invalid. Select the photo again.",
    );
  }
}

export function photoObjectKey(id: string, sha256: string) {
  return `photos/${id}/${sha256}`;
}

export function photoSourceUrl(origin: string, id: string, sha256: string) {
  return `${origin}/${photoObjectKey(id, sha256)}`;
}

export function photoVariantUrl(
  origin: string,
  id: string,
  sha256: string,
  width: number,
) {
  return `${origin}/cdn-cgi/image/width=${width},fit=scale-down,quality=85,format=auto/${photoObjectKey(id, sha256)}`;
}
