import assert from "node:assert/strict";
import test from "node:test";

import {
  formatClockTime,
  formatCompactDateTime,
  formatMediumDateTime,
  formatMonthDayTime,
  formatMonthDayTimeWindow,
  formatZonedDateTimeWindow,
  formatZonedTime,
} from "./dateTime.ts";

test("cached formats preserve the runtime locale and default time zone", () => {
  const formats: readonly [((value: number) => string), Intl.DateTimeFormatOptions][] = [
    [formatClockTime, { hour: "2-digit", minute: "2-digit" }],
    [formatCompactDateTime, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }],
    [formatMediumDateTime, { dateStyle: "medium", timeStyle: "short" }],
    [formatMonthDayTime, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }],
  ];
  for (const [format, options] of formats) {
    for (const value of [0, -1, Date.UTC(2026, 0, 1), Date.UTC(2026, 8, 5, 18, 30)]) {
      assert.equal(format(value), new Intl.DateTimeFormat(undefined, options).format(value));
    }
  }
  assert.equal(formatMonthDayTime(0, ""), formatMonthDayTime(0));
});

test("switching event time zones and crossing DST boundaries keeps both window endpoints exact", () => {
  for (const timeZone of ["Asia/Kolkata", "America/New_York", "UTC", "America/New_York", "Asia/Kolkata"]) {
    for (const startsAt of [Date.UTC(2026, 2, 8, 6, 30), Date.UTC(2026, 10, 1, 5, 30)]) {
      const endsAt = startsAt + 3_600_000;
      const medium = new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: "medium", timeStyle: "short" });
      const monthDay = new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const time = new Intl.DateTimeFormat(undefined, { timeZone, timeStyle: "short" });
      assert.equal(formatZonedDateTimeWindow(startsAt, endsAt, timeZone), `${medium.format(startsAt)} – ${medium.format(endsAt)}`);
      assert.equal(formatMonthDayTimeWindow(startsAt, endsAt, timeZone), `${monthDay.format(startsAt)} – ${monthDay.format(endsAt)}`);
      assert.equal(formatZonedTime(startsAt, timeZone), time.format(startsAt));
    }
  }
});

test("invalid dates and explicit invalid time zones still raise errors after cache hits", () => {
  formatMediumDateTime(0);
  formatZonedTime(0, "UTC");
  assert.throws(() => formatMediumDateTime(Number.NaN), RangeError);
  assert.throws(() => formatClockTime(Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => formatZonedTime(0, ""), RangeError);
  assert.throws(() => formatZonedDateTimeWindow(0, 1, ""), RangeError);
  assert.throws(() => formatZonedTime(0, "invalid"), RangeError);
  assert.throws(() => formatMonthDayTime(0, "invalid"), RangeError);
});
