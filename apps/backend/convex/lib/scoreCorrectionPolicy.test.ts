import { describe, expect, test } from "vitest";

import {
  requireScoreCorrectionPolicy,
  scoreCorrectionRequestIsOpen,
} from "./scoreCorrectionPolicy";

describe("score correction policy", () => {
  test("requires an explicit deadline inside the configured round", () => {
    expect(() => requireScoreCorrectionPolicy({
      startsAt: 1_000,
      endsAt: 2_000,
      correctionRequestsCloseAt: 1_500,
    })).not.toThrow();
    expect(() => requireScoreCorrectionPolicy({
      startsAt: 1_000,
      endsAt: 2_000,
      correctionRequestsCloseAt: 999,
    })).toThrow("must fall within the review round");
    expect(() => requireScoreCorrectionPolicy({
      startsAt: 1_000,
      endsAt: 2_000,
      correctionRequestsCloseAt: 2_001,
    })).toThrow("must fall within the review round");
  });

  test("uses the inclusive server-time boundary and round state", () => {
    const round = {
      startsAt: 1_000,
      endsAt: 2_000,
      correctionRequestsCloseAt: 1_500,
      status: "open",
    };
    expect(scoreCorrectionRequestIsOpen(round, 1_500)).toBe(true);
    expect(scoreCorrectionRequestIsOpen(round, 1_501)).toBe(false);
    expect(scoreCorrectionRequestIsOpen({ ...round, status: "closing" }, 1_400)).toBe(false);
  });
});
