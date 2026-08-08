import assert from "node:assert/strict";
import test from "node:test";

import { estimateQueueWindow } from "./queueEstimate.ts";

test("uses configured pace until three valid panel samples exist", () => {
  assert.deepEqual(
    estimateQueueWindow({
      now: 1_000_000,
      configuredDurationSeconds: 600,
      teamsAhead: 2,
      completedDurationsSeconds: [420, 480],
    }),
    {
      lowerMinutes: 15,
      upperMinutes: 30,
      sampleSize: 2,
      basis: "configured",
    },
  );
});

test("uses the bounded median of recent completed reviews", () => {
  assert.deepEqual(
    estimateQueueWindow({
      now: 1_000_000,
      configuredDurationSeconds: 600,
      teamsAhead: 1,
      completedDurationsSeconds: [360, 420, 480, 3_600],
    }),
    {
      lowerMinutes: 5,
      upperMinutes: 15,
      sampleSize: 4,
      basis: "observed",
    },
  );
});

test("includes the current panel review and never promises an exact time", () => {
  assert.deepEqual(
    estimateQueueWindow({
      now: 1_000_000,
      configuredDurationSeconds: 600,
      teamsAhead: 0,
      activeReviewPlannedEndAt: 1_240_000,
      completedDurationsSeconds: [],
    }),
    {
      lowerMinutes: 0,
      upperMinutes: 10,
      sampleSize: 0,
      basis: "configured",
    },
  );
});
