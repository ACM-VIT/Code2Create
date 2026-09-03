import { Buffer } from "node:buffer";

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

type StorageState = {
  cookies: readonly JsonObject[];
  origins: readonly JsonObject[];
};

// This is the owning JSON boundary: unknown input must be narrowed before it enters StorageState.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

// Recursive JSON validation owns the same untrusted-input boundary as isJsonObject.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    isJsonObject(value)
  );
}

export function decodeStorageState(encoded: string, label: string): StorageState {
  const value = encoded.trim();
  if (value.length === 0 || !/^[a-zA-Z0-9+/=]+$/u.test(value)) {
    throw new Error(`${label} storage state is not valid base64.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf-8"));
  } catch {
    throw new Error(`${label} storage state is not valid JSON.`);
  }
  if (
    !isJsonObject(parsed) ||
    !Array.isArray(parsed.cookies) ||
    !Array.isArray(parsed.origins) ||
    parsed.cookies.length === 0
  ) {
    throw new Error(
      `${label} storage state must contain at least one cookie and an origins array.`,
    );
  }
  if (Object.keys(parsed).some((key) => key !== "cookies" && key !== "origins")) {
    throw new Error(`${label} storage state contains an unsupported top-level field.`);
  }
  if (!parsed.cookies.every(isJsonObject) || !parsed.origins.every(isJsonObject)) {
    throw new Error(`${label} storage state contains an invalid entry.`);
  }
  return { cookies: parsed.cookies, origins: parsed.origins };
}
