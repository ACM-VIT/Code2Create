import assert from "node:assert/strict";
import test from "node:test";

import { canTransitionSupportCase } from "./supportCases.ts";

test("active support cases can move through normal desk states", () => {
  assert.equal(canTransitionSupportCase("open", "investigating"), true);
  assert.equal(canTransitionSupportCase("investigating", "waiting"), true);
  assert.equal(canTransitionSupportCase("waiting", "resolved"), true);
  assert.equal(canTransitionSupportCase("resolved", "closed"), true);
});

test("same-state writes and arbitrary closed-state edits are rejected", () => {
  assert.equal(canTransitionSupportCase("open", "open"), false);
  assert.equal(canTransitionSupportCase("closed", "waiting"), false);
  assert.equal(canTransitionSupportCase("closed", "open"), true);
});
