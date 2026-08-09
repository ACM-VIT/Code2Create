import assert from "node:assert/strict";
import test from "node:test";

import { floorLocationDescription, nearestLandmarkName } from "./floor.ts";

// A wide, shallow hall: the same percentage step is nearly three times as far
// across the room as it is along it, which is the whole reason distance is
// measured in metres rather than in shares of a rectangle.
const zone = { widthMeters: 30, depthMeters: 12 };
const landmarks = [
  { name: "the stage", x: 50, y: 0 },
  { name: "the windows", x: 100, y: 50 },
  { name: "the main entrance", x: 0, y: 100 },
];

test("a team standing by a landmark is described by it", () => {
  assert.equal(nearestLandmarkName(zone, landmarks, 96, 52), "the windows");
  assert.equal(nearestLandmarkName(zone, landmarks, 50, 8), "the stage");
});

test("a team in open floor is not given a landmark it is nowhere near", () => {
  assert.equal(nearestLandmarkName(zone, landmarks, 50, 50), undefined);
});

test("the nearest landmark is measured across the real room, not the drawing", () => {
  // Ten percent across this hall is 3m; ten percent along it is 1.2m. The
  // nearer landmark on the drawing is the further one to walk.
  const across = { name: "the power wall", x: 40, y: 0 };
  const along = { name: "the help desk", x: 50, y: 20 };
  assert.equal(nearestLandmarkName(zone, [across, along], 50, 0), "the help desk");
});

test("the description says the part of the room, then what is beside it", () => {
  assert.equal(
    floorLocationDescription("East wing", "north_east", "the windows"),
    "North-east corner of East wing, near the windows",
  );
  assert.equal(
    floorLocationDescription("East wing", "centre", undefined),
    "Middle of East wing",
  );
});
