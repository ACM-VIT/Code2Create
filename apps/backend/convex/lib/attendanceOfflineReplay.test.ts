import { describe, expect, it } from "vitest";

import {
  offlineReplayConflictsWithNewerEvidence,
  offlineReplayTimeRejection,
} from "./attendanceOfflineReplay";

describe("offline attendance replay", () => {
  it("rejects expired and implausibly future captures", () => {
    expect(
      offlineReplayTimeRejection({
        capturedAt: 1_000,
        receivedAt: 181_001,
        maxAgeMs: 180_000,
      }),
    ).toBe("offline_replay_expired");
    expect(
      offlineReplayTimeRejection({
        capturedAt: 31_001,
        receivedAt: 1_000,
        maxAgeMs: 180_000,
      }),
    ).toBe("scan_capture_time_invalid");
    expect(
      offlineReplayTimeRejection({
        capturedAt: 1_000,
        receivedAt: 181_000,
        maxAgeMs: 180_000,
      }),
    ).toBeNull();
  });

  it("protects newer online evidence from an older accepted replay", () => {
    expect(
      offlineReplayConflictsWithNewerEvidence({
        capturedAt: 10_000,
        proposedOutcome: "accepted",
        priorEvent: {
          capturedAt: 11_000,
          receivedAt: 12_000,
          isOfflineReplay: false,
        },
      }),
    ).toBe(true);
    expect(
      offlineReplayConflictsWithNewerEvidence({
        capturedAt: 13_000,
        proposedOutcome: "accepted",
        priorEvent: {
          capturedAt: 11_000,
          receivedAt: 12_000,
          isOfflineReplay: false,
        },
      }),
    ).toBe(false);
    expect(
      offlineReplayConflictsWithNewerEvidence({
        capturedAt: 12_000,
        proposedOutcome: "accepted",
        priorEvent: {
          capturedAt: 11_000,
          receivedAt: 12_000,
          isOfflineReplay: false,
        },
      }),
    ).toBe(true);
  });

  it("does not escalate a duplicate that leaves the projection unchanged", () => {
    expect(
      offlineReplayConflictsWithNewerEvidence({
        capturedAt: 10_000,
        proposedOutcome: "duplicate",
        priorEvent: {
          capturedAt: 11_000,
          receivedAt: 12_000,
          isOfflineReplay: false,
        },
      }),
    ).toBe(false);
  });

  it("orders prior offline evidence by its capture time", () => {
    expect(
      offlineReplayConflictsWithNewerEvidence({
        capturedAt: 20_000,
        proposedOutcome: "accepted",
        priorEvent: {
          capturedAt: 21_000,
          receivedAt: 30_000,
          isOfflineReplay: true,
        },
      }),
    ).toBe(true);
  });
});
