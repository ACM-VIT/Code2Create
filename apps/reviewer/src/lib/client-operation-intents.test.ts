/* eslint-disable import/first -- native modules must be mocked before the module under test loads. */
import { beforeEach, describe, expect, test, vi } from "vitest";

const secureStore = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
});

const crypto = vi.hoisted(() => {
  let nextId = 1;
  return {
    reset() {
      nextId = 1;
    },
    digestStringAsync: vi.fn(async (_algorithm: string, value: string) =>
      (value === "claim-team-a" ? "a" : "b").repeat(64),
    ),
    randomUUID: vi.fn(() => {
      const suffix = String(nextId).padStart(12, "0");
      nextId += 1;
      return `00000000-0000-4000-8000-${suffix}`;
    }),
  };
});

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "when-unlocked",
  getItemAsync: secureStore.getItemAsync,
  setItemAsync: secureStore.setItemAsync,
  deleteItemAsync: secureStore.deleteItemAsync,
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: crypto.digestStringAsync,
  randomUUID: crypto.randomUUID,
}));

import {
  confirmObservedClientOperation,
  runPersistentClientOperation,
} from "./client-operation-intents";

describe("persistent client-operation intents", () => {
  beforeEach(() => {
    secureStore.values.clear();
    secureStore.getItemAsync.mockClear();
    secureStore.setItemAsync.mockClear();
    secureStore.deleteItemAsync.mockClear();
    crypto.reset();
    crypto.digestStringAsync.mockClear();
    crypto.randomUUID.mockClear();
  });

  test("reuses one operation id after a committed response is lost", async () => {
    let firstOperationId = "";
    await expect(
      runPersistentClientOperation({
        eventSlug: "code2create-7",
        slot: "floor.claim",
        fingerprint: "claim-team-a",
        execute: async (clientOperationId) => {
          firstOperationId = clientOperationId;
          expect(secureStore.values.size).toBe(1);
          throw new Error("The response was lost after the server committed.");
        },
      }),
    ).rejects.toThrow("response was lost");

    const recovered = await runPersistentClientOperation({
      eventSlug: "code2create-7",
      slot: "floor.claim",
      fingerprint: "claim-team-a",
      execute: async (clientOperationId) => {
        expect(clientOperationId).toBe(firstOperationId);
        return { state: "claimed" as const };
      },
    });

    expect(recovered).toEqual({ state: "claimed" });
    expect(secureStore.values.size).toBe(0);

    let nextOperationId = "";
    await runPersistentClientOperation({
      eventSlug: "code2create-7",
      slot: "floor.claim",
      fingerprint: "claim-team-a",
      execute: async (clientOperationId) => {
        nextOperationId = clientOperationId;
      },
    });
    expect(nextOperationId).not.toBe(firstOperationId);
  });

  test("cannot abandon an uncertain intent for a different command", async () => {
    await expect(
      runPersistentClientOperation({
        eventSlug: "code2create-7",
        slot: "attendance.venue.check-in",
        fingerprint: "claim-team-a",
        execute: async () => {
          throw new Error("uncertain");
        },
      }),
    ).rejects.toThrow("uncertain");

    await expect(
      runPersistentClientOperation({
        eventSlug: "code2create-7",
        slot: "attendance.venue.check-in",
        fingerprint: "different-intent",
        execute: async () => undefined,
      }),
    ).rejects.toThrow("earlier operation is still waiting");

    await expect(
      runPersistentClientOperation({
        eventSlug: "code2create-7",
        slot: "attendance.venue.check-in",
        fingerprint: "claim-team-a",
        execute: async () => "recovered",
      }),
    ).resolves.toBe("recovered");

    await expect(
      runPersistentClientOperation({
        eventSlug: "code2create-7",
        slot: "attendance.venue.check-in",
        fingerprint: "different-intent",
        execute: async () => "next command",
      }),
    ).resolves.toBe("next command");
  });

  test("clears an uncertain intent after subscribed state proves success", async () => {
    await expect(
      runPersistentClientOperation({
        eventSlug: "code2create-7",
        slot: "review.presence",
        fingerprint: "claim-team-a",
        execute: async () => {
          throw new Error("uncertain");
        },
      }),
    ).rejects.toThrow("uncertain");

    expect(secureStore.values.size).toBe(1);
    await confirmObservedClientOperation({
      eventSlug: "code2create-7",
      slot: "review.presence",
    });
    expect(secureStore.values.size).toBe(0);
  });

  test("fails closed when a stored operation cannot be trusted", async () => {
    secureStore.values.set(
      "c2c.operation.code2create-7.floor.claim",
      '{"version":2,"operationId":"not-a-valid-operation"}',
    );

    await expect(
      runPersistentClientOperation({
        eventSlug: "code2create-7",
        slot: "floor.claim",
        fingerprint: "claim-team-a",
        execute: async () => "must not run",
      }),
    ).rejects.toThrow("cannot be verified");

    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  test("persists only the allowed non-sensitive recovery shape", async () => {
    await expect(
      runPersistentClientOperation({
        eventSlug: "code2create-7",
        slot: "floor.assign",
        fingerprint: "claim-team-a",
        recovery: {
          kind: "floor_assignment_v1",
          claimId: "claim-1",
          x: 24,
          y: 68,
          expectedClaimVersion: 3,
          requiresReason: false,
        },
        execute: async () => {
          throw new Error("uncertain");
        },
      }),
    ).rejects.toThrow("uncertain");

    const stored = secureStore.values.get("c2c.operation.code2create-7.floor.assign");
    expect(stored).toContain("floor_assignment_v1");
    expect(stored).not.toContain("barcode");
    expect(stored).not.toContain("bearer");
  });

  test("never persists a raw credential fingerprint", async () => {
    const rawCredential = "c2c-vit-v1.private-barcode-value";
    await expect(
      runPersistentClientOperation({
        eventSlug: "code2create-7",
        slot: "attendance.vit.begin",
        fingerprint: rawCredential,
        execute: async () => {
          throw new Error("uncertain");
        },
      }),
    ).rejects.toThrow("uncertain");

    const stored = secureStore.values.get("c2c.operation.code2create-7.attendance.vit.begin");
    expect(stored).not.toContain(rawCredential);
    expect(stored).not.toContain("private-barcode-value");
  });
});
