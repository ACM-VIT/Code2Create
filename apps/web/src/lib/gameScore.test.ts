import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGameScore } from "./gameScore.ts";

test("a points board reads as a tally", () => {
  assert.equal(formatGameScore("pacman", 18_240), "18,240");
  assert.equal(formatGameScore("memory-grid", 17), "17");
  assert.equal(formatGameScore("stack", 0), "0");
});

test("an accuracy board reads as a percentage, not as its raw hundredths", () => {
  assert.equal(formatGameScore("color", 9_412), "94.1%");
  assert.equal(formatGameScore("color", 10_000), "100.0%");
  assert.equal(formatGameScore("color", 0), "0.0%");
});
