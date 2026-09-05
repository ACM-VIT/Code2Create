import assert from "node:assert/strict";
import test from "node:test";

import { dayTimeLabel, timeLabel } from "./format.ts";

test("dashboard labels preserve display options when switching event time zones", () => {
  for (const timezone of [undefined, "", "Asia/Kolkata", "America/New_York", "UTC", "America/New_York"]) {
    for (const timestamp of [0, Date.UTC(2026, 2, 8, 6, 30), Date.UTC(2026, 2, 8, 7, 30)]) {
      const options: Intl.DateTimeFormatOptions = {
        ...(timezone ? { timeZone: timezone } : {}),
        hour: "numeric",
        minute: "2-digit",
      };
      assert.equal(timeLabel(timestamp, timezone), new Intl.DateTimeFormat(undefined, options).format(timestamp));
      assert.equal(dayTimeLabel(timestamp, timezone), new Intl.DateTimeFormat(undefined, { ...options, weekday: "short" }).format(timestamp));
    }
  }
});

test("cached dashboard labels still reject invalid dates and time zones", () => {
  timeLabel(0, "UTC");
  dayTimeLabel(0, "UTC");
  for (const format of [timeLabel, dayTimeLabel]) {
    assert.throws(() => format(Number.NaN, "UTC"), RangeError);
    assert.throws(() => format(0, "invalid"), RangeError);
  }
});
