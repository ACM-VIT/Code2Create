import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ConvexError } from "convex/values";

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function normalizedText(value: string, field: string, minimum: number, maximum: number) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ConvexError({
      code: "INVALID_FIELD",
      field,
      message: `${field} must be between ${minimum} and ${maximum} characters.`,
    });
  }
  return normalized;
}

export function normalizedLongText(value: string, field: string, minimum: number, maximum: number) {
  const normalized = value.trim().replace(/\r\n/g, "\n");
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ConvexError({
      code: "INVALID_FIELD",
      field,
      message: `${field} must be between ${minimum} and ${maximum} characters.`,
    });
  }
  return normalized;
}

export function optionalNormalizedText(value: string | undefined, field: string, maximum: number) {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  if (normalized.length > maximum) {
    throw new ConvexError({
      code: "INVALID_FIELD",
      field,
      message: `${field} must be at most ${maximum} characters.`,
    });
  }
  return normalized;
}

export function normalizeCode(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function fingerprintText(value: string) {
  return bytesToHex(sha256(utf8ToBytes(value)));
}
