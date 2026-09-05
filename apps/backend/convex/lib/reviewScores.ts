import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { operationFingerprint } from "./operations";
import { normalizedText } from "./strings";

export function requireFinalComment(
  value: string | undefined,
  required: boolean,
) {
  const comment = value?.trim();
  if (required && (!comment || comment.length < 3)) {
    throw new ConvexError({
      code: "FINAL_COMMENT_REQUIRED",
      message: "Leave a final comment about the review before submitting.",
    });
  }
  return comment
    ? normalizedText(comment, "Final comment", required ? 3 : 1, 2_000)
    : undefined;
}

export function cleanAssignedRatings(
  ratings: Array<{
    criterionId: Id<"reviewRubricCriteria">;
    score: number;
    evidenceNote?: string;
  }>,
  assignedCriterionIds: Id<"reviewRubricCriteria">[],
  scoreMinimum: number,
  scoreMaximum: number,
) {
  const byCriterion = new Map<
    Id<"reviewRubricCriteria">,
    { criterionId: Id<"reviewRubricCriteria">; score: number; evidenceNote?: string;
    }
  >();
  const assigned = new Set(assignedCriterionIds);
  for (const rating of ratings) {
    if (
      !assigned.has(rating.criterionId) ||
      byCriterion.has(rating.criterionId) ||
      !Number.isInteger(rating.score) ||
      rating.score < scoreMinimum ||
      rating.score > scoreMaximum
    ) {
      throw new ConvexError({
        code: "INVALID_SCORECARD_RATING",
        message: `A rating is duplicated, unassigned, or outside the published ${scoreMinimum}–${scoreMaximum} scale.`,
      });
    }
    const note = rating.evidenceNote?.trim();
    byCriterion.set(rating.criterionId, {
      criterionId: rating.criterionId,
      score: rating.score,
      ...(note ? { evidenceNote: normalizedText(note, "Evidence note", 1, 1_000) } : {}),
    });
  }
  return assignedCriterionIds.flatMap((criterionId) => {
    const rating = byCriterion.get(criterionId);
    return rating ? [rating] : [];
  });
}

export function requireCompleteAssignedRatings(
  ratings: ReturnType<typeof cleanAssignedRatings>,
  assignedCriterionIds: Id<"reviewRubricCriteria">[],
  scoreMinimum: number,
  scoreMaximum: number,
) {
  if (ratings.length !== assignedCriterionIds.length) {
    throw new ConvexError({
      code: "SCORECARD_INCOMPLETE",
      message: "Rate every assigned criterion before submitting.",
    });
  }
  for (const rating of ratings) {
    if (
      (rating.score === scoreMinimum || rating.score === scoreMaximum) &&
      (!rating.evidenceNote || rating.evidenceNote.trim().length < 3)
    ) {
      throw new ConvexError({
        code: "EXTREME_SCORE_EXPLANATION_REQUIRED",
        message: `A score of ${scoreMinimum} or ${scoreMaximum} needs a short evidence note.`,
      });
    }
  }
  return ratings;
}

export type ComputedReviewEvaluation = {
  criterionResults: Array<{
    criterionId: Id<"reviewRubricCriteria">;
    inputScorecardVersionIds: Array<Id<"scorecardVersions">>;
    scoreCount: number;
    scoreSum: number;
    meanScore: number;
    weightedPoints: number;
    spreadFlag: boolean;
  }>;
  totalPoints: number;
  inputChecksum: string;
  submittedScorecardCount: number;
};

export function activeAssignmentScorecards(
  assignments: Doc<"reviewAssignments">[],
  scorecards: Doc<"scorecards">[],
) {
  const activeAssignments = assignments.filter((assignment) => assignment.status === "assigned");
  const activeAssignmentById = new Map(
    activeAssignments.map((assignment) => [assignment._id, assignment]),
  );
  const scorecardByAssignmentId = new Map<
    Id<"reviewAssignments">,
    Doc<"scorecards">
  >();
  for (const scorecard of scorecards) {
    const assignment = activeAssignmentById.get(scorecard.assignmentId);
    if (!assignment) continue;
    if (
      scorecardByAssignmentId.has(assignment._id) ||
      scorecard.reviewerPersonId !== assignment.reviewerPersonId
    ) {
      throw new Error("An active review assignment has inconsistent scorecards.");
    }
    scorecardByAssignmentId.set(assignment._id, scorecard);
  }
  return {
    assignments: activeAssignments,
    scorecards: activeAssignments.flatMap((assignment) => {
      const scorecard = scorecardByAssignmentId.get(assignment._id);
      return scorecard ? [scorecard] : [];
    }),
  };
}

