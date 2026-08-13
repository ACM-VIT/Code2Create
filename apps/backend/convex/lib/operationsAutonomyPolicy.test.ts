import assert from "node:assert/strict";
import { test } from "vitest";

import type { Id } from "../_generated/dataModel";
import {
  defaultOperationsAutonomyPolicy,
  normalizeOperationsAutonomyPolicy,
  operationsAutonomyPolicyChecksum,
} from "./operationsAutonomyPolicy.ts";

const ownerId = "owner-subject" as Id<"eventAccessSubjects">;

test("the baseline is disabled, observe-only, and always reads current health", () => {
  const baseline = defaultOperationsAutonomyPolicy(ownerId);
  assert.equal(baseline.enabled, false);
  assert.equal(baseline.mode, "observe");
  assert.deepEqual(baseline.allowedRecommendationKinds, []);
  assert.ok(baseline.allowedReadTools.includes("operations_health"));
  assert.equal(baseline.accountableOwnerEventAccessSubjectId, ownerId);
});

test("policy validation controls authority without imposing cognition quotas", () => {
  const baseline = defaultOperationsAutonomyPolicy(ownerId);
  assert.throws(
    () => normalizeOperationsAutonomyPolicy({
      ...baseline,
      allowedRecommendationKinds: ["open_support_case"],
    }),
    /Observe mode cannot publish recommendations/u,
  );
  assert.throws(
    () => normalizeOperationsAutonomyPolicy({
      ...baseline,
      mode: "recommend",
    }),
    /Allowed recommendation kinds must not be empty/u,
  );
  assert.throws(
    () => normalizeOperationsAutonomyPolicy({
      ...baseline,
      allowedReadTools: ["support_load"],
    }),
    /must always read current operations health/u,
  );
  assert.doesNotThrow(() => normalizeOperationsAutonomyPolicy({
    ...baseline,
    mode: "recommend",
    allowedRecommendationKinds: ["open_support_case"],
  }));
});

test("schedule cadence is the only numeric product control", () => {
  const baseline = defaultOperationsAutonomyPolicy(ownerId);
  assert.throws(
    () => normalizeOperationsAutonomyPolicy({ ...baseline, scheduleIntervalMinutes: 0 }),
    /Schedule interval/u,
  );
  assert.throws(
    () => normalizeOperationsAutonomyPolicy({ ...baseline, scheduleIntervalMinutes: 61 }),
    /Schedule interval/u,
  );
});

test("checksum is canonical across caller ordering and changes with authority", () => {
  const baseline = defaultOperationsAutonomyPolicy(ownerId);
  const ordered = normalizeOperationsAutonomyPolicy({
    ...baseline,
    triggerSeverities: ["watch", "critical"],
    allowedReadTools: ["support_load", "operations_health"],
  });
  const reordered = normalizeOperationsAutonomyPolicy({
    ...baseline,
    triggerSeverities: ["critical", "watch"],
    allowedReadTools: ["operations_health", "support_load"],
  });
  assert.equal(operationsAutonomyPolicyChecksum(ordered), operationsAutonomyPolicyChecksum(reordered));
  assert.notEqual(
    operationsAutonomyPolicyChecksum(ordered),
    operationsAutonomyPolicyChecksum({ ...ordered, enabled: true }),
  );
});
