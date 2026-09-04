import { test } from "node:test";
import assert from "node:assert/strict";
import { CELL, MAZE, key, type Dir, type Tile } from "./maze.ts";
import { FRIGHT, SEC, scatter } from "./timing.ts";
import { SPEED, rate } from "./speed.ts";
import { DOTS, EXTRA_LIFE_AT, FRUIT_AT, FRUIT_SPAWN, FRUIT_TICKS, POINTS, cleared, fruitOut } from "./pickups.ts";
import { RELEASE_IDLE, released, type Ghost } from "./ghosts.ts";
import { LIVES, NEW_GAME, type Game } from "./state.ts";
import { tick } from "./tick.ts";

/**
 * A tick is a frame now, and a mover only steps once it has banked a whole tile,
 * so these tests prime the mover they're about to watch: `acc: 1` makes the very
 * next tick its stepping one. `frozen` is the opposite — no direction carried and
 * none asked for, so `advance` leaves Pac-Man where he is however long the clock runs.
 */
const primed = <T extends { acc: number }>(m: T): T => ({ ...m, acc: 1 });
const frozen = (g: Game): Game => ({ ...g, dir: [0, 0] });
/** A ghost out on the board, primed to take its step on the next tick. */
const ghost = (pos: Tile, dir: Dir, mode: Ghost["mode"] = "normal"): Ghost =>
  ({ pos, dir, out: true, trail: [], mode, acc: 1 });
/** Park every ghost but the first back in the house, so nothing wanders into Pac-Man mid-test. */
const alone = (g: Game): Game => ({ ...g, ghosts: [g.ghosts[0]!, ...NEW_GAME.ghosts.slice(1)] });

test("tick eats the dot it lands on; the cherry shows at each FRUIT_AT trigger, is taken on contact or leaves after 9s", () => {
  const dots = (n: number) => new Set(Array.from({ length: n }, (_, i) => `dot${i}`));
  // Eat (1,2) from (1,1) with `n` fake dots already gone, so the dot count lands exactly on n + 1.
  const eat = (g: Game, n: number) => tick(primed({ ...g, pos: { row: 1, col: 1 }, dir: [0, 1], eaten: dots(n) }), [0, 1]);
  const grab = (g: Game) =>
    tick(primed({ ...g, pos: { row: FRUIT_SPAWN.row, col: FRUIT_SPAWN.col - 1 }, dir: [0, 1] }), [0, 1]);

  let g = tick(primed({ ...NEW_GAME, pos: { row: 1, col: 1 } }), [0, 1]);
  assert.deepEqual([...g.eaten], ["1,2"]);
  assert.equal(g.score, POINTS.pellet);
  assert.equal(fruitOut(g), false);
  assert.equal(tick(primed({ ...g, pos: { row: 1, col: 1 }, dir: [0, 1] }), [0, 1]).score, g.score, "an eaten dot scores nothing");
  // Back onto the power pellet at (1,1): a 180 out of a rightward run is taken.
  g = tick(primed({ ...g, pos: { row: 1, col: 2 }, dir: [0, 1] }), [0, -1]);
  assert.equal(g.score, POINTS.pellet + POINTS.power);

  g = eat({ ...g, score: 0 }, FRUIT_AT[0]! - 1);
  assert.equal(fruitOut(g), true, "70th dot brings the cherry out");
  assert.equal(g.fruit, FRUIT_TICKS);
  g = grab(g);
  assert.deepEqual(g.pos, FRUIT_SPAWN);
  assert.equal(g.fruits, 1);
  assert.equal(g.score, POINTS.pellet + POINTS.cherry + POINTS.pellet, "cherry plus the dot under it");
  assert.equal(fruitOut(g), false, "second cherry waits for the next trigger");

  g = eat(g, FRUIT_AT[1]! - 1);
  assert.equal(fruitOut(g), true);
  g = frozen(g); // stand still so the countdown isn't cut short by eating the next trigger
  for (let i = 1; i < FRUIT_TICKS; i++) g = { ...tick(g, [0, 0]), ghosts: NEW_GAME.ghosts }; // nobody home to bite
  assert.equal(fruitOut(g), true, "still out on the last tick");
  g = tick(g, [0, 0]);
  assert.equal(fruitOut(g), false, "gone after 9s");
  assert.equal(g.fruits, 2);
  assert.equal(grab(g).score, g.score + POINTS.pellet, "nothing to grab; no third cherry");
});

test("4s without a dot lets the next ghost out of the house", () => {
  let g = frozen(NEW_GAME); // standing still at spawn: no dots eaten
  const idle = (n: number) => { for (let i = 0; i < n; i++) g = { ...tick(g, [0, 0]), ghosts: NEW_GAME.ghosts }; };
  idle(RELEASE_IDLE - 1);
  assert.deepEqual([2, 3].map((i) => released(g, i)), [false, false]);
  idle(1);
  assert.deepEqual([2, 3].map((i) => released(g, i)), [true, false], "inky freed at 4s");
  idle(RELEASE_IDLE);
  assert.equal(released(g, 3), true, "clyde 4s later");
  assert.equal(tick(primed({ ...g, pos: { row: 1, col: 1 }, dir: [0, 1] }), [0, 1]).idle, 0, "a dot restarts the clock");
});

