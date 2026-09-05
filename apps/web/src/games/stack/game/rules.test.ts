import { test } from "node:test";
import assert from "node:assert/strict";
import {
  drawShapeFromBag,
  dropPiece,
  getEndlessCameraTargetY,
  hasPieceMissed,
  INITIAL_GAME_STATE,
  lockPiece,
  loseLife,
  POINTS_PER_PIECE,
  rotateQuarterTurn,
  SETTLE_MS,
  updateSettlement,
} from "./rules.ts";
import type { GameState, ShapeType } from "./types.ts";

const aiming: GameState = { ...INITIAL_GAME_STATE };

test("a quarter turn wraps back to where it started", () => {
  assert.equal(rotateQuarterTurn(0), 1);
  assert.equal(rotateQuarterTurn(3), 0, "four turns is a full circle");
});

test("only an aiming piece can be dropped", () => {
  assert.equal(dropPiece(aiming).phase, "falling");
  const falling: GameState = { ...aiming, phase: "falling" };
  assert.equal(dropPiece(falling), falling, "a piece already falling is untouched");
});

test("a piece locks only after holding still for the settle time", () => {
  const falling: GameState = { ...aiming, phase: "falling" };
  const touching = updateSettlement(falling, true, 0, 0, 1_000);
  assert.equal(touching.phase, "settling");
  assert.equal(touching.settleStartedAt, 1_000);

  const early = updateSettlement(touching, true, 0, 0, 1_000 + SETTLE_MS - 1);
  assert.equal(early.phase, "settling", "a moment short of the settle time is not a lock");

  const locked = updateSettlement(touching, true, 0, 0, 1_000 + SETTLE_MS);
  assert.equal(locked.phase, "locked");
});

test("a nudged piece starts its settle over", () => {
  const settling: GameState = { ...aiming, phase: "settling", settleStartedAt: 1_000 };
  const jostled = updateSettlement(settling, true, 5, 0, 1_200);
  assert.equal(jostled.phase, "falling");
  assert.equal(jostled.settleStartedAt, null, "the clock restarts rather than carrying on");
});

test("a piece off the stack never settles", () => {
  const falling: GameState = { ...aiming, phase: "falling" };
  assert.equal(updateSettlement(falling, false, 0, 0, 1_000).phase, "falling");
});

test("locking a piece scores it once", () => {
  const locked: GameState = { ...aiming, phase: "locked", settleStartedAt: 10 };
  const scored = lockPiece(locked);
  assert.equal(scored.score, POINTS_PER_PIECE);
  assert.equal(scored.settleStartedAt, null);
  assert.equal(lockPiece(aiming).score, 0, "a piece still aiming scores nothing");
});

test("lives run down to zero and stop", () => {
  assert.equal(loseLife(3), 2);
  assert.equal(loseLife(0), 0, "a finished round cannot go negative");
});

test("a piece below the boundary counts as missed", () => {
  assert.equal(hasPieceMissed(701, 700), true);
  assert.equal(hasPieceMissed(699, 700), false);
});

test("the camera climbs with the stack and never sinks back", () => {
  // A stack top well below the trigger line leaves the camera alone.
  assert.equal(getEndlessCameraTargetY(0, 500, 600, 0.5), 0);
  // One that rises past it pulls the camera up with it.
  assert.equal(getEndlessCameraTargetY(0, -100, 600, 0.5), -400);
});

test("the bag deals every shape before repeating one", () => {
  let bag: ShapeType[] = [];
  const drawn: ShapeType[] = [];
  for (let index = 0; index < 5; index += 1) {
    const draw = drawShapeFromBag(bag);
    bag = draw.bag;
    drawn.push(draw.shape);
  }
  assert.equal(new Set(drawn).size, 5, "a full bag deals each shape exactly once");
  assert.equal(bag.length, 0);
  // An empty bag refills rather than dealing nothing.
  assert.ok(drawShapeFromBag(bag).shape);
});
