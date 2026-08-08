import assert from "node:assert/strict";
import test from "node:test";

import {
  figmaMetadataDispatchBatchSize,
  figmaMetadataDispatchRecoveryMs,
  figmaMetadataIntervalMs,
  figmaMetadataLeaseDurationMs,
  nextFigmaMetadataCheckAt,
  nextFigmaMetadataFailureCheckAt,
  shouldAcceptFigmaObservation,
} from "./figmaMetadataSchedule.ts";

test("dispatcher and lease recovery stay explicitly bounded", () => {
  assert.equal(figmaMetadataDispatchBatchSize, 64);
  assert.equal(figmaMetadataLeaseDurationMs, 90_000);
  assert.equal(figmaMetadataDispatchRecoveryMs, 300_000);
});

test("live metadata checks stay inside the published heartbeat window", () => {
  const withWebhook = figmaMetadataIntervalMs("live", "active", "file-a");
  const withoutWebhook = figmaMetadataIntervalMs("live", "unavailable", "file-b");

  assert.ok(withWebhook >= 90_000 && withWebhook <= 120_000);
  assert.ok(withoutWebhook >= 60_000 && withoutWebhook <= 90_000);
});

test("non-live checks back off and deterministic jitter spreads files", () => {
  const first = nextFigmaMetadataCheckAt({
    from: 1_000,
    eventStatus: "registration_open",
    webhookState: "active",
    resourceKey: "file-a",
  });
  const repeat = nextFigmaMetadataCheckAt({
    from: 1_000,
    eventStatus: "registration_open",
    webhookState: "active",
    resourceKey: "file-a",
  });
  const other = nextFigmaMetadataCheckAt({
    from: 1_000,
    eventStatus: "registration_open",
    webhookState: "active",
    resourceKey: "file-b",
  });

  assert.equal(first, repeat);
  assert.notEqual(first, other);
  assert.ok(first >= 901_000 && first <= 1_021_000);
});

test("transient failures retry slowly enough to avoid a hot loop", () => {
  const retryAt = nextFigmaMetadataFailureCheckAt({
    now: 10_000,
    eventStatus: "live",
    resourceKey: "file-a",
  });

  assert.ok(retryAt >= 130_000 && retryAt <= 160_000);
});

test("an older provider response cannot replace a newer observation", () => {
  assert.equal(
    shouldAcceptFigmaObservation({
      currentLastTouchedAt: 20_000,
      currentObservedAt: 30_000,
      incomingLastTouchedAt: 10_000,
      incomingObservedAt: 40_000,
    }),
    false,
  );
  assert.equal(
    shouldAcceptFigmaObservation({
      currentLastTouchedAt: 20_000,
      currentObservedAt: 30_000,
      incomingLastTouchedAt: 20_000,
      incomingObservedAt: 29_999,
    }),
    false,
  );
  assert.equal(
    shouldAcceptFigmaObservation({
      currentLastTouchedAt: 20_000,
      currentObservedAt: 30_000,
      incomingLastTouchedAt: 20_001,
      incomingObservedAt: 25_000,
    }),
    true,
  );
});
