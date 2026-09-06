import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accuracyPercentage,
  accuracyScore,
  hsvToHex,
  hsvToRgb,
  rgbToOklab,
  type HsvColor,
} from "./color.ts";

const rose: HsvColor = { hue: 335, saturation: 65, value: 85 };

test("hsv reaches the corners of rgb it is meant to", () => {
  assert.deepEqual(hsvToRgb({ hue: 0, saturation: 100, value: 100 }), [1, 0, 0]);
  assert.deepEqual(hsvToRgb({ hue: 120, saturation: 100, value: 100 }), [0, 1, 0]);
  assert.deepEqual(hsvToRgb({ hue: 240, saturation: 100, value: 100 }), [0, 0, 1]);
  assert.deepEqual(hsvToRgb({ hue: 0, saturation: 0, value: 0 }), [0, 0, 0], "no value is black");
});

test("the hue wheel wraps rather than running off its end", () => {
  assert.deepEqual(hsvToRgb({ ...rose, hue: 360 }), hsvToRgb({ ...rose, hue: 0 }));
  assert.deepEqual(hsvToRgb({ ...rose, hue: 335 + 720 }), hsvToRgb(rose));
  assert.deepEqual(hsvToRgb({ ...rose, hue: -25 }), hsvToRgb(rose), "-25 is 335 the other way round");
});

test("a channel past its end is held at its end", () => {
  assert.deepEqual(hsvToRgb({ hue: 0, saturation: 400, value: 400 }), hsvToRgb({ hue: 0, saturation: 100, value: 100 }));
  assert.deepEqual(hsvToRgb({ hue: 0, saturation: -50, value: 50 }), hsvToRgb({ hue: 0, saturation: 0, value: 50 }));
});

test("hex is always six digits, zero-padded", () => {
  assert.equal(hsvToHex({ hue: 0, saturation: 0, value: 100 }), "#ffffff");
  assert.equal(hsvToHex({ hue: 0, saturation: 0, value: 0 }), "#000000");
  assert.match(hsvToHex({ hue: 240, saturation: 100, value: 4 }), /^#[0-9a-f]{6}$/);
});

test("oklab puts white at the light end and black at the dark one", () => {
  const white = rgbToOklab(1, 1, 1);
  const black = rgbToOklab(0, 0, 0);
  assert.ok(Math.abs(white.L - 1) < 0.001, `white sits at L≈1, got ${white.L}`);
  assert.ok(Math.abs(black.L) < 0.001, `black sits at L≈0, got ${black.L}`);
  assert.ok(Math.abs(white.a) < 0.001 && Math.abs(white.b) < 0.001, "white has no colour to it");
});

test("an exact match is 100, and the far side of the wheel is not", () => {
  assert.equal(accuracyPercentage(rose, rose), 100);
  const opposite: HsvColor = { hue: 155, saturation: 65, value: 85 };
  assert.ok(accuracyPercentage(opposite, rose) < 50, "a complementary colour is plainly a different one");
});

test("accuracy falls as the guess moves away", () => {
  const near = accuracyPercentage({ ...rose, hue: 340 }, rose);
  const far = accuracyPercentage({ ...rose, hue: 30 }, rose);
  assert.ok(near > far, `a near miss (${near}) must beat a far one (${far})`);
  assert.ok(near > 90, `five degrees off is still nearly right, got ${near}`);
});

test("accuracy stays inside its own range", () => {
  const worst = accuracyPercentage({ hue: 0, saturation: 0, value: 100 }, { hue: 0, saturation: 0, value: 0 });
  assert.ok(worst >= 0 && worst <= 100, `white against black scored ${worst}`);
});

test("the game's score is the mean of its rounds, in hundredths", () => {
  assert.equal(accuracyScore([100, 100, 100, 100, 100]), 10_000);
  assert.equal(accuracyScore([90, 80]), 8_500);
  assert.equal(accuracyScore([94.115]), 9_412, "rounded to the nearest hundredth of a percent");
});

test("more rounds do not by themselves raise the score", () => {
  // The board is an accuracy, so playing on at the same standard must leave it
  // where it was — a total would climb instead.
  assert.equal(accuracyScore([80, 80]), accuracyScore([80, 80, 80, 80]));
});

test("a game with no rounds scores nothing", () => {
  assert.equal(accuracyScore([]), 0);
});
