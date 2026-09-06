import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginPlay,
  cellCount,
  chooseSquare,
  createPatternGame,
  gridSize,
  nextLevel,
  replayLevel,
  revealMs,
  STARTING_LIVES,
  targetCount,
  type PatternGame,
} from "./pattern.ts";

/** A deal nobody shuffled, so the pattern is always the first squares. */
const ordered = () => createPatternGame(() => 0);

/** The squares that are not in the pattern, for choosing a wrong one. */
function wrongSquare(game: PatternGame) {
  for (let index = 0; index < cellCount(game.level); index += 1) {
    if (!game.pattern.has(index)) return index;
  }
  throw new Error("Every square is lit.");
}

test("the board starts small and grows every four levels", () => {
  assert.equal(gridSize(1), 3);
  assert.equal(gridSize(4), 3);
  assert.equal(gridSize(5), 4, "level five widens the board");
  assert.equal(gridSize(999), 10, "and it stops at ten");
});

test("the pattern never asks for more squares than the board holds", () => {
  for (let level = 1; level <= 60; level += 1) {
    assert.ok(targetCount(level) <= cellCount(level), `level ${level} fits`);
    assert.ok(targetCount(level) >= 3, `level ${level} lights at least three`);
  }
});

test("the pattern is shown for less time as the levels climb, down to a floor", () => {
  assert.ok(revealMs(1) > revealMs(10));
  assert.equal(revealMs(999), 900, "never faster than the floor");
});

test("a fresh round is level one on full lives, already showing", () => {
  const game = ordered();
  assert.equal(game.level, 1);
  assert.equal(game.cleared, 0);
  assert.equal(game.lives, STARTING_LIVES);
  assert.equal(game.phase, "showing");
  assert.equal(game.pattern.size, targetCount(1));
});

test("squares cannot be answered until the pattern is hidden", () => {
  const showing = ordered();
  assert.equal(chooseSquare(showing, [...showing.pattern][0]!), showing, "showing is not playing");
  const playing = beginPlay(showing);
  assert.equal(playing.phase, "playing");
  assert.notEqual(chooseSquare(playing, [...playing.pattern][0]!), playing);
});

test("answering every lit square clears the level", () => {
  let game = beginPlay(ordered());
  for (const index of game.pattern) game = chooseSquare(game, index);
  assert.equal(game.phase, "levelCleared");
  assert.equal(game.cleared, 1, "the level just finished is the one banked");
});

test("the same square twice does not count twice", () => {
  let game = beginPlay(ordered());
  const [first] = [...game.pattern];
  game = chooseSquare(game, first!);
  const afterRepeat = chooseSquare(game, first!);
  assert.equal(afterRepeat, game, "the board does not move");
});

test("a wrong square costs a life and replays the same level", () => {
  const playing = beginPlay(ordered());
  const missed = chooseSquare(playing, wrongSquare(playing));
  assert.equal(missed.lives, STARTING_LIVES - 1);
  assert.equal(missed.phase, "showing", "the pattern comes back");
  assert.equal(missed.level, playing.level, "on the same level");
  assert.deepEqual(missed.pattern, playing.pattern, "with the same pattern");
  assert.equal(missed.picked.size, 0, "and nothing already answered");

  const replayed = replayLevel(missed);
  assert.equal(replayed.wrong, null);
});

test("the round ends when the last life goes", () => {
  let game = beginPlay(ordered());
  for (let life = 0; life < STARTING_LIVES; life += 1) {
    game = chooseSquare(game, wrongSquare(game));
    if (game.phase === "showing") game = beginPlay(replayLevel(game));
  }
  assert.equal(game.lives, 0);
  assert.equal(game.phase, "failed");
});

test("a cleared level deals the next one", () => {
  let game = beginPlay(ordered());
  for (const index of game.pattern) game = chooseSquare(game, index);
  const next = nextLevel(game, () => 0);
  assert.equal(next.level, 2);
  assert.equal(next.phase, "showing");
  assert.equal(next.picked.size, 0);
  assert.equal(next.pattern.size, targetCount(2));
  assert.equal(next.cleared, 1, "what was banked stays banked");
});

test("the levels cleared is what a finished round scores", () => {
  let game = beginPlay(ordered());
  // Clear two levels, then lose every life on the third.
  for (let round = 0; round < 2; round += 1) {
    for (const index of game.pattern) game = chooseSquare(game, index);
    game = beginPlay(nextLevel(game, () => 0));
  }
  assert.equal(game.cleared, 2);
  for (let life = 0; life < STARTING_LIVES; life += 1) {
    game = chooseSquare(game, wrongSquare(game));
    if (game.phase === "showing") game = beginPlay(replayLevel(game));
  }
  assert.equal(game.phase, "failed");
  assert.equal(game.cleared, 2, "a level begun but not finished does not count");
});