test("eating the last dot completes the game and freezes it", () => {
  const all = new Set([...DOTS.pellets, ...DOTS.power].map(key));
  all.delete("1,2");
  const g = tick(primed({ ...NEW_GAME, pos: { row: 1, col: 1 }, eaten: all }), [0, 1]);
  assert.equal(cleared(g), true);
  assert.equal(g.lives, LIVES);
  assert.equal(tick(g, [0, 1]), g);
});

test("ghosts leave the house in release order and stay off walls", () => {
  let g = frozen(NEW_GAME);
  // Well short of RELEASE_IDLE, so only the two released at zero dots can be out.
  for (let i = 0; i < RELEASE_IDLE / 2; i++) g = tick(g, [0, 0]);
  assert.deepEqual(g.ghosts.map((x) => x.out), [true, true, false, false], "inky/clyde wait for dots");
  for (const x of g.ghosts) assert.notEqual(MAZE[x.pos.row]![x.pos.col], CELL.WALL);
  g = { ...g, eaten: new Set(Array.from({ length: 60 }, (_, i) => `d${i}`)) };
  for (let i = 0; i < RELEASE_IDLE / 2; i++) g = tick(g, [0, 0]);
  assert.deepEqual(g.ghosts.map((x) => x.out), [true, true, true, true]);
});

test("a power pellet frightens the ghosts: reverse, crawl at SPEED.fright, time out", () => {
  // Ghost heading up the open column 1 at (4,1); Pac-Man steps left from (1,2) onto the power pellet at (1,1).
  let g = tick(primed({ ...NEW_GAME, pos: { row: 1, col: 2 }, dir: [0, -1], ghosts: [ghost({ row: 4, col: 1 }, [-1, 0]), ...NEW_GAME.ghosts.slice(1)] }), [0, -1]);
  assert.equal(g.fright, FRIGHT.ticks);
  assert.notDeepEqual(g.ghosts[0]!.pos, { row: 3, col: 1 }, "reversed, so not carrying on up");
  g = frozen({ ...g, pos: { row: 20, col: 11 } }); // parked out of the wanderer's reach, so it can't get eaten

  let moves = 0;
  for (let i = 1; i < FRIGHT.ticks; i++) {
    const before = g.ghosts[0]!.pos;
    g = alone(tick(g, [0, 0]));
    if (key(g.ghosts[0]!.pos) !== key(before)) moves++;
    assert.notEqual(MAZE[g.ghosts[0]!.pos.row]![g.ghosts[0]!.pos.col], CELL.WALL);
  }
  // It banks a tile fraction per tick, so the tile count follows from the rate. Which rate
  // depends on where it wandered: a frightened ghost steers randomly, and any stretch spent
  // within TUNNEL_REACH of a teleport mouth is slower still, so bound it by both.
  const ticks = FRIGHT.ticks - 1;
  const most = ticks * rate(SPEED.fright) + 2, least = ticks * rate(SPEED.tunnel) - 2;
  assert.ok(moves >= least && moves <= most, `${moves} moves, expected ${least.toFixed(1)}..${most.toFixed(1)}`);
  assert.ok(rate(SPEED.fright) < rate(SPEED.ghost), "frightened is slower than normal");
  assert.equal(g.fright, 1);
  assert.equal(tick(g, [0, 0]).fright, 0);
});

test("the scatter/chase clock pauses while the ghosts are frightened", () => {
  // Clock on the last scatter tick; Pac-Man steps left from (1,2) onto the power pellet at (1,1).
  const last = 7 * SEC - 1;
  let g = tick(primed({ ...NEW_GAME, pos: { row: 1, col: 2 }, dir: [0, -1], t: last, clock: last }), [0, -1]);
  assert.equal(g.fright, FRIGHT.ticks);
  for (let i = 1; i < FRIGHT.ticks; i++) {
    g = { ...tick(g, [0, 0]), ghosts: NEW_GAME.ghosts }; // nobody out to bite
    assert.equal(g.clock, last, `paused at fright ${g.fright}`);
  }
  assert.equal(scatter(g.clock), true, "still scatter");
  g = tick(g, [0, 0]);
  assert.deepEqual([g.fright, g.clock, scatter(g.clock)], [0, last + 1, false], "fright over: clock runs and chase begins");
  assert.ok(g.t > g.clock, "the tick count kept going");
});

