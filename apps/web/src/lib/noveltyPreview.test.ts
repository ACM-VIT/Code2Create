import assert from "node:assert/strict";
import test from "node:test";

import {
  noveltyRequestDelayMs,
  noveltyRetryDelayMs,
  visibleNoveltySignal,
} from "./noveltyPreview.ts";

test("starts a live novelty check no more than 400ms after typing stops", () => {
  assert.equal(noveltyRequestDelayMs({ configuredDebounceMs: 800, retryAt: null }), 400);
  assert.equal(noveltyRequestDelayMs({ configuredDebounceMs: 250, retryAt: null }), 250);
});

test("backs off failed checks without giving up permanently", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(noveltyRetryDelayMs),
    [400, 800, 1_600, 3_200, 5_000, 5_000],
  );
  assert.equal(
    noveltyRequestDelayMs({
      configuredDebounceMs: 800,
      retryAt: 12_000,
      now: 10_500,
    }),
    1_500,
  );
});

test("keeps a completed live score visible before the draft query catches up", () => {
  assert.deepEqual(
    visibleNoveltySignal({ status: "ready", signal: { score: 82, band: "distinct" } }),
    { score: 82, band: "distinct" },
  );
  assert.deepEqual(
    visibleNoveltySignal({
      status: "checking",
      previous: { score: 71, band: "distinct" },
    }),
    { score: 71, band: "distinct" },
  );
  assert.equal(visibleNoveltySignal({ status: "idle" }), null);
});
