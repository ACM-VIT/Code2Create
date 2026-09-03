import assert from "node:assert/strict";
import test from "node:test";

import {
  clearSubmissionCelebration,
  consumeSubmissionCelebration,
  markSubmissionCelebration,
} from "./submissionCelebration.ts";

test("a marked submission celebration is consumed exactly once", () => {
  clearSubmissionCelebration();
  markSubmissionCelebration();
  assert.equal(consumeSubmissionCelebration(), true);
  assert.equal(consumeSubmissionCelebration(), false);
});

test("a definitively rejected submission clears its pending celebration", () => {
  markSubmissionCelebration();
  clearSubmissionCelebration();
  assert.equal(consumeSubmissionCelebration(), false);
});
