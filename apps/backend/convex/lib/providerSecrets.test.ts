import { Buffer } from "node:buffer";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  currentProviderSecretKeyVersion,
  decryptProviderSecret,
  encryptProviderSecret,
  providerSecretKeyVersion,
  reencryptProviderSecret,
} from "./providerSecrets";

function key(fill: number) {
  return Buffer.alloc(32, fill).toString("base64url");
}

function useCurrent(version: string, value: string) {
  vi.stubEnv("PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION", version);
  vi.stubEnv("PROVIDER_TOKEN_ENCRYPTION_KEY", value);
}

function usePrevious(version: string, value: string) {
  vi.stubEnv("PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION", version);
  vi.stubEnv("PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY", value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider secret encryption", () => {
  test("writes the current key version and authenticates ciphertext", () => {
    useCurrent("provider-k1", key(1));
    const ciphertext = encryptProviderSecret("provider-token");

    expect(currentProviderSecretKeyVersion()).toBe("provider-k1");
    expect(providerSecretKeyVersion(ciphertext)).toBe("provider-k1");
    expect(decryptProviderSecret(ciphertext)).toBe("provider-token");

    const parts = ciphertext.split(".");
    const encodedSecret = parts[4];
    if (!encodedSecret) throw new Error("Encrypted test payload is missing.");
    const damagedSecret = Buffer.from(encodedSecret, "base64url");
    damagedSecret.writeUInt8(damagedSecret.readUInt8(0) ^ 1, 0);
    parts[4] = damagedSecret.toString("base64url");
    const damaged = parts.join(".");
    expect(() => decryptProviderSecret(damaged)).toThrow(
      "stored provider authorization could not be opened",
    );
  });

  test("reads only the current and one previous key and re-encrypts every live owner", () => {
    const firstKey = key(2);
    const secondKey = key(3);
    useCurrent("provider-k1", firstKey);
    const owners = {
      accessTokenCiphertext: encryptProviderSecret("access-token"),
      refreshTokenCiphertext: encryptProviderSecret("refresh-token"),
      pkceVerifierCiphertext: encryptProviderSecret("pkce-verifier"),
    };

    useCurrent("provider-k2", secondKey);
    usePrevious("provider-k1", firstKey);
    const rotated = {
      accessTokenCiphertext: reencryptProviderSecret(owners.accessTokenCiphertext),
      refreshTokenCiphertext: reencryptProviderSecret(owners.refreshTokenCiphertext),
      pkceVerifierCiphertext: reencryptProviderSecret(owners.pkceVerifierCiphertext),
    };

    for (const ciphertext of Object.values(rotated)) {
      expect(providerSecretKeyVersion(ciphertext)).toBe("provider-k2");
    }
    expect(decryptProviderSecret(rotated.accessTokenCiphertext)).toBe("access-token");
    expect(decryptProviderSecret(rotated.refreshTokenCiphertext)).toBe("refresh-token");
    expect(decryptProviderSecret(rotated.pkceVerifierCiphertext)).toBe("pkce-verifier");

    vi.stubEnv("PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION", "");
    vi.stubEnv("PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY", "");
    expect(() => decryptProviderSecret(owners.accessTokenCiphertext)).toThrow(
      "unavailable encryption key",
    );
    expect(decryptProviderSecret(rotated.accessTokenCiphertext)).toBe("access-token");
  });

  test("rejects an incomplete previous-key pair", () => {
    useCurrent("provider-k2", key(4));
    vi.stubEnv("PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION", "provider-k1");
    expect(() => decryptProviderSecret(encryptProviderSecret("token"))).toThrow(
      "not configured",
    );
  });

  test("rejects a cosmetic rotation that reuses current key material", () => {
    const reused = key(5);
    useCurrent("provider-k2", reused);
    usePrevious("provider-k1", reused);
    expect(() => encryptProviderSecret("token")).toThrow("not configured");
  });
});
