import assert from "node:assert/strict";
import test from "node:test";

import {
  applyInhibition,
  countPhrase,
  durationPhrase,
  joinNames,
  sortAttentionItems,
  type DetectedAttentionItem,
} from "./operationsAttention.ts";
import type { AttentionDetectorKey, AttentionSeverity } from "../values.ts";

const minute = 60 * 1_000;
const now = 1_770_000_000_000;

function item(
  detectorKey: AttentionDetectorKey,
  scopes: readonly string[],
  overrides: Partial<DetectedAttentionItem> = {},
): DetectedAttentionItem {
  return {
    detectorKey,
    dedupeKey: `${detectorKey}:${scopes.join(",")}`,
    subjectType: "panel",
    subjectId: scopes[0] ?? "subject",
    severity: "attention",
    statement: "",
    route: "/reviews/r1",
    actionLabel: "Open",
    visibility: { permissionKey: "round.read", scopeType: "round", scopeId: "r1" },
    evidenceJson: "{}",
    scopes,
    ...overrides,
  };
}

test("a short panel silences the teams queued behind it", () => {
  const kept = applyInhibition([
    item("panel_seat_empty", ["panel:p1"], { severity: "critical" }),
    item("team_waiting_long", ["team:t1", "panel:p1"], { severity: "watch" }),
    item("team_waiting_long", ["team:t2", "panel:p2"], { severity: "watch" }),
  ]);
  assert.deepEqual(
    kept.map((row) => row.dedupeKey),
    ["panel_seat_empty:panel:p1", "team_waiting_long:team:t2,panel:p2"],
  );
});

test("inhibition only fires between items that share a locus", () => {
  const kept = applyInhibition([
    item("panel_seat_empty", ["panel:p1"], { severity: "critical" }),
    item("seat_at_risk", ["panel:p2", "person:x"]),
  ]);
  assert.equal(kept.length, 2);
});

test("a reviewer at risk on an already short panel is not stated twice", () => {
  const kept = applyInhibition([
    item("panel_seat_empty", ["panel:p1"], { severity: "critical" }),
    item("seat_at_risk", ["panel:p1", "person:x"]),
  ]);
  assert.deepEqual(
    kept.map((row) => row.detectorKey),
    ["panel_seat_empty"],
  );
});

test("a team below the round minimum explains its own long wait", () => {
  const kept = applyInhibition([
    item("team_below_minimum", ["team:t1", "panel:p1"]),
    item("team_waiting_long", ["team:t1", "panel:p1"], { severity: "watch" }),
  ]);
  assert.deepEqual(
    kept.map((row) => row.detectorKey),
    ["team_below_minimum"],
  );
});

test("inhibition never removes the item that causes it", () => {
  const kept = applyInhibition([
    item("panel_bottleneck", ["panel:p1", "round:r1"]),
    item("panel_seat_empty", ["panel:p1"], { severity: "critical" }),
  ]);
  assert.deepEqual(
    kept.map((row) => row.detectorKey),
    ["panel_seat_empty"],
  );
});

test("an uninhibited board keeps every row", () => {
  const rows = [
    item("review_overdue", ["team:t1", "panel:p1"], { severity: "critical" }),
    item("team_held", ["team:t2"]),
    item("scorecard_outstanding", ["review:s1"], { severity: "watch" }),
  ];
  assert.equal(applyInhibition(rows).length, 3);
});

test("rows sort worst first, then the oldest", () => {
  const sorted = sortAttentionItems([
    { severity: "watch" as AttentionSeverity, firstObservedAt: now, subjectId: "c" },
    { severity: "critical" as AttentionSeverity, firstObservedAt: now, subjectId: "a" },
    { severity: "critical" as AttentionSeverity, firstObservedAt: now - minute, subjectId: "b" },
  ]);
  assert.deepEqual(
    sorted.map((row) => row.subjectId),
    ["b", "a", "c"],
  );
});

test("durations read the way an operator says them", () => {
  assert.equal(durationPhrase(0), "0s");
  assert.equal(durationPhrase(45_000), "45s");
  assert.equal(durationPhrase(9 * minute + 40_000), "9m40s");
  assert.equal(durationPhrase(12 * minute), "12m");
  assert.equal(durationPhrase(90 * minute), "1h30m");
  assert.equal(durationPhrase(2 * 60 * minute), "2h");
  assert.equal(durationPhrase(-5_000), "0s");
});

test("counts and names read as sentences", () => {
  assert.equal(countPhrase(1, "team", "teams"), "one team");
  assert.equal(countPhrase(4, "team", "teams"), "4 teams");
  assert.equal(joinNames(["Asha"]), "Asha");
  assert.equal(joinNames(["Asha", "Ben"]), "Asha and Ben");
  assert.equal(joinNames(["Asha", "Ben", "Cal"]), "Asha, Ben and Cal");
});
