import assert from "node:assert/strict";
import test from "node:test";

import {
  compareSynesthesiaQueueItems,
  mergeSynesthesiaVoteCounts,
  type SynesthesiaQueueItem,
} from "./synesthesia.ts";

function item(
  state: SynesthesiaQueueItem["state"],
  voteCount: number,
  createdAt: number,
  queueMode: SynesthesiaQueueItem["queueMode"] = "normal",
  scheduledFor?: number,
): SynesthesiaQueueItem {
  return {
    state,
    queueMode,
    voteCount,
    createdAt,
    ...(scheduledFor !== undefined ? { scheduledFor } : {}),
  };
}

test("orders the live queue by operational state before votes", () => {
  const rows = [
    item("pending", 100, 1),
    item("approved", 50, 2),
    item("queued", 2, 3),
    item("playing", 0, 4),
  ].sort(compareSynesthesiaQueueItems);

  assert.deepEqual(
    rows.map((row) => row.state),
    ["playing", "queued", "approved", "pending"],
  );
});

test("merges a sparse count projection and orders the resulting queue", () => {
  const rows = mergeSynesthesiaVoteCounts(
    [
      { id: "older", state: "pending", queueMode: "normal", createdAt: 1 },
      { id: "popular", state: "pending", queueMode: "normal", createdAt: 2 },
      { id: "no-votes", state: "pending", queueMode: "normal", createdAt: 0 },
    ],
    [{ requestId: "popular", voteCount: 4 }],
  );

  assert.deepEqual(
    rows.map((row) => [row.id, row.voteCount]),
    [
      ["popular", 4],
      ["no-votes", 0],
      ["older", 0],
    ],
  );
});

test("orders equal-state requests by queue controls, votes, then age", () => {
  const rows = [
    item("queued", 8, 50, "normal"),
    item("queued", 2, 40, "pinned"),
    item("queued", 2, 30, "normal"),
    item("queued", 99, 20, "deferred", 90),
  ].sort(compareSynesthesiaQueueItems);

  assert.deepEqual(
    rows.map((row) => [row.queueMode, row.createdAt]),
    [
      ["pinned", 40],
      ["normal", 50],
      ["normal", 30],
      ["deferred", 20],
    ],
  );
});
