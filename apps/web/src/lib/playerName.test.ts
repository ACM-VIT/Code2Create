import { test } from "node:test";
import assert from "node:assert/strict";
import { maximumPlayerNameLength, personLabel, shortPlayerName } from "./playerName.ts";

test("a shouted name is set as a name", () => {
  assert.equal(personLabel("ATHARVA LALWANI"), "Atharva Lalwani");
  assert.equal(personLabel("PRIYA NAIR"), "Priya Nair");
});

test("a name its owner wrote is left alone", () => {
  assert.equal(personLabel("Sneha Kulkarni"), "Sneha Kulkarni");
  assert.equal(personLabel("aditya vardhan"), "aditya vardhan", "lower case is a choice too");
  assert.equal(personLabel("McDonald O'Brien"), "McDonald O'Brien");
});

test("a hyphenated name capitalises on both sides", () => {
  assert.equal(personLabel("ANNA-MARIA RAO"), "Anna-Maria Rao");
});

test("a roll number inside a shouted name keeps its capitals", () => {
  assert.equal(personLabel("22BCE1234 ATHARVA"), "22BCE1234 Atharva");
});

test("a name that fits is shown whole", () => {
  for (const name of ["Priya Nair", "Atharva Lalwani", "Sneha Kulkarni"]) {
    assert.equal(shortPlayerName(name), name);
    assert.ok(name.length <= maximumPlayerNameLength);
  }
});

test("a long name becomes a first name and an initial", () => {
  assert.equal(shortPlayerName("Venkata Naga Sai Krishna Prasad"), "Venkata P.");
  assert.equal(shortPlayerName("Lakshminarayanan Subramanian"), "Lakshminarayanan S.");
});

test("a long name is shortened from its own case, not from capitals", () => {
  assert.equal(shortPlayerName("VENKATA NAGA SAI KRISHNA PRASAD"), "Venkata P.");
});

test("one very long word has no initial to fall back on", () => {
  // Nothing to shorten to, so the column's own ellipsis takes it from here.
  const single = "Lakshminarayanamurthy";
  assert.equal(shortPlayerName(single), single);
  assert.equal(shortPlayerName("Venkatanarasimharajuvaripeta"), "Venkatanarasimharajuvaripeta");
});

test("stray spacing does not become part of the name", () => {
  assert.equal(shortPlayerName("  Priya   Nair  "), "Priya Nair");
  assert.equal(shortPlayerName("Venkata  Naga   Sai  Krishna   Prasad"), "Venkata P.");
});

test("a shortened name is short enough for the column", () => {
  const long = [
    "Venkata Naga Sai Krishna Prasad",
    "VENKATA NAGA SAI KRISHNA PRASAD",
    "Anna-Maria Fernandes Da Silva Costa",
  ];
  for (const name of long) {
    const shown = shortPlayerName(name);
    assert.ok(
      shown.length <= maximumPlayerNameLength,
      `${name} shortened to ${shown}, still ${shown.length} long`,
    );
  }
});

test("an empty name does not throw", () => {
  assert.equal(shortPlayerName(""), "");
  assert.equal(shortPlayerName("   "), "");
});
