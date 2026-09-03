/* eslint-disable import/first -- native modules must be mocked before the module under test loads. */
import { describe, expect, test, vi } from "vitest";

const secureStore = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
});

const sqlite = vi.hoisted(() => {
  let payloads: string[] = [];
  let transactionOpen = false;
  let concurrentTransactions = 0;
  let maximumConcurrentTransactions = 0;
  let insertGate: Promise<void> | null = null;
  let releaseInsertGate: (() => void) | null = null;
  let announceInsert: (() => void) | null = null;

  const database = {
    execAsync: vi.fn(async (statement: string) => {
      if (statement === "BEGIN IMMEDIATE") {
        if (transactionOpen) throw new Error("cannot start a transaction within a transaction");
        transactionOpen = true;
        concurrentTransactions += 1;
        maximumConcurrentTransactions = Math.max(
          maximumConcurrentTransactions,
          concurrentTransactions,
        );
      } else if (statement === "COMMIT" || statement === "ROLLBACK") {
        transactionOpen = false;
        concurrentTransactions -= 1;
      }
    }),
    getFirstAsync: vi.fn(async (statement: string) => {
      if (statement === "PRAGMA cipher_version") return { cipher_version: "4.7.2" };
      if (statement.includes("sqlite_master")) return { tables: 0 };
      if (statement.includes("COUNT(*)")) return { count: payloads.length };
      return null;
    }),
    getAllAsync: vi.fn(async () => payloads.map((payload) => ({ payload }))),
    runAsync: vi.fn(async (statement: string, ...values: unknown[]) => {
      if (statement.includes("INSERT INTO pending_attendance_scans")) {
        announceInsert?.();
        announceInsert = null;
        const gate = insertGate;
        if (gate) await gate;
        insertGate = null;
        releaseInsertGate = null;
        const payload = values[4];
        if (typeof payload !== "string") throw new Error("The test insert has no payload.");
        payloads.push(payload);
      }
    }),
    closeAsync: vi.fn(async () => undefined),
  };

  return {
    database,
    openDatabaseAsync: vi.fn(async () => database),
    deleteDatabaseAsync: vi.fn(async () => undefined),
    holdNextInsert() {
      let insertStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        insertStarted = resolve;
      });
      insertGate = new Promise<void>((resolve) => {
        releaseInsertGate = resolve;
      });
      announceInsert = insertStarted;
      return {
        started,
        release() {
          releaseInsertGate?.();
        },
      };
    },
    payloadCount() {
      return payloads.length;
    },
    maximumConcurrentTransactions() {
      return maximumConcurrentTransactions;
    },
  };
});

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "when-unlocked",
  getItemAsync: secureStore.getItemAsync,
  setItemAsync: secureStore.setItemAsync,
}));

vi.mock("expo-crypto", () => ({
  getRandomBytesAsync: vi.fn(async () => new Uint8Array(32).fill(5)),
}));

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: sqlite.openDatabaseAsync,
  deleteDatabaseAsync: sqlite.deleteDatabaseAsync,
}));

import { enqueuePendingAttendanceScan, pendingAttendanceSummary } from "./pending-attendance-scans";

describe("pending attendance scan concurrency", () => {
  test("queues heartbeat reads and a second scan behind an in-flight insert", async () => {
    const eventSlug = "queue-concurrency";
    const installationId = "00000000-0000-4000-8000-000000000001";
    const now = 1_800_000_000_000;
    const heldInsert = sqlite.holdNextInsert();
    const first = enqueuePendingAttendanceScan({
      input: scanInput({ eventSlug, installationId, deviceSequence: 1 }),
      maxScans: 25,
      maxAgeSeconds: 60,
      now,
    });
    await heldInsert.started;

    const summary = pendingAttendanceSummary({ eventSlug, installationId, now });
    const second = enqueuePendingAttendanceScan({
      input: scanInput({ eventSlug, installationId, deviceSequence: 2 }),
      maxScans: 25,
      maxAgeSeconds: 60,
      now,
    });
    await Promise.resolve();
    expect(sqlite.payloadCount()).toBe(0);

    heldInsert.release();
    const [, observedSummary] = await Promise.all([first, summary, second]);

    expect(observedSummary.count).toBe(1);
    expect(sqlite.payloadCount()).toBe(2);
    expect(sqlite.maximumConcurrentTransactions()).toBe(1);
  });
});

function scanInput(args: { eventSlug: string; installationId: string; deviceSequence: number }) {
  return {
    eventSlug: args.eventSlug,
    installationId: args.installationId,
    stationStableKey: "main_gate",
    expectedConfigurationVersion: 1,
    credential: { kind: "badge_qr" as const, bearer: "A".repeat(43) },
    clientOperationId: `00000000-0000-4000-8000-${String(args.deviceSequence).padStart(12, "0")}`,
    deviceSequence: args.deviceSequence,
    capturedAt: 1_800_000_000_000 + args.deviceSequence,
  };
}
