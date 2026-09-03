import assert from "node:assert/strict";
import test from "node:test";

import {
  canCompleteRehearsal,
  canTransitionRehearsalScenario,
  rehearsalTemplateWorkstreams,
  releaseRehearsalTemplate,
} from "./rehearsal.ts";

test("release rehearsal template contains the complete ordered scenario set", () => {
  assert.equal(releaseRehearsalTemplate.length, 62);
  assert.deepEqual(
    releaseRehearsalTemplate.map((scenario) => scenario.sequence),
    Array.from({ length: 62 }, (_, index) => index + 1),
  );
  assert.equal(
    new Set(releaseRehearsalTemplate.map((scenario) => scenario.stableKey)).size,
    releaseRehearsalTemplate.length,
  );
  assert.deepEqual(rehearsalTemplateWorkstreams(), [
    "auth_access",
    "reviewer_app",
    "review_operations",
    "reliability",
    "integrations",
    "intake_admissions",
    "attendance",
    "communications",
    "synesthesia",
    "support",
  ]);
  for (const scenario of releaseRehearsalTemplate) {
    assert.ok(scenario.title.length >= 5);
    assert.ok(scenario.expectedState.length >= 10);
    assert.ok(scenario.recoveryAction.length >= 10);
  }
});

test("scenario outcomes cannot be silently rewritten", () => {
  const states = ["pending", "running", "passed", "failed", "blocked"] as const;
  const allowed = new Set([
    "pending:running",
    "pending:passed",
    "pending:failed",
    "pending:blocked",
    "running:passed",
    "running:failed",
    "running:blocked",
    "passed:running",
    "failed:running",
    "blocked:running",
  ]);
  for (const previous of states) {
    for (const next of states) {
      assert.equal(
        canTransitionRehearsalScenario(previous, next),
        allowed.has(`${previous}:${next}`),
        `${previous} -> ${next}`,
      );
    }
  }
});

test("run completion requires every scenario to pass", () => {
  const allPassed = releaseRehearsalTemplate.map(() => "passed" as const);
  assert.equal(canCompleteRehearsal(allPassed), true);
  assert.equal(
    canCompleteRehearsal(allPassed.map((state, index) => (index === 4 ? "blocked" : state))),
    false,
  );
  assert.equal(canCompleteRehearsal(allPassed.slice(1)), false);
  assert.equal(canCompleteRehearsal([]), false);
});
