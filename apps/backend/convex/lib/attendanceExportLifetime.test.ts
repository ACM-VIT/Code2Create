import assert from "node:assert/strict";
import test from "node:test";

import { attendanceExportExpiresAt } from "./attendanceExportLifetime.ts";

test("attendance export expiry is derived from the server request time", () => {
  const requestedAt = 1_800_000_000_000;

  assert.equal(
    attendanceExportExpiresAt("fifteen_minutes", requestedAt),
    requestedAt + 15 * 60 * 1_000,
  );
  assert.equal(attendanceExportExpiresAt("one_hour", requestedAt), requestedAt + 60 * 60 * 1_000);
  assert.equal(
    attendanceExportExpiresAt("one_day", requestedAt),
    requestedAt + 24 * 60 * 60 * 1_000,
  );
  assert.equal(
    attendanceExportExpiresAt("three_days", requestedAt),
    requestedAt + 3 * 24 * 60 * 60 * 1_000,
  );
  assert.equal(
    attendanceExportExpiresAt("seven_days", requestedAt),
    requestedAt + 7 * 24 * 60 * 60 * 1_000,
  );
});
