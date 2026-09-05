import { test } from "node:test";
import assert from "node:assert/strict";
import {
  concealMismatch,
  createGame,
  matchedPairs,
  MOTIFS,
  PAIR_COUNT,
  selectCard,
  type MemoryGame,
} from "./engine.ts";
import { MINIMUM_FINISHED_SCORE, PERFECT_SCORE, roundScore } from "./score.ts";

/** A deal nobody shuffled, so a test can name the cards it wants. */
const ordered = () => createGame(() => 0);

function idsOf(game: MemoryGame, motif: string) {
  return game.cards.filter((card) => card.pairKey === motif).map((card) => card.id);
}

test("the deck is two of every motif", () => {
  const game = ordered();
  assert.equal(game.cards.length, PAIR_COUNT * 2);
  for (const { motif } of MOTIFS) {
    assert.equal(idsOf(game, motif).length, 2, `${motif} appears twice`);
  }
});

test("a shuffle keeps the same cards", () => {
  const shuffled = createGame();
  const counts = new Map<string, number>();
  for (const card of shuffled.cards) {
    counts.set(card.pairKey, (counts.get(card.pairKey) ?? 0) + 1);
  }
  assert.equal(counts.size, PAIR_COUNT);
  assert.ok([...counts.values()].every((count) => count === 2));
});

test("a matching pair stays face up and costs one move", () => {
  let game = ordered();
  const [first, second] = idsOf(game, "Shark");
  assert.ok(first && second);

  const opened = selectCard(game, first);
  assert.equal(opened.event.type, "first");
  assert.equal(opened.state.moves, 0, "turning the first card is not yet a move");

  const closed = selectCard(opened.state, second);
  assert.equal(closed.event.type, "match");
  assert.equal(closed.state.moves, 1);
  game = closed.state;
  assert.equal(matchedPairs(game), 1);
  assert.ok(game.cards.filter((card) => card.pairKey === "Shark").every((card) => card.isMatched));
});

test("a mismatch counts a move and turns back over", () => {
  const game = ordered();
  const [shark] = idsOf(game, "Shark");
  const [whale] = idsOf(game, "Whale");
  assert.ok(shark && whale);

  const opened = selectCard(game, shark);
  const missed = selectCard(opened.state, whale);
  assert.equal(missed.event.type, "mismatch");
  assert.equal(missed.state.moves, 1);
  assert.equal(missed.state.pendingMismatch.length, 2);

  const concealed = concealMismatch(missed.state);
  assert.ok(concealed.cards.every((card) => !card.isFaceUp));
  assert.equal(concealed.pendingMismatch.length, 0);
  assert.equal(concealed.moves, 1, "concealing does not change the count");
});

test("a third card is ignored while a mismatch is still showing", () => {
  const game = ordered();
  const [shark] = idsOf(game, "Shark");
  const [whale] = idsOf(game, "Whale");
  const [fish] = idsOf(game, "Fish");
  assert.ok(shark && whale && fish);

  const missed = selectCard(selectCard(game, shark).state, whale);
  const third = selectCard(missed.state, fish);
  assert.equal(third.event.type, "ignored");
  assert.equal(third.state, missed.state, "the board does not move");
});

test("the same card twice is ignored", () => {
  const game = ordered();
  const [shark] = idsOf(game, "Shark");
  assert.ok(shark);
  const opened = selectCard(game, shark);
  assert.equal(selectCard(opened.state, shark).event.type, "ignored");
});

test("clearing the last pair completes the board", () => {
  let game = ordered();
  let event = "";
  for (const { motif } of MOTIFS) {
    const [first, second] = idsOf(game, motif);
    assert.ok(first && second);
    game = selectCard(game, first).state;
    const closed = selectCard(game, second);
    game = closed.state;
    event = closed.event.type;
  }
  assert.equal(event, "complete");
  assert.equal(game.status, "complete");
  assert.equal(game.moves, PAIR_COUNT, "a flawless board is one move a pair");
  assert.equal(matchedPairs(game), PAIR_COUNT);
});

test("a finished board is ignored", () => {
  let game = ordered();
  for (const { motif } of MOTIFS) {
    const [first, second] = idsOf(game, motif);
    assert.ok(first && second);
    game = selectCard(game, second).state;
    game = selectCard(game, first).state;
  }
  const [shark] = idsOf(game, "Shark");
  assert.ok(shark);
  assert.equal(selectCard(game, shark).event.type, "ignored");
});

test("the score rewards fewer moves and a faster clock", () => {
  // The perfect board, scored the instant it is finished, is the ceiling.
  assert.equal(roundScore({ moves: PAIR_COUNT, seconds: 0 }), PERFECT_SCORE);
  assert.ok(roundScore({ moves: 14, seconds: 40 }) > roundScore({ moves: 20, seconds: 40 }));
  assert.ok(roundScore({ moves: 14, seconds: 40 }) > roundScore({ moves: 14, seconds: 90 }));
});

test("a slow board still records as a finish", () => {
  assert.equal(roundScore({ moves: 400, seconds: 4_000 }), MINIMUM_FINISHED_SCORE);
});

test("no board scores above the published maximum", () => {
  // The catalogue's ceiling is this exact number, so nothing may exceed it.
  assert.equal(roundScore({ moves: 0, seconds: 0 }), PERFECT_SCORE);
});
