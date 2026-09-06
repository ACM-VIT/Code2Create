import { test } from "node:test";
import assert from "node:assert/strict";
import { gameDefinition } from "@code2create/domain";
import { fastestRunMs } from "./timing.ts";

test("a flawless run is fast enough that the server would still take it", () => {
  const game = gameDefinition("color");
  assert.ok(game, "colour match is a published game");
  // This score does not grow with time, so the fastest possible perfect game is
  // the one the plausibility bound has to clear. Slow the board down or speed it
  // up and this fails until the catalogue is edited with it.
  const allowedAtFastest = (fastestRunMs / 1_000) * game.maximumScorePerSecond;
  assert.ok(
    allowedAtFastest >= game.maximumScore,
    `${game.maximumScorePerSecond}/s allows only ${allowedAtFastest} in the ${fastestRunMs}ms a perfect game takes`,
  );
});

test("the bound still refuses a score nobody had time to earn", () => {
  const game = gameDefinition("color");
  assert.ok(game);
  const allowedInOneSecond = game.maximumScorePerSecond;
  assert.ok(
    allowedInOneSecond < game.maximumScore,
    "a perfect game claimed a second after it opened must not be believed",
  );
});
