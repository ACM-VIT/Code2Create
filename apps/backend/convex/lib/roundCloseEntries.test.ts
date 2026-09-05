import assert from "node:assert/strict";
import test from "node:test";

import type { Id } from "../_generated/dataModel";
import { buildRoundCloseEntries } from "./roundCloseEntries.ts";

type CloseInput = Parameters<typeof buildRoundCloseEntries>[0];
type Session = CloseInput["sessions"][number];
type Evaluation = CloseInput["evaluations"][number];
type Exclusion = CloseInput["cases"][number];

function session(name: string, team = name): Session {
  return {
    _id: `session-${name}` as Id<"reviewSessions">,
    teamId: `team-${team}` as Id<"teams">,
    status: "completed",
  };
}

function evaluation(review: Session, state: Evaluation["state"] = "complete"): Evaluation {
  return {
    _id: `evaluation-${review._id}` as Id<"reviewEvaluations">,
    reviewSessionId: review._id,
    state,
    inputChecksum: `checksum-${review._id}`,
    criterionResults: [{
      criterionId: "criterion-originality" as Id<"reviewRubricCriteria">,
      inputScorecardVersionIds: ["version-1" as Id<"scorecardVersions">],
      scoreCount: 3,
      scoreSum: 23,
      meanScore: 23 / 3,
      weightedPoints: 23 / 6,
      spreadFlag: true,
    }],
    totalPoints: 23 / 6,
  };
}

function exclusion(review: Session, name: string, requestedAt: number): Exclusion {
  return {
    _id: `case-${name}` as Id<"scorecardCorrectionCases">,
    reviewSessionId: review._id,
    kind: "void",
    state: "closed",
    voidDisposition: "exclude",
    requestedAt,
    category: "other",
  };
}

test("close entries preserve sorted outcomes, exact scores, checksums, and input data", () => {
  const a = session("a");
  const b = session("b");
  const c = session("c");
  const input: CloseInput = {
    states: [
      { teamId: c.teamId, state: "withdrawn" },
      { teamId: b.teamId, state: "completed" },
      { teamId: a.teamId, state: "completed" },
    ],
    sessions: [b, c, a],
    evaluations: [evaluation(b, "void"), evaluation(a), evaluation(c)],
    cases: [exclusion(b, "b", 100)],
  };
  const original = structuredClone(input);
  assert.deepEqual(buildRoundCloseEntries(input), [
    {
      teamId: a.teamId,
      payload: {
        kind: "result",
        reviewSessionId: a._id,
        evaluationId: "evaluation-session-a",
        evaluationInputChecksum: "checksum-session-a",
        criterionResults: [{
          criterionId: "criterion-originality",
          scoreCount: 3,
          scoreSum: 23,
          meanScore: 23 / 3,
          weightedPoints: 23 / 6,
          spreadFlag: true,
        }],
        totalPoints: 23 / 6,
      },
    },
    {
      teamId: b.teamId,
      payload: { kind: "excluded", reviewSessionId: b._id, correctionCaseId: "case-b", category: "other" },
    },
    { teamId: c.teamId, payload: { kind: "withdrawn" } },
  ]);
  assert.deepEqual(input, original);
});

test("a replacement result takes precedence over a previous exclusion", () => {
  const original = session("original", "a");
  const replacement = session("replacement", "a");
  const entries = buildRoundCloseEntries({
    states: [{ teamId: original.teamId, state: "completed" }],
    sessions: [original, replacement],
    evaluations: [evaluation(original, "void"), evaluation(replacement)],
    cases: [exclusion(original, "old", 100)],
  });
  assert.equal(entries[0]?.payload.kind, "result");
  assert.equal(entries[0]?.payload.kind === "result" && entries[0].payload.reviewSessionId, replacement._id);
});

test("exclusions select the latest approved case and keep the first equal-time case", () => {
  const review = session("a");
  const entries = buildRoundCloseEntries({
    states: [{ teamId: review.teamId, state: "completed" }],
    sessions: [review],
    evaluations: [evaluation(review, "void")],
    cases: [
      exclusion(review, "old", 100),
      exclusion(review, "new", 200),
      exclusion(review, "same-time", 200),
      { ...exclusion(review, "open", 300), state: "open" },
      { ...exclusion(review, "replacement", 400), voidDisposition: "replacement_review" },
      { ...exclusion(review, "correction", 500), kind: "correction" },
      exclusion(session("another"), "unrelated", 600),
    ],
  });
  assert.deepEqual(entries, [{
    teamId: review.teamId,
    payload: { kind: "excluded", reviewSessionId: review._id, correctionCaseId: "case-new", category: "other" },
  }]);
});

test("duplicate valid results and multiple exclusions still block closing", () => {
  const first = session("first", "a");
  const second = session("second", "a");
  const base = {
    states: [{ teamId: first.teamId, state: "completed" as const }],
    sessions: [first, second],
    cases: [exclusion(first, "first", 100), exclusion(second, "second", 200)],
  };
  assert.throws(
    () => buildRoundCloseEntries({ ...base, evaluations: [evaluation(first), evaluation(second)] }),
    /DUPLICATE_VALID_RESULTS/,
  );
  assert.throws(
    () => buildRoundCloseEntries({ ...base, evaluations: [evaluation(first, "void"), evaluation(second, "void")] }),
    /TEAM_RESULT_INCOMPLETE/,
  );
  assert.deepEqual(buildRoundCloseEntries({
    ...base,
    states: [{ teamId: first.teamId, state: "withdrawn" }],
    evaluations: [evaluation(first), evaluation(second)],
  }), [{ teamId: first.teamId, payload: { kind: "withdrawn" } }]);
});

test("missing, voided, and unfinished results cannot become completed results", () => {
  const review = session("a");
  const base = { states: [{ teamId: review.teamId, state: "completed" as const }], cases: [] };
  const incomplete: CloseInput[] = [
    { ...base, sessions: [review], evaluations: [] },
    { ...base, sessions: [review], evaluations: [evaluation(review, "void")] },
    { ...base, sessions: [{ ...review, status: "scoring" }], evaluations: [evaluation(review)] },
    { ...base, sessions: [], evaluations: [evaluation(review)] },
  ];
  for (const input of incomplete) {
    assert.throws(() => buildRoundCloseEntries(input), /TEAM_RESULT_INCOMPLETE/);
  }
});

test("assembling a full round reads evaluation keys a linear number of times", () => {
  const sessions = Array.from({ length: 400 }, (_, index) => session(String(index)));
  let evaluationKeyReads = 0;
  const evaluations = sessions.map((review) => ({
    ...evaluation(review),
    get reviewSessionId() {
      evaluationKeyReads += 1;
      return review._id;
    },
  }));
  const entries = buildRoundCloseEntries({
    states: sessions.map((review) => ({ teamId: review.teamId, state: "completed" })),
    sessions,
    evaluations,
    cases: [],
  });
  assert.equal(entries.length, sessions.length);
  assert.ok(evaluationKeyReads <= evaluations.length * 3);
});
