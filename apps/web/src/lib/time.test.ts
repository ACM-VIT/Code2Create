import assert from "node:assert/strict";
import test from "node:test";

import {
  elapsedName,
  maximumBrowserTimerDelay,
  nextDeadlineTimerDelay,
  queueWaitName,
} from "./time.ts";

const now = 1_000_000;

test("ages a queue window without presenting it as an appointment", () => {
  assert.equal(
    queueWaitName({ earliestAt: now, latestAt: now + 10 * 60_000 }, now),
    "Within 10 min",
  );
  assert.equal(
    queueWaitName({ earliestAt: now + 14 * 60_000, latestAt: now + 29 * 60_000 }, now + 6 * 60_000),
    "About 5–25 min",
  );
  assert.equal(
    queueWaitName({ earliestAt: now - 10 * 60_000, latestAt: now }, now),
    "Taking longer than estimated",
  );
});

test("keeps distant deadlines pending across capped browser timers", () => {
  const deadline = 30 * 24 * 60 * 60 * 1_000;

  assert.equal(nextDeadlineTimerDelay(deadline, 0), maximumBrowserTimerDelay);
  assert.equal(
    nextDeadlineTimerDelay(deadline, maximumBrowserTimerDelay),
    deadline - maximumBrowserTimerDelay + 100,
  );
  assert.equal(nextDeadlineTimerDelay(deadline, deadline), null);
});

test("names elapsed time coarsely and never in the future", () => {
  assert.equal(elapsedName(now, now), "just now");
  assert.equal(elapsedName(now + 5 * 60_000, now), "just now");
  assert.equal(elapsedName(now - 5 * 60_000, now), "5 min ago");
  assert.equal(elapsedName(now - 60 * 60_000, now), "1 hour ago");
  assert.equal(elapsedName(now - 5 * 60 * 60_000, now), "5 hours ago");
  assert.equal(elapsedName(now - 26 * 60 * 60_000, now), "1 day ago");
  assert.equal(elapsedName(now - 3 * 24 * 60 * 60_000, now), "3 days ago");
});
