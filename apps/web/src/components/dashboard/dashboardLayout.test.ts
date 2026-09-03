import assert from "node:assert/strict";
import { test } from "node:test";

import { areasValue, gridTemplates, tileKeys } from "./dashboardLayout.ts";

function cells(rows: readonly string[]) {
  return rows.flatMap((row) => row.split(" "));
}

test("resting templates place every tile exactly once per breakpoint", () => {
  const templates = gridTemplates(null);
  for (const template of Object.values(templates)) {
    const placed = new Set(cells(template.areas));
    assert.deepEqual([...placed].sort(), [...tileKeys].sort());
    assert.equal(
      template.areas.every((row) => row.split(" ").length === template.areas[0]!.split(" ").length),
      true,
    );
  }
});

test("a focused tile takes the big slot and every other tile keeps a cell", () => {
  for (const focus of tileKeys) {
    const templates = gridTemplates(focus);
    for (const template of Object.values(templates)) {
      const all = cells(template.areas);
      assert.equal(
        all.some((cell) => /^[a-g]$|^F$/.test(cell)),
        false,
        `unfilled slot for ${focus}`,
      );
      const count = all.filter((cell) => cell === focus).length;
      assert.equal(count >= 4, true, `${focus} should span at least four cells`);
      assert.deepEqual([...new Set(all)].sort(), [...tileKeys].sort());
    }
  }
});

test("areas render as quoted rows", () => {
  assert.equal(areasValue({ columns: "", rows: "", areas: ["a b", "c d"] }), '"a b" "c d"');
});
