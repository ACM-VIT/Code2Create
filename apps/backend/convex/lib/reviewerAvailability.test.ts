import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedReviewerAvailabilityWindows,
  reviewerCoversStaffingWindow,
  reviewerNoShowBoundary,
  validateReviewerRoundStaffingPolicy,
} from "./reviewerAvailability.ts";

test("normalizes reviewer availability into ordered non-overlapping windows", () => {
  assert.deepEqual(
    normalizedReviewerAvailabilityWindows([
      { startsAt: 300, endsAt: 400 },
      { startsAt: 100, endsAt: 200 },
      { startsAt: 180, endsAt: 300 },
    ]),
    [{ startsAt: 100, endsAt: 400 }],
  );
});

test("requires one confirmed window to cover the complete review", () => {
  const staffing = { startsAt: 1_000, endsAt: 4_000 };
  assert.equal(reviewerCoversStaffingWindow([{ startsAt: 1_000, endsAt: 4_000 }], staffing,
    ),
    true,
  );
  assert.equal(
    reviewerCoversStaffingWindow(
      [
        { startsAt: 1_000, endsAt: 2_000 },
        { startsAt: 2_100, endsAt: 4_000 },
      ],
      staffing,
    ),
    false,
  );
});

test("accepts a no-show grace that ends exactly at round start", () => {
  const round = {
    reviewerReportAt: 2_000,
    startsAt: 32_000,
    endsAt: 40_000,
    noShowGraceSeconds: 30,
  };
  assert.equal(validateReviewerRoundStaffingPolicy(round), round);
  assert.equal(reviewerNoShowBoundary(round), round.startsAt);
});

test("rejects a report time after the round start", () => {
  assert.throws(() =>
    validateReviewerRoundStaffingPolicy({
      reviewerReportAt: 33_000,
      startsAt: 32_000,
      endsAt: 40_000,
      noShowGraceSeconds: 30,
    }),
  );
});
