import assert from "node:assert/strict";
import test from "node:test";

import {
  initialIdeaClientMaximumLength,
  initialIdeaMaximumLength,
} from "./ideaSubmission.ts";

test("caps the initial idea at 300 characters in the participant UI", () => {
  assert.equal(initialIdeaMaximumLength(2_000), initialIdeaClientMaximumLength);
});

test("keeps a stricter published limit", () => {
  assert.equal(initialIdeaMaximumLength(240), 240);
});