export async function computeReviewEvaluation(
  ctx: MutationCtx,
  args: {
    round: Doc<"reviewRounds">;
    session: Doc<"reviewSessions">;
    rubric: Doc<"reviewRubricVersions">;
  },
): Promise<ComputedReviewEvaluation> {
  const [assignments, scorecards, criteria] = await Promise.all([
    ctx.db
      .query("reviewAssignments")
      .withIndex("by_session_person", (index) => index.eq("reviewSessionId", args.session._id),
      )
      .collect(),
    ctx.db
      .query("scorecards")
      .withIndex("by_session_status", (index) => index.eq("reviewSessionId", args.session._id),
      )
      .collect(),
    ctx.db
      .query("reviewRubricCriteria")
      .withIndex("by_rubric_order", (index) => index.eq("rubricVersionId", args.rubric._id),
      )
      .collect(),
  ]);
  const active = activeAssignmentScorecards(assignments, scorecards);
  if (
    active.assignments.length !== args.round.requiredPanelSize ||
    active.scorecards.length !== active.assignments.length ||
    active.scorecards.some(
      (scorecard) => scorecard.status !== "submitted" || !scorecard.submittedVersionId,
    )
  ) {
    throw new ConvexError({
      code: "SCORECARDS_INCOMPLETE",
      message: "Every assigned reviewer must submit a valid scorecard first.",
    });
  }

  const submittedVersions: Array<Doc<"scorecardVersions">> = [];
  for (const scorecard of active.scorecards) {
    const versionId = scorecard.submittedVersionId;
    if (!versionId) throw new Error("Validated submitted scorecard has no immutable version.",
      );
    const submitted = await ctx.db.get(versionId);
    if (
      !submitted ||
      submitted.reviewSessionId !== args.session._id ||
      submitted.scorecardId !== scorecard._id ||
      submitted.rubricVersionId !== args.rubric._id
    ) {
      throw new Error("Submitted scorecard version does not match its fixed review context.",
      );
    }
    requireFinalComment(
      submitted.finalComment,
      args.round.requiresFinalComment,
    );
    submittedVersions.push(submitted);
  }

  const criterionResults = criteria.map((criterion) => {
    const inputs = submittedVersions.flatMap((scorecardVersion) =>
      scorecardVersion.ratings
        .filter((rating) => rating.criterionId === criterion._id)
        .map((rating) => ({
          scorecardVersionId: scorecardVersion._id,
          score: rating.score,
        })),
    );
    if (inputs.length < args.round.minimumScorersPerCriterion) {
      throw new ConvexError({
        code: "CRITERION_COVERAGE_INCOMPLETE",
        message: `${criterion.label} does not have the required independent scores.`,
      });
    }
    const scores = inputs.map((input) => input.score);
    const scoreSum = scores.reduce((total, score) => total + score, 0);
    const meanScore = scoreSum / scores.length;
    return {
      criterionId: criterion._id,
      inputScorecardVersionIds: inputs.map((input) => input.scorecardVersionId),
      scoreCount: scores.length,
      scoreSum,
      meanScore,
      weightedPoints: (meanScore / args.rubric.scoreMaximum) * criterion.weight,
      spreadFlag: Math.max(...scores) - Math.min(...scores) >= args.rubric.spreadThreshold,
    };
  });
  const totalPoints = criterionResults.reduce(
    (total, criterion) => total + criterion.weightedPoints,
    0,
  );
  const inputChecksum = operationFingerprint([
    args.session._id,
    args.round.configurationChecksum,
    args.rubric.checksum,
    JSON.stringify(
      submittedVersions.map((scorecardVersion) => ({
        id: scorecardVersion._id,
        checksum: scorecardVersion.checksum,
      })),
    ),
  ]);
  return {
    criterionResults,
    totalPoints,
    inputChecksum,
    submittedScorecardCount: submittedVersions.length,
  };
}

export async function recomputeReviewEvaluation(
  ctx: MutationCtx,
  args: {
    round: Doc<"reviewRounds">;
    session: Doc<"reviewSessions">;
    rubric: Doc<"reviewRubricVersions">;
    evaluation: Doc<"reviewEvaluations">;
    computedAt: number;
  },
) {
  const computed = await computeReviewEvaluation(ctx, {
    round: args.round,
    session: args.session,
    rubric: args.rubric,
  });
  await ctx.db.patch(args.evaluation._id, {
    criterionResults: computed.criterionResults,
    totalPoints: computed.totalPoints,
    state: "complete",
    inputChecksum: computed.inputChecksum,
    invalidatedAt: undefined,
    invalidatedByPersonId: undefined,
    invalidationReason: undefined,
    version: args.evaluation.version + 1,
    computedAt: args.computedAt,
  });
  return computed;
}
