import assert from "node:assert/strict";
import test from "node:test";
import {
  selectAdmissionShortlist,
  shortlistProfileSchema,
  type ShortlistCandidate,
  type ShortlistTask,
} from "@code2create/domain";
import { shortlistAuditCacheKey } from "./shortlistAuditCache.ts";

const profile = shortlistProfileSchema.parse({
  user: "Students",
  problem: "Missed pickups",
  workflow: "Report and collect",
  mechanism: "Assign from location",
  deliverable: "A working dispatch",
  distinction: "Offline acknowledgement",
  domain: "civic",
  aiRole: "none",
  sourceRefs: ["initial_idea"],
  premise: {
    assessment: "supported",
    explanation: "Location supports dispatch",
    sourceRefs: ["initial_idea"],
  },
  category: {
    datingOrRomanticMatchmaking: false,
    explanation: "Collection tool",
    sourceRefs: ["initial_idea"],
  },
  criteria: [
    {
      criterionKey: "clarity",
      evidence: "adequate",
      sourceRefs: ["initial_idea"],
    },
  ],
});
function candidate(applicationId: string): ShortlistCandidate {
  return {
    applicationId,
    teamSize: 4,
    experienceBand: "first_year",
    quality: "accept",
    profile,
    sources: [],
    criteria: [],
  };
}
function task(
  rows: ShortlistCandidate[],
): Extract<ShortlistTask, { kind: "audit" }> {
  const suggestions = selectAdmissionShortlist(rows, [], {
    acceptPeople: 4,
    waitlistPeople: 4,
    remainingCapacity: 4,
    tolerance: 0,
  });
  return {
    kind: "audit",
    candidates: suggestions.flatMap((s) => {
      const p = rows.find((c) => c.applicationId === s.applicationId)?.profile;
      return p
        ? [
            {
              applicationId: s.applicationId,
              suggestion: s.suggestion,
              profile: p,
            },
          ]
        : [];
    }),
  };
}
test("recovering a failed profile invalidates the prior audit slice", () => {
  const before = task([
    { ...candidate("a"), profile: null },
    candidate("b"),
    candidate("c"),
  ]);
  const after = task([candidate("a"), candidate("b"), candidate("c")]);
  assert.equal(
    before.candidates.find((c) => c.applicationId === "b")?.suggestion,
    "accept",
  );
  assert.equal(
    after.candidates.find((c) => c.applicationId === "b")?.suggestion,
    "waitlist",
  );
  assert.equal(
    after.candidates.find((c) => c.applicationId === "a")?.suggestion,
    "accept",
  );
  const cache = new Map([
    [
      shortlistAuditCacheKey(before),
      {
        warnings: [{ applicationIds: ["b"], explanation: "Check acceptance" }],
      },
    ],
  ]);
  assert.equal(cache.has(shortlistAuditCacheKey(after)), false);
  assert.equal(
    cache.has(shortlistAuditCacheKey(structuredClone(before))),
    true,
  );
});
test("audit cache identity includes every candidate identity, suggestion, profile and order", () => {
  const original = task([candidate("a"), candidate("b")]);
  for (const change of [
    "identity",
    "suggestion",
    "profile",
    "order",
  ] as const) {
    const updated = structuredClone(original);
    const first = updated.candidates[0];
    if (!first) throw new Error("Missing audit row");
    if (change === "identity") first.applicationId = "other";
    if (change === "suggestion") first.suggestion = "reject";
    if (change === "profile")
      first.profile.deliverable = "A materially different demo";
    if (change === "order") updated.candidates.reverse();
    assert.notEqual(
      shortlistAuditCacheKey(updated),
      shortlistAuditCacheKey(original),
      change,
    );
  }
});
