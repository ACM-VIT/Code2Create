import assert from "node:assert/strict";
import test from "node:test";

import type { Id } from "../_generated/dataModel";
import { reviewOverviewCounts } from "./reviewOverviewCounts.ts";

type OverviewInput = Parameters<typeof reviewOverviewCounts>[0];
const panelA = "panel-a" as Id<"reviewPanels">;
const panelB = "panel-b" as Id<"reviewPanels">;

test("overview counts preserve every queue state and only infer unassigned teams without state", () => {
  const stateNames: readonly OverviewInput["states"][number]["state"][] = [
    "unassigned", "queued", "queued", "called", "at_table", "in_review", "completed", "held", "missed", "withdrawn",
  ];
  const states = stateNames.map((state, index) => ({
    teamId: `team-${index}` as Id<"teams">,
    panelId: panelA,
    state,
  }));
  const counts = reviewOverviewCounts({
    states: [...states, { teamId: "team-other" as Id<"teams">, panelId: panelB, state: "queued" }],
    reviewableTeams: [...states.map((state) => ({ _id: state.teamId })), { _id: "team-new" as Id<"teams"> }],
    liveSessions: [{ panelId: panelA }, { panelId: panelA }, { panelId: panelB }],
  });
  assert.deepEqual(counts.stateCounts, { unassigned: 2, queued: 3, called: 2, inReview: 1, completed: 1, held: 1 });
  assert.deepEqual(counts.queuedByPanel, new Map([[panelA, 2], [panelB, 1]]));
  assert.deepEqual(counts.activeByPanel, new Map([[panelA, 2], [panelB, 1]]));
});

test("empty rounds and teams that have not entered any round retain their counts", () => {
  const empty = reviewOverviewCounts({ states: [], liveSessions: [], reviewableTeams: [] });
  assert.deepEqual(empty.stateCounts, { unassigned: 0, queued: 0, called: 0, inReview: 0, completed: 0, held: 0 });
  assert.equal(empty.queuedByPanel.size, 0);
  assert.equal(empty.activeByPanel.size, 0);
  assert.equal(reviewOverviewCounts({
    states: [], liveSessions: [], reviewableTeams: [{ _id: "team-new" as Id<"teams"> }],
  }).stateCounts.unassigned, 1);
});

test("a full overview visits each team state once regardless of the panel count", () => {
  let stateReads = 0;
  const states: OverviewInput["states"] = Array.from({ length: 400 }, (_, index) => ({
    teamId: `team-${index}` as Id<"teams">,
    panelId: `panel-${index % 100}` as Id<"reviewPanels">,
    get state() {
      stateReads += 1;
      return "queued" as const;
    },
  }));
  const counts = reviewOverviewCounts({ states, liveSessions: [], reviewableTeams: [] });
  assert.equal(counts.stateCounts.queued, 400);
  assert.equal(counts.queuedByPanel.size, 100);
  assert.ok(stateReads <= states.length * 2);
});
