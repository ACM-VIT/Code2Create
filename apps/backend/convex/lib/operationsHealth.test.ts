import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedCount,
  buildOperationsHealth,
  emptyOperationsHealthCounts,
} from "./operationsHealth.ts";

test("bounded counts preserve the oldest observed time and disclose truncation", () => {
  assert.deepEqual(boundedCount([30, 10, 20], 2), {
    count: 2,
    atLeast: true,
    oldestAt: 10,
  });
});

test("health signals omit zeroes and sort by severity", () => {
  const counts = emptyOperationsHealthCounts();
  counts.github_rate_limits = boundedCount([20]);
  counts.attendance_job_failures = boundedCount([10]);
  counts.scanner_queues_awaiting_replay = boundedCount([15]);

  const result = buildOperationsHealth(counts);

  assert.equal(result.summary.status, "critical");
  assert.equal(result.summary.signalCount, 3);
  assert.deepEqual(
    result.signals.map((signal) => signal.key),
    ["attendance_job_failures", "github_rate_limits", "scanner_queues_awaiting_replay"],
  );
});

test("an empty projection is healthy", () => {
  const result = buildOperationsHealth(emptyOperationsHealthCounts());

  assert.deepEqual(result.summary, {
    status: "healthy",
    signalCount: 0,
    criticalSignalCount: 0,
    attentionSignalCount: 0,
    watchSignalCount: 0,
  });
  assert.deepEqual(result.signals, []);
});
