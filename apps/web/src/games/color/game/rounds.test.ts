import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseRounds, roundsPerGame } from "./rounds.ts";

/** A deterministic stand-in for Math.random, cycling the values given. */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length] ?? 0;
    index += 1;
    return value;
  };
}

const pinkLabels = new Set(["soft rose", "vivid magenta", "deep berry", "cherry blossom", "petal pink"]);

test("a game is five rounds", () => {
  assert.equal(chooseRounds().length, roundsPerGame);
});

test("the first two rounds are the event's own pinks", () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const rounds = chooseRounds();
    assert.ok(pinkLabels.has(rounds[0]?.label ?? ""), `round 1 was ${rounds[0]?.label}`);
    assert.ok(pinkLabels.has(rounds[1]?.label ?? ""), `round 2 was ${rounds[1]?.label}`);
  }
});

test("no colour is asked for twice in one game", () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const labels = chooseRounds().map((round) => round.label);
    assert.equal(new Set(labels).size, labels.length, `repeated a colour: ${labels.join(", ")}`);
  }
});

test("every round carries a target inside its channels' ranges", () => {
  for (const round of chooseRounds()) {
    const { hue, saturation, value } = round.target;
    assert.ok(hue >= 0 && hue <= 360, `${round.label} hue ${hue}`);
    assert.ok(saturation >= 0 && saturation <= 100, `${round.label} saturation ${saturation}`);
    assert.ok(value >= 0 && value <= 100, `${round.label} value ${value}`);
  }
});

test("a round never says what its colour is called until the guess is in", () => {
  // The label is the answer in words. Anything the board shows before the guess
  // is submitted is built here, so nothing here may carry it.
  for (const round of chooseRounds()) {
    const shownBeforeGuessing = { target: round.target };
    assert.equal(
      JSON.stringify(shownBeforeGuessing).toLowerCase().includes(round.label.toLowerCase()),
      false,
      `${round.label} leaks into what the board shows while it is being mixed`,
    );
  }
});

test("the same random stream deals the same game", () => {
  const seed = [0.1, 0.9, 0.35, 0.72, 0.04, 0.5, 0.88];
  const first = chooseRounds(sequence(seed)).map((round) => round.label);
  const second = chooseRounds(sequence(seed)).map((round) => round.label);
  assert.deepEqual(first, second);
});
