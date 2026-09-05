import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";

type CloseEntry = Pick<Doc<"roundCloseEntries">, "teamId" | "payload">;
type CompletedSession = Pick<Doc<"reviewSessions">, "_id" | "teamId" | "status">;
type Evaluation = Pick<
  Doc<"reviewEvaluations">,
  "_id" | "reviewSessionId" | "state" | "inputChecksum" | "criterionResults" | "totalPoints"
>;
type Exclusion = Pick<
  Doc<"scorecardCorrectionCases">,
  "_id" | "reviewSessionId" | "kind" | "state" | "voidDisposition" | "requestedAt" | "category"
>;

export function buildRoundCloseEntries(args: {
  states: readonly Pick<Doc<"teamRoundStates">, "teamId" | "state" | "skipReason">[];
  sessions: readonly CompletedSession[];
  evaluations: readonly Evaluation[];
  cases: readonly Exclusion[];
}): CloseEntry[] {
  const completedByTeam = new Map<Id<"teams">, CompletedSession[]>();
  for (const session of args.sessions) {
    if (session.status !== "completed") continue;
    const completed = completedByTeam.get(session.teamId);
    if (completed) completed.push(session);
    else completedByTeam.set(session.teamId, [session]);
  }

  const completeBySession = new Map<Id<"reviewSessions">, Evaluation>();
  const voidSessions = new Set<Id<"reviewSessions">>();
  for (const evaluation of args.evaluations) {
    if (evaluation.state === "complete" && !completeBySession.has(evaluation.reviewSessionId)) {
      completeBySession.set(evaluation.reviewSessionId, evaluation);
    } else if (evaluation.state === "void") {
      voidSessions.add(evaluation.reviewSessionId);
    }
  }

  const exclusionBySession = new Map<Id<"reviewSessions">, Exclusion>();
  for (const correctionCase of args.cases) {
    if (
      correctionCase.kind !== "void" ||
      correctionCase.state !== "closed" ||
      correctionCase.voidDisposition !== "exclude"
    ) continue;
    const previous = exclusionBySession.get(correctionCase.reviewSessionId);
    // Keep the first case on equal timestamps, matching the stable descending sort.
    if (!previous || correctionCase.requestedAt > previous.requestedAt) {
      exclusionBySession.set(correctionCase.reviewSessionId, correctionCase);
    }
  }

  const entries: CloseEntry[] = [];
  for (const state of args.states) {
    if (state.state === "skipped") {
      if (!state.skipReason) throw new Error("A skipped review must have a reason.");
      entries.push({ teamId: state.teamId, payload: { kind: "skipped", reason: state.skipReason } });
      continue;
    }
    if (state.state === "withdrawn") {
      entries.push({ teamId: state.teamId, payload: { kind: "withdrawn" } });
      continue;
    }
    const teamSessions = completedByTeam.get(state.teamId) ?? [];
    const valid = teamSessions.flatMap((session) => {
      const evaluation = completeBySession.get(session._id);
      return evaluation ? [{ session, evaluation }] : [];
    });
    if (valid.length > 1) {
      throw new ConvexError({
        code: "DUPLICATE_VALID_RESULTS",
        message: "A team has more than one valid completed result. Void the duplicate explicitly.",
      });
    }
    const result = valid[0];
    if (result) {
      entries.push({
        teamId: state.teamId,
        payload: {
          kind: "result",
          reviewSessionId: result.session._id,
          evaluationId: result.evaluation._id,
          evaluationInputChecksum: result.evaluation.inputChecksum,
          criterionResults: result.evaluation.criterionResults.map((criterion) => ({
            criterionId: criterion.criterionId,
            scoreCount: criterion.scoreCount,
            scoreSum: criterion.scoreSum,
            meanScore: criterion.meanScore,
            weightedPoints: criterion.weightedPoints,
            spreadFlag: criterion.spreadFlag,
          })),
          totalPoints: result.evaluation.totalPoints,
        },
      });
      continue;
    }
    const excluded = teamSessions.flatMap((session) => {
      if (!voidSessions.has(session._id)) return [];
      const voidCase = exclusionBySession.get(session._id);
      return voidCase ? [{ session, voidCase }] : [];
    });
    if (excluded.length !== 1) {
      throw new ConvexError({
        code: "TEAM_RESULT_INCOMPLETE",
        message: "A completed team needs one valid result or one approved exclusion.",
      });
    }
    const excludedResult = excluded[0];
    if (!excludedResult) throw new Error("Validated exclusion is missing.");
    entries.push({
      teamId: state.teamId,
      payload: {
        kind: "excluded",
        reviewSessionId: excludedResult.session._id,
        correctionCaseId: excludedResult.voidCase._id,
        category: excludedResult.voidCase.category,
      },
    });
  }
  return entries.sort((left, right) => String(left.teamId).localeCompare(String(right.teamId)));
}
