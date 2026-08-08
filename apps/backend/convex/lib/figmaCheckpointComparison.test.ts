import assert from "node:assert/strict";
import test from "node:test";

import {
  compareFigmaCheckpointFacts,
  type FigmaComparableFact,
} from "./figmaCheckpointComparison.ts";

type FactId = `fact-${string}`;

function fact(
  factId: FactId,
  nodeId: string,
  semanticHash: string,
): FigmaComparableFact<FactId> {
  return {
    factId,
    nodeId,
    nodeName: `Frame ${nodeId}`,
    nodeType: "FRAME",
    pageName: "Main",
    semanticHash,
    renderState: "available",
  };
}

test("compares matching, added, and removed preview facts", () => {
  const comparison = compareFigmaCheckpointFacts({
    current: [
      fact("fact-current-a", "a", "same"),
      fact("fact-current-b", "b", "after"),
      fact("fact-current-c", "c", "new"),
    ],
    previous: [
      fact("fact-previous-a", "a", "same"),
      fact("fact-previous-b", "b", "before"),
      fact("fact-previous-d", "d", "removed"),
    ],
    currentTruncated: false,
    previousTruncated: false,
  });

  assert.deepEqual(comparison.rows.map((row) => [row.nodeId, row.state]), [
    ["b", "changed"],
    ["c", "added"],
    ["d", "removed"],
    ["a", "unchanged"],
  ]);
  assert.deepEqual(comparison.counts, {
    added: 1,
    removed: 1,
    changed: 1,
    unchanged: 1,
    uncertain: 0,
  });
});

test("does not claim additions or removals outside a truncated preview set", () => {
  const comparison = compareFigmaCheckpointFacts({
    current: [fact("fact-current", "current", "current")],
    previous: [fact("fact-previous", "previous", "previous")],
    currentTruncated: true,
    previousTruncated: true,
  });

  assert.deepEqual(comparison.rows.map((row) => row.state), ["uncertain", "uncertain"]);
  assert.equal(comparison.counts.uncertain, 2);
});

test("rejects duplicate node facts instead of producing an ambiguous comparison", () => {
  assert.throws(
    () =>
      compareFigmaCheckpointFacts({
        current: [
          fact("fact-one", "same", "first"),
          fact("fact-two", "same", "second"),
        ],
        previous: [],
        currentTruncated: false,
        previousTruncated: false,
      }),
    /same preview node more than once/,
  );
});
