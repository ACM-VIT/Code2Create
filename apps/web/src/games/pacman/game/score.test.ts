import { test } from "node:test";
import assert from "node:assert/strict";
import { gameDefinition } from "@code2create/domain";
import { CELL, tilesOf } from "./maze.ts";
import { DOT_KEYS, DOTS, FRUIT_AT, POINTS } from "./pickups.ts";

/**
 * The most one round of the shipped maze can score: every dot, both cherries,
 * and all four ghosts on every power pellet.
 *
 * Ghosts are worth 200, 400, 800 and 1,600 in a single fright — 3,000 for a
 * clean sweep — and the fright resets with each power pellet.
 */
function highestPossibleScore(): number {
  const pellets = tilesOf(CELL.PATH).length * POINTS.pellet;
  const power = tilesOf(CELL.POWER_PELLET);
  const powerPellets = power.length * POINTS.power;
  const cherries = FRUIT_AT.length * POINTS.cherry;
  const ghostSweep = POINTS.ghost + POINTS.ghost * 2 + POINTS.ghost * 4 + POINTS.ghost * 8;
  return pellets + powerPellets + cherries + power.length * ghostSweep;
}

test("the maze holds the dots the scoring assumes", () => {
  assert.equal(DOTS.pellets.length, 233);
  assert.equal(DOTS.power.length, 6);
  assert.equal(DOT_KEYS.size, 239, "every dot is scorable exactly once");
});

test("the published maximum is exactly what the board can produce", () => {
  const game = gameDefinition("pacman");
  assert.ok(game, "pacman is a published game");
  // Slack above the real ceiling is room a score that was never played can sit
  // in, so the two are held equal rather than merely ordered. Edit the maze and
  // this fails until the catalogue is edited with it.
  assert.equal(game.maximumScore, highestPossibleScore());
  assert.equal(game.maximumScore, 20_830);
});

test("the fastest scoring the server allows still covers a real ghost sweep", () => {
  const game = gameDefinition("pacman");
  assert.ok(game);
  // A four-ghost sweep is 3,000 points and can be done in about four seconds,
  // so the plausibility bound has to sit above 750/s or it would refuse the
  // best real play the game has.
  const sweepRate = (POINTS.ghost + POINTS.ghost * 2 + POINTS.ghost * 4 + POINTS.ghost * 8) / 4;
  assert.ok(
    game.maximumScorePerSecond >= sweepRate,
    `${game.maximumScorePerSecond}/s must allow a ${sweepRate}/s sweep`,
  );
});
