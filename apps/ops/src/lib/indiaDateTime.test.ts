import assert from "node:assert/strict";
import test from "node:test";

import {
  indiaDateTimeToTimestamp,
  optionalIndiaDateTimeToTimestamp,
  rescheduleReviewConfirmationWindow,
  reviewConfirmationWindow,
  timestampToIndiaDateTime,
} from "./indiaDateTime.ts";

test("converts the external application deadline from India time exactly", () => {
  assert.equal(
    indiaDateTimeToTimestamp("2026-09-03T23:59"),
    Date.UTC(2026, 8, 3, 18, 29),
  );
  assert.equal(
    timestampToIndiaDateTime(Date.UTC(2026, 8, 3, 18, 29)),
    "2026-09-03T23:59",
  );
});

test("keeps independently configured external and VIT deadlines distinct", () => {
  const external = indiaDateTimeToTimestamp("2026-09-03T23:59");
  const vit = indiaDateTimeToTimestamp("2026-09-05T23:59");
  assert.equal(
    vit === null || external === null ? null : vit - external,
    2 * 24 * 60 * 60_000,
  );
});

test("rejects invalid local values and preserves an empty optional value", () => {
  assert.equal(indiaDateTimeToTimestamp("2026-02-30T12:00"), null);
  assert.equal(indiaDateTimeToTimestamp(""), null);
  assert.equal(optionalIndiaDateTimeToTimestamp(""), undefined);
});

test("overnight review confirmations default to 10–11pm on the preceding calendar day", () => {
  assert.deepEqual(reviewConfirmationWindow("2026-09-07T01:00"), {
    opensAt: "2026-09-06T22:00",
    closesAt: "2026-09-06T23:00",
  });
  assert.deepEqual(reviewConfirmationWindow("2026-09-08T01:00"), {
    opensAt: "2026-09-07T22:00",
    closesAt: "2026-09-07T23:00",
  });
  assert.deepEqual(reviewConfirmationWindow("2026-09-07T23:30"), {
    opensAt: "2026-09-07T22:00",
    closesAt: "2026-09-07T23:00",
  });
  assert.deepEqual(reviewConfirmationWindow(""), { opensAt: "", closesAt: "" });
});

for (const state of ["open", "closed"] as const) {
  test(`${state} confirmations retain the exact opening timestamp when changing their closing time`, () => {
    const opensAt = Date.UTC(2026, 8, 6, 16, 30, 15, 123);
    assert.deepEqual(rescheduleReviewConfirmationWindow(
      { state, opensAt },
      timestampToIndiaDateTime(opensAt),
      "2026-09-07T00:30",
    ), { opensAt, closesAt: Date.UTC(2026, 8, 6, 19) });
  });
}

test("scheduled confirmations accept a new opening and validate both editable times", () => {
  const current = { state: "scheduled", opensAt: Date.UTC(2026, 8, 6, 16, 30) } as const;
  assert.deepEqual(rescheduleReviewConfirmationWindow(current, "2026-09-06T21:00", "2026-09-06T23:00"), {
    opensAt: Date.UTC(2026, 8, 6, 15, 30),
    closesAt: Date.UTC(2026, 8, 6, 17, 30),
  });
  assert.equal(rescheduleReviewConfirmationWindow(current, "", "2026-09-06T23:00").opensAt, null);
  assert.equal(rescheduleReviewConfirmationWindow(current, "2026-09-06T21:00", "").closesAt, null);
});
