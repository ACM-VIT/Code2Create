import assert from "node:assert/strict";
import { test } from "node:test";

import { areasValue, composeDashboard, gridTemplates, slots, tileKeys } from "./dashboardLayout.ts";

function cells(rows: readonly string[]) {
  return rows.flatMap((row) => row.split(" "));
}

test("resting templates place every slot exactly once per breakpoint", () => {
  for (const template of Object.values(gridTemplates(null))) {
    assert.deepEqual([...new Set(cells(template.areas))].sort(), [...slots].sort());
    const width = template.areas[0]!.split(" ").length;
    assert.equal(template.areas.every((row) => row.split(" ").length === width), true);
  }
});

test("an opened slot takes the big spot and every other slot keeps a cell", () => {
  for (const focus of slots) {
    for (const template of Object.values(gridTemplates(focus))) {
      const all = cells(template.areas);
      assert.equal(all.some((cell) => /^[a-g]$|^F$/.test(cell)), false, `unfilled letter for ${focus}`);
      assert.equal(all.filter((cell) => cell === focus).length >= 4, true, `${focus} should span four cells`);
      assert.deepEqual([...new Set(all)].sort(), [...slots].sort());
    }
  }
});

test("the seven most relevant tiles are seated, most relevant most prominent", () => {
  const seating = composeDashboard([
    { key: "event", score: 90, prefer: ["wide", "box"] },
    { key: "music", score: 80, prefer: ["tall", "wide"] },
    { key: "squad", score: 50, prefer: ["box", "tall"] },
    { key: "integrations", score: 60, prefer: ["box", "wide"] },
    { key: "updates", score: 85, prefer: ["tall", "box"] },
    { key: "review", score: 0, prefer: ["wide", "tall"] },
    { key: "help", score: 35, prefer: ["box", "wide"] },
    { key: "benefits", score: 70, prefer: ["box", "tall"] },
  ]);
  assert.equal(seating.review, undefined);
  assert.equal(seating.event, "hero");
  assert.equal(seating.updates, "feature");
  assert.equal(seating.music, "rose");
  assert.equal(seating.benefits, "blossom");
  assert.equal(seating.help, "small");
  assert.equal(Object.keys(seating).length, 7);
});

test("ties keep the order the caller gave", () => {
  const seating = composeDashboard(tileKeys.map((key) => ({ key, score: 1, prefer: [] })));
  assert.equal(seating.event, "hero");
  assert.notEqual(seating.help, undefined);
  assert.equal(seating.benefits, undefined);
});

test("areas render as quoted rows", () => {
  assert.equal(areasValue({ columns: "", rows: "", areas: ["a b", "c d"] }), '"a b" "c d"');
});
