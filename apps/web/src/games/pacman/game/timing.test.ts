import { test } from "node:test";
import assert from "node:assert/strict";
import { SEC, scatter } from "./timing.ts";

test("scatter/chase follows the level-1 schedule", () => {
  assert.equal(scatter(0), true);
  assert.equal(scatter(7 * SEC - 1), true);
  assert.equal(scatter(7 * SEC), false, "first chase begins at 7s");
  assert.equal(scatter(27 * SEC), true, "scatter again 20s later");
  assert.equal(scatter(1e9), false, "chase forever at the end");
});
