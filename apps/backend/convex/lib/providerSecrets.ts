"use node";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { ConvexError } from "convex/values";

const ciphertextVersion = "v1";
const base64Url = /^[A-Za-z0-9_-]+$/;

function encryptionKey() {
  const encoded = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY?.trim();
  if (!encoded || encoded.length !== 43 || !base64Url.test(encoded)) {
    throw new ConvexError({
      code: "PROVIDER_ENCRYPTION_NOT_CONFIGURED",
      message: "Provider token encryption is not configured for this environment.",
    });
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) {
    throw new ConvexError({
      code: "PROVIDER_ENCRYPTION_NOT_CONFIGURED",
      message: "Provider token encryption is not configured for this environment.",
    });
  }
  return key;
}

export function encryptProviderSecret(secret: string) {
  if (!secret) {
    throw new ConvexError({
      code: "PROVIDER_SECRET_INVALID",
      message: "The provider returned an invalid secret.",
    });
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  return [
    ciphertextVersion,
    iv.toString("base64url"),
    authenticationTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptProviderSecret(ciphertext: string) {
  const parts = ciphertext.split(".");
  if (parts.length !== 4) {
    throw new ConvexError({
      code: "PROVIDER_SECRET_INVALID",
      message: "The stored provider authorization is invalid.",
    });
  }
  const version = parts[0];
  const encodedIv = parts[1];
  const encodedTag = parts[2];
  const encodedSecret = parts[3];
  if (
    version !== ciphertextVersion ||
    !encodedIv ||
    !encodedTag ||
    !encodedSecret ||
    !base64Url.test(encodedIv) ||
    !base64Url.test(encodedTag) ||
    !base64Url.test(encodedSecret)
  ) {
    throw new ConvexError({
      code: "PROVIDER_SECRET_INVALID",
      message: "The stored provider authorization is invalid.",
    });
  }
  const iv = Buffer.from(encodedIv, "base64url");
  const authenticationTag = Buffer.from(encodedTag, "base64url");
  const encrypted = Buffer.from(encodedSecret, "base64url");
  if (iv.length !== 12 || authenticationTag.length !== 16 || encrypted.length === 0) {
    throw new ConvexError({
      code: "PROVIDER_SECRET_INVALID",
      message: "The stored provider authorization is invalid.",
    });
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(authenticationTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    throw new ConvexError({
      code: "PROVIDER_SECRET_INVALID",
      message: "The stored provider authorization could not be opened.",
    });
  }
}
