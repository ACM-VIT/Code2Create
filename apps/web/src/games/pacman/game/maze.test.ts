import { test } from "node:test";
import assert from "node:assert/strict";
import { CELL, MAZE, MAZE_COLS, MAZE_ROWS, advance, step } from "./maze.ts";
import { FRUIT_SPAWN } from "./pickups.ts";
import { GHOSTS } from "./ghosts.ts";

test("walls block, open tiles pass", () => {
  assert.equal(step(1, 2, -1, 0), null); // into the top border
  assert.deepEqual(step(1, 2, 0, 1), { row: 1, col: 3 });
});

test("stepping onto a teleport mouth emerges at its partner", () => {
  // The side tunnel: (10,0) and (10,22), one on each edge.
  assert.deepEqual(step(10, 1, 0, -1), { row: 10, col: 22 });
  assert.deepEqual(step(10, 21, 0, 1), { row: 10, col: 0 });
  // An interior pair, whose mouths sit well inside the board.
  assert.deepEqual(step(18, 4, 0, 1), { row: 18, col: 17 });
  assert.deepEqual(step(18, 18, 0, -1), { row: 18, col: 5 });
  // A pair that is neither aligned nor facing: (8,3) and (12,19).
  assert.deepEqual(step(9, 3, -1, 0), { row: 12, col: 19 });
  // You land on the partner mouth without being bounced straight back off it.
  assert.equal(MAZE[12]![19], CELL.TELEPORT);
});

test("the grid edge is never walkable: every route out is a teleport", () => {
  for (let r = 0; r < MAZE_ROWS; r++)
    for (const c of [0, MAZE_COLS - 1]) assert.equal(step(r, c, 0, c ? 1 : -1), null);
});

test("the border is solid apart from its tunnel mouths", () => {
  for (let r = 0; r < MAZE_ROWS; r++)
    for (const c of [0, MAZE_COLS - 1])
      assert.ok(MAZE[r]![c] === CELL.WALL || MAZE[r]![c] === CELL.TELEPORT, `(${r},${c}) is neither wall nor tunnel`);
});

test("advance turns when it can, else keeps going, else stops", () => {
  const right = [0, 1] as const, up = [-1, 0] as const;
  // (1,2) → up is the border: can't turn, so keep heading right.
  assert.deepEqual(advance({ row: 1, col: 2 }, up, right), { pos: { row: 1, col: 3 }, dir: right });
  // (6,1) → up is open: turn and take it.
  assert.deepEqual(advance({ row: 6, col: 1 }, up, right), { pos: { row: 5, col: 1 }, dir: up });
  // (1,8) → right is a wall and so is up: stay put, still facing right.
  assert.deepEqual(advance({ row: 1, col: 8 }, up, right), { pos: { row: 1, col: 8 }, dir: right });
});

test("advance takes a 180 wherever one is asked for", () => {
  const right = [0, 1] as const, left = [0, -1] as const;
  // (1,3) heading right with open track ahead: asking to double back turns him around on the spot.
  assert.deepEqual(advance({ row: 1, col: 3 }, left, right), { pos: { row: 1, col: 2 }, dir: left });
  // (1,8) heading right is nose-first into the wall at (1,9): the turn-around works there too.
  assert.deepEqual(advance({ row: 1, col: 8 }, left, right), { pos: { row: 1, col: 7 }, dir: left });
});

test("pac-man can't enter the ghost house", () => {
  assert.equal(step(8, 8, 0, 1), null);
  assert.equal(step(11, 14, 0, -1), null);
});

test("the hand-placed spawns sit on tiles you can actually stand on", () => {
  // A map edit that walls one of these off would otherwise fail obscurely mid-game.
  assert.equal(MAZE[FRUIT_SPAWN.row]![FRUIT_SPAWN.col], CELL.PATH, "cherry needs a dot tile");
  for (const g of GHOSTS) {
    assert.equal(MAZE[g.tile.row]![g.tile.col], CELL.GHOST_HOUSE, `${g.name} starts in the house`);
    assert.ok(step(g.door.row, g.door.col, 0, 0, true), `${g.name}'s door is open`);
  }
  // Two ghosts in the same pocket need their own columns: a waiting ghost bobs half a
  // tile towards the pocket's other row, so sharing one would drift them into each
  // other. Across pockets a shared column is fine, and is what lines the four up.
  const pockets = new Map<number, number[]>();
  for (const g of GHOSTS) {
    const pocket = g.tile.row < 10 ? 0 : 1;
    pockets.set(pocket, [...(pockets.get(pocket) ?? []), g.tile.col]);
  }
  for (const [pocket, cols] of pockets)
    assert.equal(new Set(cols).size, cols.length, `pocket ${pocket} start columns clash: ${cols.join()}`);
});
