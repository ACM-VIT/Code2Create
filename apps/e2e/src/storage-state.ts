import { Buffer } from "node:buffer";

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

const maximumJsonNestingDepth = 32;
type JsonValidation = "valid" | "invalid" | "too_deep";

type StorageState = {
  cookies: readonly JsonObject[];
  origins: readonly JsonObject[];
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters
function validateJsonValue(value: unknown): JsonValidation {
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];

  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current.depth > maximumJsonNestingDepth) return "too_deep";
    if (
      current.value === null ||
      typeof current.value === "boolean" ||
      typeof current.value === "number" ||
      typeof current.value === "string"
    ) {
      continue;
    }
    if (typeof current.value !== "object") return "invalid";

    const entries = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const entry of entries) {
      pending.push({ depth: current.depth + 1, value: entry });
    }
  }

  return "valid";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    validateJsonValue(value) === "valid"
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
  const validation = validateJsonValue(parsed);
  if (validation === "too_deep") {
    throw new Error(`${label} storage state exceeds the maximum nesting depth.`);
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
