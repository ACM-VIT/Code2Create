import { Buffer } from "node:buffer";

import { afterEach, describe, expect, test, vi } from "vitest";

import { decryptEventKey, encryptEventKey } from "./attendanceActions";

const encoder = new TextEncoder();

function wrappingKey(fill: number) {
  return Buffer.alloc(32, fill).toString("base64url");
}

function useCurrent(version: string, key: string) {
  vi.stubEnv("ATTENDANCE_WRAPPING_KEY_VERSION", version);
  vi.stubEnv("ATTENDANCE_WRAPPING_KEY", key);
}

function usePrevious(version: string, key: string) {
  vi.stubEnv("ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION", version);
  vi.stubEnv("ATTENDANCE_PREVIOUS_WRAPPING_KEY", key);
}

async function credentialFingerprint(eventKey: Uint8Array, rawValue: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(eventKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(rawValue)),
  );
  return Buffer.from(signature).toString("hex");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("attendance event-key rotation", () => {
  test("rewraps K1 to K2 to K3 without changing the event key or credential fingerprints", async () => {
    const eventSlug = "rotation-event";
    const eventKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const firstWrappingKey = wrappingKey(21);
    const secondWrappingKey = wrappingKey(22);
    const thirdWrappingKey = wrappingKey(23);
    const originalFingerprint = await credentialFingerprint(eventKey, "VIT-12345");

    useCurrent("attendance-k1", firstWrappingKey);
    const underK1 = await encryptEventKey(eventSlug, eventKey);

    useCurrent("attendance-k2", secondWrappingKey);
    vi.stubEnv("ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION", "");
    vi.stubEnv("ATTENDANCE_PREVIOUS_WRAPPING_KEY", "");
    await expect(decryptEventKey({ eventSlug, ...underK1 })).rejects.toBeDefined();

    usePrevious("attendance-k1", firstWrappingKey);
    const openedFromK1 = await decryptEventKey({ eventSlug, ...underK1 });
    const underK2 = await encryptEventKey(eventSlug, openedFromK1);
    expect(await credentialFingerprint(openedFromK1, "VIT-12345")).toBe(
      originalFingerprint,
    );

    useCurrent("attendance-k3", thirdWrappingKey);
    usePrevious("attendance-k2", secondWrappingKey);
    const openedFromK2 = await decryptEventKey({ eventSlug, ...underK2 });
    const underK3 = await encryptEventKey(eventSlug, openedFromK2);
    expect(await credentialFingerprint(openedFromK2, "VIT-12345")).toBe(
      originalFingerprint,
    );

    vi.stubEnv("ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION", "");
    vi.stubEnv("ATTENDANCE_PREVIOUS_WRAPPING_KEY", "");
    const openedFromK3 = await decryptEventKey({ eventSlug, ...underK3 });
    expect(await credentialFingerprint(openedFromK3, "VIT-12345")).toBe(
      originalFingerprint,
    );
  });

  test("rejects ciphertext or event ownership that fails AES-GCM authentication", async () => {
    useCurrent("attendance-k1", wrappingKey(24));
    const encrypted = await encryptEventKey(
      "rotation-event",
      Uint8Array.from({ length: 32 }, () => 7),
    );
    const corruptedAuthTag = `${encrypted.authTag[0] === "A" ? "B" : "A"}${encrypted.authTag.slice(1)}`;
    await expect(
      decryptEventKey({
        eventSlug: "rotation-event",
        ...encrypted,
        authTag: corruptedAuthTag,
      }),
    ).rejects.toBeDefined();
    await expect(
      decryptEventKey({ eventSlug: "another-event", ...encrypted }),
    ).rejects.toBeDefined();
  });

  test("rejects malformed, incomplete, and reused wrapping-key configuration", async () => {
    useCurrent("attendance-k1", "short");
    await expect(
      encryptEventKey("rotation-event", Uint8Array.from({ length: 32 }, () => 1)),
    ).rejects.toThrow("attendance key configuration is invalid");

    useCurrent("attendance-k2", wrappingKey(25));
    vi.stubEnv("ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION", "attendance-k1");
    vi.stubEnv("ATTENDANCE_PREVIOUS_WRAPPING_KEY", "");
    await expect(
      encryptEventKey("rotation-event", Uint8Array.from({ length: 32 }, () => 2)),
    ).rejects.toThrow("attendance key configuration is invalid");

    usePrevious("attendance-k2", wrappingKey(26));
    await expect(
      encryptEventKey("rotation-event", Uint8Array.from({ length: 32 }, () => 3)),
    ).rejects.toThrow("attendance key configuration is invalid");

    useCurrent("attendance-k3", wrappingKey(27));
    usePrevious("attendance-k2", wrappingKey(27));
    await expect(
      encryptEventKey("rotation-event", Uint8Array.from({ length: 32 }, () => 4)),
    ).rejects.toThrow("attendance key configuration is invalid");
  });
});
