import { test } from "node:test";
import assert from "node:assert/strict";
import { MAZE_COLS } from "./maze.ts";
import { moveGhost, type Ghost } from "./ghosts.ts";

test("ghost picks the closest open tile and never reverses", () => {
  // (1,2): up/left are walls; right (1,3) is closer to (1,9) than down (2,2).
  const g = moveGhost({ pos: { row: 1, col: 2 }, dir: [0, 0], out: true, trail: [], mode: "normal", acc: 0 }, { row: 1, col: 9 });
  assert.deepEqual(g.pos, { row: 1, col: 3 });
  // heading right at (1,3) with the target behind: reverse is banned, so keep going right.
  const h = moveGhost(g, { row: 1, col: 1 });
  assert.deepEqual(h.pos, { row: 1, col: 4 });
});

test("a ghost circling a 2x2 block breaks out via its trail", () => {
  // Scatter target top-right from the open pocket right of the house: pure greedy loops here.
  let g: Ghost = { pos: { row: 10, col: 19 }, dir: [0, -1], out: true, trail: [], mode: "normal", acc: 0 };
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    g = moveGhost(g, { row: 0, col: MAZE_COLS - 1 });
    seen.add(`${g.pos.row},${g.pos.col}`);
  }
  assert.ok(seen.size > 4, `stuck on ${[...seen].join(" ")}`);
});
