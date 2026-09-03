import assert from "node:assert/strict";
import test from "node:test";

import {
  autonomyCancellationLabel,
  autonomyRunCanStream,
  autonomyRunIsActive,
  autonomyRunPhaseLabel,
  autonomyRunStateLabel,
  autonomyRunTerminalState,
} from "./operationsAutonomyPresentation.ts";

test("the run list distinguishes authoritative lifecycle states", () => {
  assert.equal(autonomyRunStateLabel("pending"), "Queued");
  assert.equal(autonomyRunStateLabel("leased"), "Starting");
  assert.equal(autonomyRunStateLabel("running"), "Working");
  assert.equal(autonomyRunStateLabel("no_op"), "No action");
  assert.equal(autonomyRunStateLabel("canceled"), "Stopped");

  assert.equal(autonomyRunIsActive("leased"), true);
  assert.equal(autonomyRunIsActive("running"), true);
  assert.equal(autonomyRunIsActive("succeeded"), false);
});

test("the live trace follows Convex terminal state instead of Flue settlement", () => {
  assert.equal(autonomyRunTerminalState("running"), "none");
  assert.equal(autonomyRunTerminalState("succeeded"), "completed");
  assert.equal(autonomyRunTerminalState("no_op"), "completed");
  assert.equal(autonomyRunTerminalState("failed"), "failed");
  assert.equal(autonomyRunTerminalState("canceled"), "aborted");
});

test("the trace opens only for lifecycle states that prove Worker acceptance", () => {
  assert.equal(autonomyRunCanStream({ hasStream: true }), true);
  assert.equal(autonomyRunCanStream({ hasStream: false }), false);
});

test("operators see exact phases and effect-authority cancellation causes", () => {
  assert.equal(autonomyRunPhaseLabel("planning"), "Planning what to check");
  assert.equal(autonomyRunPhaseLabel("investigating"), "Investigating a problem");
  assert.equal(autonomyRunPhaseLabel("criticizing"), "Testing the conclusion");
  assert.equal(autonomyRunPhaseLabel("continuing"), "Continuing the review");
  assert.equal(
    autonomyCancellationLabel("owner_revoked"),
    "The accountable owner no longer has the required authority.",
  );
});
