import assert from "node:assert/strict";
import test from "node:test";

import { indiaDateTimeToTimestamp, optionalIndiaDateTimeToTimestamp,
  reviewConfirmationOpening,
  timestampToIndiaDateTime,
} from "./indiaDateTime.ts";

test("converts the external application deadline from India time exactly", () => {
  assert.equal(indiaDateTimeToTimestamp("2026-09-03T23:59"), Date.UTC(2026, 8, 3, 18, 29),
  );
  assert.equal(
    timestampToIndiaDateTime(Date.UTC(2026, 8, 3, 18, 29)),
    "2026-09-03T23:59",
  );
});

test("keeps independently configured external and VIT deadlines distinct", () => {
  const external = indiaDateTimeToTimestamp("2026-09-03T23:59");
  const vit = indiaDateTimeToTimestamp("2026-09-05T23:59");
  assert.equal(vit === null || external === null ? null : vit - external, 2 * 24 * 60 * 60_000,
  );
});

test("rejects invalid local values and preserves an empty optional value", () => {
  assert.equal(indiaDateTimeToTimestamp("2026-02-30T12:00"), null);
  assert.equal(indiaDateTimeToTimestamp(""), null);
  assert.equal(optionalIndiaDateTimeToTimestamp(""), undefined);
});

test("overnight review confirmations open at 11pm on the preceding calendar day", () => {
  assert.equal(
    reviewConfirmationOpening("2026-09-07T01:00"),
    "2026-09-06T23:00",
  );
  assert.equal(
    reviewConfirmationOpening("2026-09-08T01:00"),
    "2026-09-07T23:00",
  );
  assert.equal(
    reviewConfirmationOpening("2026-09-07T23:30"),
    "2026-09-07T23:00",
  );
  assert.equal(reviewConfirmationOpening(""), "");
});
