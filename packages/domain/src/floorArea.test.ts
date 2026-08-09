import assert from "node:assert/strict";
import test from "node:test";

import { type FloorArea, floorAreaAt, floorAreaLabels, floorAreas } from "./labels.ts";

test("a zone rectangle divides into the nine areas people say out loud", () => {
  const cases: [number, number, FloorArea][] = [
    [0, 0, "north_west"],
    [50, 5, "north"],
    [100, 0, "north_east"],
    [5, 50, "west"],
    [50, 50, "centre"],
    [95, 50, "east"],
    [0, 100, "south_west"],
    [50, 95, "south"],
    [100, 100, "south_east"],
  ];
  for (const [x, y, area] of cases) {
    assert.equal(floorAreaAt(x, y), area, `(${x}, ${y})`);
  }
});

test("the thirds meet without a gap or an overlap", () => {
  // A finger landing exactly on a boundary still has to produce one area, and
  // the same one every time, or two mappers describe the same table differently.
  assert.equal(floorAreaAt(100 / 3, 100 / 3), "centre");
  assert.equal(floorAreaAt(100 / 3 - 0.01, 100 / 3), "west");
  assert.equal(floorAreaAt(200 / 3, 200 / 3), "south_east");
  assert.equal(floorAreaAt(200 / 3 - 0.01, 200 / 3 - 0.01), "centre");
});

test("every area has wording a reviewer can be sent to", () => {
  assert.equal(floorAreas.length, 9);
  assert.equal(new Set(floorAreas).size, 9);
  for (const area of floorAreas) {
    const label = floorAreaLabels[area];
    assert.ok(label.length > 0, area);
    assert.ok(!label.includes("_"), `${area} still reads as a stored key`);
  }
});
