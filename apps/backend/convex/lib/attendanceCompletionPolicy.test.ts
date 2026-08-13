import { describe, expect, test } from "vitest";

import {
  attendanceCompletionResult,
  requireAttendanceCompletionPolicy,
} from "./attendanceCompletionPolicy";

describe("attendance completion policy", () => {
  test("validates minimum presence against the configured session", () => {
    const session = { startsAt: 1_000, endsAt: 61_000 };
    expect(() => requireAttendanceCompletionPolicy(
      { kind: "minimum_present_minutes", minimumPresentMinutes: 1 },
      session,
    )).not.toThrow();
    expect(() => requireAttendanceCompletionPolicy(
      { kind: "minimum_present_minutes", minimumPresentMinutes: 2 },
      session,
    )).toThrow("cannot exceed the configured session duration");
    expect(() => requireAttendanceCompletionPolicy(
      { kind: "minimum_present_minutes", minimumPresentMinutes: 0 },
      session,
    )).toThrow("positive whole number");
  });

  test("confirmation policy does not derive a partial result from exit state", () => {
    expect(attendanceCompletionResult({
      participant: {
        state: "temporarily_out",
        confirmedAt: 1_000,
      },
      intervalsValid: true,
      presentDurationMs: 60_000,
      policy: { kind: "confirmation" },
    })).toEqual({ state: "complete", result: "attended" });
  });

  test("minimum presence uses accumulated intervals rather than final state", () => {
    const participant = {
      state: "present" as const,
      confirmedAt: 1_000,
    };
    expect(attendanceCompletionResult({
      participant,
      intervalsValid: true,
      presentDurationMs: 29 * 60_000,
      policy: { kind: "minimum_present_minutes", minimumPresentMinutes: 30 },
    })).toEqual({ state: "complete", result: "partial" });
    expect(attendanceCompletionResult({
      participant: { ...participant, state: "temporarily_out" },
      intervalsValid: true,
      presentDurationMs: 30 * 60_000,
      policy: { kind: "minimum_present_minutes", minimumPresentMinutes: 30 },
    })).toEqual({ state: "complete", result: "attended" });
  });

  test("preserves absence, exception, and integrity outcomes", () => {
    const policy = { kind: "confirmation" as const };
    expect(attendanceCompletionResult({
      participant: { state: "confirmation_due" },
      intervalsValid: true,
      presentDurationMs: 0,
      policy,
    })).toEqual({ state: "complete", result: "absent" });
    expect(attendanceCompletionResult({
      participant: { state: "excused" },
      intervalsValid: true,
      presentDurationMs: 0,
      policy,
    })).toEqual({ state: "excused", result: "excused" });
    expect(attendanceCompletionResult({
      participant: { state: "present", confirmedAt: 1_000 },
      intervalsValid: false,
      presentDurationMs: 60_000,
      policy,
    })).toEqual({ state: "needs_review", result: "needs_review" });
  });
});
