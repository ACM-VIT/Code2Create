"use node";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { ConvexError } from "convex/values";

const ciphertextFormat = "v2";
const base64Url = /^[A-Za-z0-9_-]+$/u;
const keyVersion = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

type ProviderEncryptionKey = {
  version: string;
  key: Buffer;
};

type ParsedCiphertext = {
  keyVersion: string;
  iv: Buffer;
  authenticationTag: Buffer;
  encrypted: Buffer;
};

function configurationError(): never {
  throw new ConvexError({
    code: "PROVIDER_ENCRYPTION_NOT_CONFIGURED",
    message: "Provider token encryption is not configured for this environment.",
  });
}

function configuredKey(versionName: string, keyName: string): ProviderEncryptionKey {
  const version = process.env[versionName]?.trim();
  const encoded = process.env[keyName]?.trim();
  if (
    !version ||
    !keyVersion.test(version) ||
    !encoded ||
    encoded.length !== 43 ||
    !base64Url.test(encoded)
  ) {
    return configurationError();
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) return configurationError();
  return { version, key };
}

function currentEncryptionKey() {
  return configuredKey("PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION", "PROVIDER_TOKEN_ENCRYPTION_KEY");
}

function previousEncryptionKey(): ProviderEncryptionKey | null {
  const hasVersion = Boolean(process.env.PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION?.trim());
  const hasKey = Boolean(process.env.PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY?.trim());
  if (!hasVersion && !hasKey) return null;
  if (!hasVersion || !hasKey) return configurationError();
  const previous = configuredKey(
    "PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION",
    "PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY",
  );
  const current = currentEncryptionKey();
  if (previous.version === current.version || previous.key.equals(current.key)) {
    return configurationError();
  }
  return previous;
}

function invalidCiphertext(message: string): never {
  throw new ConvexError({ code: "PROVIDER_SECRET_INVALID", message });
}

function parseCiphertext(ciphertext: string): ParsedCiphertext {
  const parts = ciphertext.split(".");
  if (parts.length !== 5) {
    return invalidCiphertext("The stored provider authorization is invalid.");
  }
  const [format, storedKeyVersion, encodedIv, encodedTag, encodedSecret] = parts;
  if (
    format !== ciphertextFormat ||
    !storedKeyVersion ||
    !keyVersion.test(storedKeyVersion) ||
    !encodedIv ||
    !encodedTag ||
    !encodedSecret ||
    !base64Url.test(encodedIv) ||
    !base64Url.test(encodedTag) ||
    !base64Url.test(encodedSecret)
  ) {
    return invalidCiphertext("The stored provider authorization is invalid.");
  }
  const iv = Buffer.from(encodedIv, "base64url");
  const authenticationTag = Buffer.from(encodedTag, "base64url");
  const encrypted = Buffer.from(encodedSecret, "base64url");
  if (iv.length !== 12 || authenticationTag.length !== 16 || encrypted.length === 0) {
    return invalidCiphertext("The stored provider authorization is invalid.");
  }
  return { keyVersion: storedKeyVersion, iv, authenticationTag, encrypted };
}

function encryptionKeyForVersion(version: string) {
  const current = currentEncryptionKey();
  const previous = previousEncryptionKey();
  if (current.version === version) return current.key;
  if (previous?.version === version) return previous.key;
  throw new ConvexError({
    code: "PROVIDER_SECRET_KEY_UNAVAILABLE",
    message: "The stored provider authorization uses an unavailable encryption key.",
  });
}

export function currentProviderSecretKeyVersion() {
  const current = currentEncryptionKey();
  previousEncryptionKey();
  return current.version;
}

export function providerSecretKeyVersion(ciphertext: string) {
  return parseCiphertext(ciphertext).keyVersion;
}

export function encryptProviderSecret(secret: string) {
  if (!secret) {
    throw new ConvexError({
      code: "PROVIDER_SECRET_INVALID",
      message: "The provider returned an invalid secret.",
    });
  }
  const current = currentEncryptionKey();
  previousEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", current.key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  return [
    ciphertextFormat,
    current.version,
    iv.toString("base64url"),
    authenticationTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptProviderSecret(ciphertext: string) {
  const parsed = parseCiphertext(ciphertext);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKeyForVersion(parsed.keyVersion),
      parsed.iv,
    );
    decipher.setAuthTag(parsed.authenticationTag);
    return Buffer.concat([decipher.update(parsed.encrypted), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof ConvexError) throw error;
    throw new ConvexError({
      code: "PROVIDER_SECRET_INVALID",
      message: "The stored provider authorization could not be opened.",
    });
  }
}

export function reencryptProviderSecret(ciphertext: string) {
  if (providerSecretKeyVersion(ciphertext) === currentProviderSecretKeyVersion()) {
    return ciphertext;
  }
  return encryptProviderSecret(decryptProviderSecret(ciphertext));
}
