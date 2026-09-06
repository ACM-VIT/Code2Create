import { test } from "node:test";
import assert from "node:assert/strict";
import { shuffled } from "./shuffle.ts";

const deck = ["a", "b", "c", "d", "e"] as const;

test("a shuffle keeps every item and the original list", () => {
  const source = [...deck];
  const result = shuffled(source);
  assert.deepEqual([...result].sort(), [...deck].sort());
  assert.deepEqual(source, [...deck], "the list handed in is not reordered under the caller");
});

test("an empty list and a single item survive", () => {
  assert.deepEqual(shuffled([]), []);
  assert.deepEqual(shuffled(["only"]), ["only"]);
});

test("every position is reachable by every item", () => {
  // 400 deals of five: if any item never reached some position, the shuffle is
  // leaving part of the order fixed.
  const seen = new Map<string, Set<number>>(deck.map((item) => [item, new Set<number>()]));
  for (let deal = 0; deal < 400; deal += 1) {
    shuffled(deck).forEach((item, index) => seen.get(item)?.add(index));
  }
  for (const item of deck) {
    assert.equal(seen.get(item)?.size, deck.length, `${item} never reached every position`);
  }
});

test("the order really moves", () => {
  const unchanged = Array.from({ length: 200 }, () => shuffled(deck)).filter(
    (result) => result.join("") === deck.join(""),
  );
  // One deal in 120 comes back in order, so a handful is expected and a hundred
  // is a shuffle that is not shuffling.
  assert.ok(unchanged.length < 20, `${unchanged.length} of 200 deals came back untouched`);
});
