import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedReviewerAvailabilityWindows,
  reviewerClockInIsOpenAt,
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

test("treats the exact clock-in opening as open and the round end as closed", () => {
  const round = { clockInOpensAt: 1_000, endsAt: 2_000 };
  assert.equal(reviewerClockInIsOpenAt(round, 999), false);
  assert.equal(reviewerClockInIsOpenAt(round, 1_000), true);
  assert.equal(reviewerClockInIsOpenAt(round, 1_999), true);
  assert.equal(reviewerClockInIsOpenAt(round, 2_000), false);
});

test("requires one declared window to cover the complete staffing window", () => {
  const staffing = { clockInOpensAt: 1_000, endsAt: 4_000 };
  assert.equal(
    reviewerCoversStaffingWindow([{ startsAt: 1_000, endsAt: 4_000 }], staffing),
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
    clockInOpensAt: 1_000,
    reviewerReportAt: 2_000,
    startsAt: 32_000,
    endsAt: 40_000,
    noShowGraceSeconds: 30,
  };
  assert.equal(validateReviewerRoundStaffingPolicy(round), round);
  assert.equal(reviewerNoShowBoundary(round, null), round.startsAt);
});

test("bases an unavailable reviewer's no-show boundary on the expected return", () => {
  assert.equal(
    reviewerNoShowBoundary(
      { reviewerReportAt: 2_000, noShowGraceSeconds: 30 },
      { status: "temporarily_unavailable", expectedReturnAt: 5_000 },
    ),
    35_000,
  );
});