test("an unfrightened ghost on Pac-Man's tile costs a life and resets the board, not the dots", () => {
  // Blinky heads left from (1,3), Pac-Man right from (1,1): both land on (1,2).
  const blinky = ghost({ row: 1, col: 3 }, [0, -1]);
  const start = primed({ ...NEW_GAME, pos: { row: 1, col: 1 }, eaten: new Set(["9,8"]), ghosts: [blinky, ...NEW_GAME.ghosts.slice(1)], t: 50 });
  let g = tick(start, [0, 1]);
  assert.equal(g.lives, LIVES - 1);
  assert.deepEqual(g.pos, NEW_GAME.pos);
  assert.deepEqual(g.ghosts, NEW_GAME.ghosts);
  assert.equal(g.t, 0);
  assert.equal(g.since, 2, "dots eaten so far, for the after-death release table");
  assert.ok(g.eaten.has("9,8") && g.eaten.has("1,2"), "dots stay eaten");

  const eyes = { ...start, ghosts: [{ ...blinky, mode: "eyes" as const }, ...start.ghosts.slice(1)] };
  assert.equal(tick(eyes, [0, 1]).lives, LIVES, "eyes don't kill");

  g = tick({ ...start, lives: 1 }, [0, 1]);
  assert.equal(g.lives, 0);
  assert.equal(tick(g, [0, 1]), g, "game over: frozen");
});

test("passing straight through an unfrightened ghost still costs a life", () => {
  // Blinky at (1,2) already heading left, Pac-Man at (1,1) heading right: both keep going and swap
  // tiles instead of ever sharing one, so only the before/after positions catch the meeting.
  const start = primed({ ...NEW_GAME, pos: { row: 1, col: 1 }, ghosts: [ghost({ row: 1, col: 2 }, [0, -1]), ...NEW_GAME.ghosts.slice(1)] });
  const g = tick(start, [0, 1]);
  assert.equal(g.lives, LIVES - 1, "the swap still counts as a catch");
  assert.deepEqual(g.pos, NEW_GAME.pos, "reset on the swap-through death");
});

test("one extra life at 10,000 points", () => {
  let g = tick(primed({ ...NEW_GAME, pos: { row: 1, col: 1 }, score: EXTRA_LIFE_AT - POINTS.pellet }), [0, 1]);
  assert.equal(g.lives, LIVES + 1);
  g = tick(primed(g), [0, 1]);
  assert.equal(g.lives, LIVES + 1, "only once");
});

test("eating a scared ghost: 200/400 combo, one-second freeze, eyes run home and regenerate", () => {
  // Same head-on meeting as the death test, but Blinky is scared.
  const blinky = ghost({ row: 1, col: 3 }, [0, -1], "scared");
  const pinky = ghost({ row: 4, col: 1 }, [-1, 0], "scared");
  const start = primed({ ...NEW_GAME, pos: { row: 1, col: 1 }, ghosts: [blinky, pinky, ...NEW_GAME.ghosts.slice(2)], fright: FRIGHT.ticks, t: 1 });
  let g = tick(start, [0, 1]);
  assert.equal(g.lives, LIVES);
  assert.equal(g.score, NEW_GAME.score + POINTS.pellet + POINTS.ghost);
  assert.equal(g.ghosts[0]!.mode, "eyes");
  assert.deepEqual(g.bite, { pos: { row: 1, col: 2 }, points: POINTS.ghost, left: SEC });

  const frz = g;
  for (let i = 0; i < SEC; i++) g = tick(g, [0, 1]);
  assert.equal(g.bite, null);
  assert.deepEqual([g.pos, g.ghosts, g.fright, g.t], [frz.pos, frz.ghosts, frz.fright, frz.t], "nothing moves while frozen");

  // Keep the others in the house meanwhile so a wandering scared ghost can't bump into Pac-Man.
  g = frozen(g);
  for (let i = 0; i < 20 * SEC && g.ghosts[0]!.mode === "eyes"; i++) g = alone(tick(g, [0, 0]));
  assert.equal(g.ghosts[0]!.mode, "normal", "eyes are home and regenerated");
  assert.equal(g.ghosts[0]!.out, false);

  // Pinky, still scared, is the second ghost of this pellet: 400.
  const again = primed({ ...g, pos: { row: 1, col: 1 }, dir: [0, 1] as Dir, ghosts: [g.ghosts[0]!, ghost({ row: 1, col: 3 }, [0, -1], "scared"), ...g.ghosts.slice(2)], fright: FRIGHT.ticks, combo: 1 });
  assert.equal(tick(again, [0, 1]).score - again.score, 2 * POINTS.ghost);
  // A new power pellet restarts the combo.
  assert.equal(tick(primed({ ...again, pos: { row: 1, col: 2 }, dir: [0, -1] as Dir, ghosts: [g.ghosts[0]!, ghost({ row: 1, col: 8 }, [0, -1], "scared"), ...g.ghosts.slice(2)] }), [0, -1]).combo, 0);
});
