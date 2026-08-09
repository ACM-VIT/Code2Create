import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import {
  reviewEvaluationState,
  reviewRoundStatus,
  reviewSessionStatus,
  roundExportState,
  scorecardCorrectionCategory,
  scorecardCorrectionKind,
  scorecardCorrectionState,
  scorecardStatus,
} from "./values";

type ReadCtx = QueryCtx | MutationCtx;
type ScorecardAdministrationPermission =
  | "scorecard.correction.open"
  | "scorecard.void";

const correctionCategory = v.union(
  v.literal("reviewer_error"),
  v.literal("technical_error"),
  v.literal("wrong_team"),
  v.literal("duplicate_review"),
  v.literal("confirmed_conflict"),
  v.literal("judge_ineligible"),
  v.literal("other"),
);

const roundSummary = v.object({
  id: v.id("reviewRounds"),
  name: v.string(),
  sequence: v.number(),
  status: reviewRoundStatus,
  startsAt: v.number(),
  endsAt: v.number(),
  version: v.number(),
  completedReviewCount: v.number(),
  unresolvedTeamCount: v.number(),
  unresolvedCorrectionCount: v.number(),
  exportState: v.optional(v.string()),
  exportRevision: v.optional(v.number()),
  releasedAt: v.optional(v.number()),
  canReadValues: v.boolean(),
  canStartClose: v.boolean(),
  canRelease: v.boolean(),
});

function unresolvedCorrection(state: Doc<"scorecardCorrectionCases">["state"]) {
  return state === "requested" || state === "open";
}

async function requireRound(
  ctx: ReadCtx,
  eventId: Id<"events">,
  roundId: Id<"reviewRounds">,
) {
  const round = await ctx.db.get(roundId);
  if (!round || round.eventId !== eventId) {
    throw new ConvexError({ code: "ROUND_NOT_FOUND", message: "That review round is unavailable." });
  }
  return round;
}

async function scorecardAdministrationPermission(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: ScorecardAdministrationPermission;
    scorecardId: Id<"scorecards">;
    reviewSessionId: Id<"reviewSessions">;
  },
) {
  const scorecardGrantIds = await matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: args.permissionKey,
    scopeType: "scorecard",
    scopeId: args.scorecardId,
  });
  if (scorecardGrantIds.length > 0) {
    return {
      grantIds: scorecardGrantIds,
      scopeType: "scorecard" as const,
      scopeId: args.scorecardId,
    };
  }
  const reviewGrantIds = await matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: args.permissionKey,
    scopeType: "review",
    scopeId: args.reviewSessionId,
  });
  if (reviewGrantIds.length === 0) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "This account does not have permission for that exact scorecard or review.",
    });
  }
  return {
    grantIds: reviewGrantIds,
    scopeType: "review" as const,
    scopeId: args.reviewSessionId,
  };
}

async function activeGrants(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: ScorecardAdministrationPermission;
  },
) {
  const now = Date.now();
  const grants = await ctx.db
    .query("permissionGrants")
    .withIndex("by_subject_permission_status", (index) =>
      index
        .eq("eventAccessSubjectId", args.eventAccessSubjectId)
        .eq("permissionKey", args.permissionKey)
        .eq("status", "active"),
    )
    .collect();
  return grants.filter(
    (grant) =>
      grant.eventId === args.eventId &&
      grant.validFrom <= now &&
      (grant.validUntil === undefined || grant.validUntil > now),
  );
}

function grantAllowsScorecard(
  grants: Array<Doc<"permissionGrants">>,
  scorecardId: Id<"scorecards">,
  reviewSessionId: Id<"reviewSessions">,
) {
  return grants.some(
    (grant) =>
      grant.scopeType === "event" ||
      (grant.scopeType === "scorecard" && grant.scopeId === scorecardId) ||
      (grant.scopeType === "review" && grant.scopeId === reviewSessionId),
  );
}

async function currentTeam(
  ctx: ReadCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
) {
  const membership = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", eventId).eq("personId", personId),
    )
    .unique();
  if (!membership) return null;
  const teamMember = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", eventId)
        .eq("membershipId", membership._id)
        .eq("status", "active"),
    )
    .unique();
  if (!teamMember) return null;
  const team = await ctx.db.get(teamMember.teamId);
  return team && team.eventId === eventId ? team : null;
}

export const rounds = query({
  args: { eventSlug: v.string() },
  returns: v.array(roundSummary),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const allRounds = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id))
      .collect();
    const rows: Array<{
      id: Id<"reviewRounds">;
      name: string;
      sequence: number;
      status: Doc<"reviewRounds">["status"];
      startsAt: number;
      endsAt: number;
      version: number;
      completedReviewCount: number;
      unresolvedTeamCount: number;
      unresolvedCorrectionCount: number;
      exportState?: string;
      exportRevision?: number;
      releasedAt?: number;
      canReadValues: boolean;
      canStartClose: boolean;
      canRelease: boolean;
    }> = [];
    for (const round of allRounds.sort((left, right) => left.sequence - right.sequence)) {
      const readGrantIds = await matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "score.completeness.read",
        scopeType: "round",
        scopeId: round._id,
      });
      if (readGrantIds.length === 0) continue;
      const [evaluations, states, cases, exportRecord, release, valueGrants, closeGrants, releaseGrants] =
        await Promise.all([
          ctx.db
            .query("reviewEvaluations")
            .withIndex("by_round_state", (index) => index.eq("roundId", round._id))
            .collect(),
          ctx.db
            .query("teamRoundStates")
            .withIndex("by_round_state_priority_queued", (index) =>
              index.eq("roundId", round._id),
            )
            .collect(),
          ctx.db
            .query("scorecardCorrectionCases")
            .withIndex("by_round_state", (index) => index.eq("roundId", round._id))
            .collect(),
          round.activeRoundExportId
            ? ctx.db.get(round.activeRoundExportId)
            : Promise.resolve(null),
          ctx.db
            .query("scoreReleaseVersions")
            .withIndex("by_round", (index) => index.eq("roundId", round._id))
            .unique(),
          matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "score.values.read",
            scopeType: "round",
            scopeId: round._id,
          }),
          matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "round.close",
            scopeType: "round",
            scopeId: round._id,
          }),
          matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "score.release",
            scopeType: "round",
            scopeId: round._id,
          }),
        ]);
      rows.push({
        id: round._id,
        name: round.name,
        sequence: round.sequence,
        status: round.status,
        startsAt: round.startsAt,
        endsAt: round.endsAt,
        version: round.version,
        completedReviewCount: evaluations.filter((evaluation) => evaluation.state === "complete")
          .length,
        unresolvedTeamCount: states.filter(
          (state) => !["completed", "withdrawn"].includes(state.state),
        ).length,
        unresolvedCorrectionCount: cases.filter((correctionCase) =>
          unresolvedCorrection(correctionCase.state),
        ).length,
        ...(exportRecord
          ? { exportState: exportRecord.state, exportRevision: exportRecord.revision }
          : {}),
        ...(release ? { releasedAt: release.publishedAt } : {}),
        canReadValues: valueGrants.length > 0,
        canStartClose: closeGrants.length > 0,
        canRelease: releaseGrants.length > 0,
      });
    }
    return rows;
  },
});

const completenessCase = v.object({
  id: v.id("scorecardCorrectionCases"),
  kind: scorecardCorrectionKind,
  category: scorecardCorrectionCategory,
  state: scorecardCorrectionState,
  reason: v.string(),
  requestedAt: v.number(),
  version: v.number(),
});

export const completeness = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.object({
    round: v.object({
      id: v.id("reviewRounds"),
      name: v.string(),
      status: reviewRoundStatus,
      version: v.number(),
      minimumScorersPerCriterion: v.number(),
    }),
    criteria: v.array(
      v.object({ id: v.id("reviewRubricCriteria"), label: v.string(), displayOrder: v.number() }),
    ),
    reviews: v.array(
      v.object({
        id: v.id("reviewSessions"),
        teamId: v.id("teams"),
        teamName: v.string(),
        panelName: v.string(),
        tableLabel: v.string(),
        status: reviewSessionStatus,
        evaluationState: v.optional(reviewEvaluationState),
        evaluationVersion: v.optional(v.number()),
        manualReviewRecordId: v.optional(v.id("manualReviewRecords")),
        coverage: v.array(
          v.object({
            criterionId: v.id("reviewRubricCriteria"),
            submittedCount: v.number(),
            requiredCount: v.number(),
            spreadFlag: v.boolean(),
          }),
        ),
        scorecards: v.array(
          v.object({
            id: v.id("scorecards"),
            reviewerName: v.string(),
            status: scorecardStatus,
            version: v.number(),
            submittedAt: v.optional(v.number()),
            currentCase: v.optional(completenessCase),
            canOpenCorrection: v.boolean(),
            canVoid: v.boolean(),
          }),
        ),
        cases: v.array(completenessCase),
      }),
    ),
    unresolvedTeamCount: v.number(),
    pendingManualReviewCount: v.number(),
    canReadValues: v.boolean(),
    canStartClose: v.boolean(),
    canRelease: v.boolean(),
    exportState: v.optional(roundExportState),
    exportRevision: v.optional(v.number()),
    releasedAt: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const round = await requireRound(ctx, event._id, args.roundId);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "score.completeness.read",
      scopeType: "round",
      scopeId: round._id,
    });
    const [criteria, sessions, states, manualRecords, openGrants, voidGrants, valueGrants, closeGrants, releaseGrants, exportRecord, release] =
      await Promise.all([
        ctx.db
          .query("reviewRubricCriteria")
          .withIndex("by_rubric_order", (index) =>
            index.eq("rubricVersionId", round.rubricVersionId),
          )
          .collect(),
        ctx.db
          .query("reviewSessions")
          .withIndex("by_round_team_status", (index) => index.eq("roundId", round._id))
          .collect(),
        ctx.db
          .query("teamRoundStates")
          .withIndex("by_round_state_priority_queued", (index) => index.eq("roundId", round._id))
          .collect(),
        ctx.db
          .query("manualReviewRecords")
          .withIndex("by_round_status_created", (index) => index.eq("roundId", round._id))
          .collect(),
        activeGrants(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "scorecard.correction.open",
        }),
        activeGrants(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "scorecard.void",
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "score.values.read",
          scopeType: "round",
          scopeId: round._id,
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "round.close",
          scopeType: "round",
          scopeId: round._id,
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "score.release",
          scopeType: "round",
          scopeId: round._id,
        }),
        round.activeRoundExportId
          ? ctx.db.get(round.activeRoundExportId)
          : Promise.resolve(null),
        ctx.db
          .query("scoreReleaseVersions")
          .withIndex("by_round", (index) => index.eq("roundId", round._id))
          .unique(),
      ]);
    const reviewRows = [];
    for (const session of sessions.sort((left, right) => left.createdAt - right.createdAt)) {
      const [team, panel, scorecards, evaluation, cases] = await Promise.all([
        ctx.db.get(session.teamId),
        ctx.db.get(session.panelId),
        ctx.db
          .query("scorecards")
          .withIndex("by_session_status", (index) =>
            index.eq("reviewSessionId", session._id),
          )
          .collect(),
        ctx.db
          .query("reviewEvaluations")
          .withIndex("by_session", (index) => index.eq("reviewSessionId", session._id))
          .unique(),
        ctx.db
          .query("scorecardCorrectionCases")
          .withIndex("by_session_kind", (index) =>
            index.eq("reviewSessionId", session._id),
          )
          .collect(),
      ]);
      if (!team || !panel) throw new Error("A review references a missing team or panel.");
      const scorecardRows = [];
      for (const scorecard of scorecards) {
        const reviewer = await ctx.db.get(scorecard.reviewerPersonId);
        if (!reviewer) throw new Error("A scorecard references a missing reviewer.");
        const currentCase = cases.find(
          (correctionCase) =>
            correctionCase.scorecardId === scorecard._id &&
            unresolvedCorrection(correctionCase.state),
        );
        scorecardRows.push({
          id: scorecard._id,
          reviewerName: reviewer.displayName,
          status: scorecard.status,
          version: scorecard.version,
          ...(scorecard.submittedAt !== undefined ? { submittedAt: scorecard.submittedAt } : {}),
          ...(currentCase
            ? {
                currentCase: {
                  id: currentCase._id,
                  kind: currentCase.kind,
                  category: currentCase.category,
                  state: currentCase.state,
                  reason: currentCase.reason,
                  requestedAt: currentCase.requestedAt,
                  version: currentCase.version,
                },
              }
            : {}),
          canOpenCorrection: grantAllowsScorecard(
            openGrants,
            scorecard._id,
            session._id,
          ),
          canVoid: grantAllowsScorecard(voidGrants, scorecard._id, session._id),
        });
      }
      const submittedVersions: Array<Doc<"scorecardVersions">> = [];
      for (const scorecard of scorecards) {
        if (!scorecard.submittedVersionId || scorecard.status !== "submitted") continue;
        const version = await ctx.db.get(scorecard.submittedVersionId);
        if (version) submittedVersions.push(version);
      }
      reviewRows.push({
        id: session._id,
        teamId: team._id,
        teamName: team.name,
        panelName: panel.name,
        tableLabel: panel.tableLabel,
        status: session.status,
        ...(evaluation ? { evaluationState: evaluation.state, evaluationVersion: evaluation.version } : {}),
        ...(session.completedByManualReviewRecordId !== undefined
          ? { manualReviewRecordId: session.completedByManualReviewRecordId }
          : {}),
        coverage: criteria.map((criterion) => ({
          criterionId: criterion._id,
          submittedCount: submittedVersions.filter((scorecardVersion) =>
            scorecardVersion.ratings.some((rating) => rating.criterionId === criterion._id),
          ).length,
          requiredCount: round.minimumScorersPerCriterion,
          spreadFlag:
            evaluation?.criterionResults.find((result) => result.criterionId === criterion._id)
              ?.spreadFlag ?? false,
        })),
        scorecards: scorecardRows,
        cases: cases.map((correctionCase) => ({
          id: correctionCase._id,
          kind: correctionCase.kind,
          category: correctionCase.category,
          state: correctionCase.state,
          reason: correctionCase.reason,
          requestedAt: correctionCase.requestedAt,
          version: correctionCase.version,
        })),
      });
    }
    return {
      round: {
        id: round._id,
        name: round.name,
        status: round.status,
        version: round.version,
        minimumScorersPerCriterion: round.minimumScorersPerCriterion,
      },
      criteria: criteria.map((criterion) => ({
        id: criterion._id,
        label: criterion.label,
        displayOrder: criterion.displayOrder,
      })),
      reviews: reviewRows,
      unresolvedTeamCount: states.filter(
        (state) => !["completed", "withdrawn"].includes(state.state),
      ).length,
      pendingManualReviewCount: manualRecords.filter(
        (record) => record.status === "draft" || record.status === "submitted",
      ).length,
      canReadValues: valueGrants.length > 0,
      canStartClose: closeGrants.length > 0,
      canRelease: releaseGrants.length > 0,
      ...(exportRecord
        ? { exportState: exportRecord.state, exportRevision: exportRecord.revision }
        : {}),
      ...(release ? { releasedAt: release.publishedAt } : {}),
    };
  },
});

export const roundValues = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.object({
    round: v.object({ id: v.id("reviewRounds"), name: v.string(), status: v.string() }),
    criteria: v.array(
      v.object({ id: v.id("reviewRubricCriteria"), label: v.string(), weight: v.number() }),
    ),
    reviews: v.array(
      v.object({
        reviewSessionId: v.id("reviewSessions"),
        teamName: v.string(),
        evaluation: v.union(
          v.null(),
          v.object({
            state: v.string(),
            version: v.number(),
            criterionResults: v.array(
              v.object({
                criterionId: v.id("reviewRubricCriteria"),
                scoreCount: v.number(),
                meanScore: v.number(),
                weightedPoints: v.number(),
                spreadFlag: v.boolean(),
              }),
            ),
            totalPoints: v.number(),
          }),
        ),
        scorecards: v.array(
          v.object({
            reviewerName: v.string(),
            version: v.number(),
            submittedAt: v.number(),
            manualReviewRecordId: v.optional(v.id("manualReviewRecords")),
            ratings: v.array(
              v.object({
                criterionId: v.id("reviewRubricCriteria"),
                score: v.number(),
                evidenceNote: v.optional(v.string()),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const round = await requireRound(ctx, event._id, args.roundId);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "score.values.read",
      scopeType: "round",
      scopeId: round._id,
    });
    const [criteria, sessions] = await Promise.all([
      ctx.db
        .query("reviewRubricCriteria")
        .withIndex("by_rubric_order", (index) =>
          index.eq("rubricVersionId", round.rubricVersionId),
        )
        .collect(),
      ctx.db
        .query("reviewSessions")
        .withIndex("by_round_team_status", (index) => index.eq("roundId", round._id))
        .collect(),
    ]);
    const reviews = [];
    for (const session of sessions.filter((candidate) => candidate.status === "completed")) {
      const [team, evaluation, scorecards] = await Promise.all([
        ctx.db.get(session.teamId),
        ctx.db
          .query("reviewEvaluations")
          .withIndex("by_session", (index) => index.eq("reviewSessionId", session._id))
          .unique(),
        ctx.db
          .query("scorecards")
          .withIndex("by_session_status", (index) =>
            index.eq("reviewSessionId", session._id),
          )
          .collect(),
      ]);
      if (!team) throw new Error("A completed review references a missing team.");
      const scorecardRows = [];
      for (const scorecard of scorecards) {
        if (!scorecard.submittedVersionId || scorecard.status !== "submitted") continue;
        const [reviewer, version] = await Promise.all([
          ctx.db.get(scorecard.reviewerPersonId),
          ctx.db.get(scorecard.submittedVersionId),
        ]);
        if (!reviewer || !version) throw new Error("A submitted scorecard is incomplete.");
        scorecardRows.push({
          reviewerName: reviewer.displayName,
          version: version.version,
          submittedAt: version.submittedAt,
          ...(version.manualReviewRecordId !== undefined
            ? { manualReviewRecordId: version.manualReviewRecordId }
            : {}),
          ratings: version.ratings,
        });
      }
      reviews.push({
        reviewSessionId: session._id,
        teamName: team.name,
        evaluation: evaluation
          ? {
              state: evaluation.state,
              version: evaluation.version,
              criterionResults: evaluation.criterionResults.map((result) => ({
                criterionId: result.criterionId,
                scoreCount: result.scoreCount,
                meanScore: result.meanScore,
                weightedPoints: result.weightedPoints,
                spreadFlag: result.spreadFlag,
              })),
              totalPoints: evaluation.totalPoints,
            }
          : null,
        scorecards: scorecardRows,
      });
    }
    reviews.sort((left, right) => left.teamName.localeCompare(right.teamName));
    return {
      round: { id: round._id, name: round.name, status: round.status },
      criteria: criteria.map((criterion) => ({
        id: criterion._id,
        label: criterion.label,
        weight: criterion.weight,
      })),
      reviews,
    };
  },
});

export const myCorrectionOptions = query({
  args: { eventSlug: v.string() },
  returns: v.array(
    v.object({
      scorecardId: v.id("scorecards"),
      scorecardVersion: v.number(),
      teamName: v.string(),
      roundName: v.string(),
      submittedAt: v.number(),
      canRequest: v.boolean(),
      currentCase: v.union(
        v.null(),
        v.object({
          id: v.id("scorecardCorrectionCases"),
          state: v.string(),
          category: v.string(),
          reason: v.string(),
          decisionReason: v.optional(v.string()),
          requestedAt: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const scorecards = await ctx.db
      .query("scorecards")
      .withIndex("by_reviewer_status", (index) =>
        index.eq("reviewerPersonId", person._id).eq("status", "submitted"),
      )
      .collect();
    const rows = [];
    for (const scorecard of scorecards) {
      if (scorecard.eventId !== event._id || scorecard.submittedAt === undefined) continue;
      const [round, session, cases, grantIds] = await Promise.all([
        ctx.db.get(scorecard.roundId),
        ctx.db.get(scorecard.reviewSessionId),
        ctx.db
          .query("scorecardCorrectionCases")
          .withIndex("by_scorecard_state", (index) =>
            index.eq("scorecardId", scorecard._id),
          )
          .collect(),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "scorecard.correction.request",
          scopeType: "scorecard",
          scopeId: scorecard._id,
        }),
      ]);
      if (!round || !session || round.status !== "open") continue;
      const team = await ctx.db.get(session.teamId);
      if (!team) throw new Error("A submitted scorecard references a missing team.");
      const currentCase = cases
        .filter((correctionCase) => correctionCase.kind === "correction")
        .sort((left, right) => right.requestedAt - left.requestedAt)[0] ?? null;
      rows.push({
        scorecardId: scorecard._id,
        scorecardVersion: scorecard.version,
        teamName: team.name,
        roundName: round.name,
        submittedAt: scorecard.submittedAt,
        canRequest:
          grantIds.length > 0 &&
          !cases.some((correctionCase) => unresolvedCorrection(correctionCase.state)),
        currentCase: currentCase
          ? {
              id: currentCase._id,
              state: currentCase.state,
              category: currentCase.category,
              reason: currentCase.reason,
              ...(currentCase.decisionReason !== undefined
                ? { decisionReason: currentCase.decisionReason }
                : {}),
              requestedAt: currentCase.requestedAt,
            }
          : null,
      });
    }
    return rows.sort((left, right) => right.submittedAt - left.submittedAt);
  },
});

export const requestCorrection = mutation({
  args: {
    eventSlug: v.string(),
    scorecardId: v.id("scorecards"),
    expectedScorecardVersion: v.number(),
    category: v.union(
      v.literal("reviewer_error"),
      v.literal("technical_error"),
      v.literal("other"),
    ),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ correctionCaseId: v.id("scorecardCorrectionCases"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Correction reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.scorecardId,
      args.expectedScorecardVersion,
      args.category,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "scorecard.correction.request",
      requestFingerprint,
    });
    if (prior) {
      const correctionCaseId = ctx.db.normalizeId("scorecardCorrectionCases", prior.targetId);
      if (!correctionCaseId) throw new Error("Prior correction request is invalid.");
      const saved = await ctx.db.get(correctionCaseId);
      if (!saved) throw new Error("Prior correction request no longer resolves.");
      return { correctionCaseId, version: saved.version };
    }
    const scorecard = await ctx.db.get(args.scorecardId);
    if (
      !scorecard ||
      scorecard.eventId !== event._id ||
      scorecard.reviewerPersonId !== person._id ||
      scorecard.status !== "submitted" ||
      !scorecard.submittedVersionId ||
      scorecard.version !== args.expectedScorecardVersion
    ) {
      throw new ConvexError({
        code: "SCORECARD_CHANGED",
        message: "Only your current submitted scorecard can request a correction.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "scorecard.correction.request",
      scopeType: "scorecard",
      scopeId: scorecard._id,
    });
    const [session, round, cases] = await Promise.all([
      ctx.db.get(scorecard.reviewSessionId),
      ctx.db.get(scorecard.roundId),
      ctx.db
        .query("scorecardCorrectionCases")
        .withIndex("by_scorecard_state", (index) => index.eq("scorecardId", scorecard._id))
        .collect(),
    ]);
    if (!session || !round || round.eventId !== event._id || round.status !== "open") {
      throw new ConvexError({
        code: "CORRECTION_WINDOW_CLOSED",
        message: "This round no longer accepts scorecard correction requests.",
      });
    }
    if (cases.some((correctionCase) => unresolvedCorrection(correctionCase.state))) {
      throw new ConvexError({
        code: "CORRECTION_ALREADY_PENDING",
        message: "This scorecard already has a correction request in progress.",
      });
    }
    const now = Date.now();
    const correctionCaseId = await ctx.db.insert("scorecardCorrectionCases", {
      eventId: event._id,
      roundId: round._id,
      reviewSessionId: session._id,
      scorecardId: scorecard._id,
      kind: "correction",
      category: args.category,
      reason,
      state: "requested",
      originalVersionId: scorecard.submittedVersionId,
      requestedByPersonId: person._id,
      requestedAt: now,
      version: 1,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "scorecard.correction.request",
      requestFingerprint,
      targetType: "scorecard_correction_case",
      targetId: correctionCaseId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "scorecard.correction.request",
      grantIds,
      scopeType: "scorecard",
      scopeId: scorecard._id,
      action: "scorecard.correction_requested",
      targetType: "scorecard_correction_case",
      targetId: correctionCaseId,
      nextSummary: JSON.stringify({
        state: "requested",
        category: args.category,
        originalVersionId: scorecard.submittedVersionId,
      }),
      reason,
    });
    return { correctionCaseId, version: 1 };
  },
});

export const decideCorrection = mutation({
  args: {
    eventSlug: v.string(),
    correctionCaseId: v.id("scorecardCorrectionCases"),
    expectedCaseVersion: v.number(),
    expectedScorecardVersion: v.number(),
    decision: v.union(v.literal("open"), v.literal("reject")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    correctionCaseId: v.id("scorecardCorrectionCases"),
    state: v.string(),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Decision reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.correctionCaseId,
      args.expectedCaseVersion,
      args.expectedScorecardVersion,
      args.decision,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "scorecard.correction.decide",
      requestFingerprint,
    });
    if (prior) {
      const correctionCaseId = ctx.db.normalizeId("scorecardCorrectionCases", prior.targetId);
      if (!correctionCaseId) throw new Error("Prior correction decision is invalid.");
      const saved = await ctx.db.get(correctionCaseId);
      if (!saved) throw new Error("Prior correction decision no longer resolves.");
      return { correctionCaseId, state: saved.state, version: saved.version };
    }
    const correctionCase = await ctx.db.get(args.correctionCaseId);
    if (
      !correctionCase ||
      correctionCase.eventId !== event._id ||
      correctionCase.kind !== "correction"
    ) {
      throw new ConvexError({ code: "CORRECTION_NOT_FOUND", message: "That correction request is unavailable." });
    }
    const scorecard = await ctx.db.get(correctionCase.scorecardId);
    if (
      !scorecard ||
      scorecard.status !== "submitted" ||
      scorecard.submittedVersionId !== correctionCase.originalVersionId ||
      correctionCase.state !== "requested" ||
      correctionCase.version !== args.expectedCaseVersion ||
      scorecard.version !== args.expectedScorecardVersion
    ) {
      throw new ConvexError({
        code: "CORRECTION_CHANGED",
        message: "The request or submitted scorecard changed. Refresh before deciding.",
      });
    }
    const round = await requireRound(ctx, event._id, correctionCase.roundId);
    if (round.status !== "open") {
      throw new ConvexError({
        code: "CORRECTION_WINDOW_CLOSED",
        message: "This round no longer accepts scorecard corrections.",
      });
    }
    const permission = await scorecardAdministrationPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "scorecard.correction.open",
      scorecardId: scorecard._id,
      reviewSessionId: correctionCase.reviewSessionId,
    });
    const now = Date.now();
    const state = args.decision === "open" ? "open" : "rejected";
    await ctx.db.patch(correctionCase._id, {
      state,
      decidedByPersonId: person._id,
      decidedAt: now,
      decisionReason: reason,
      version: correctionCase.version + 1,
    });
    if (args.decision === "open") {
      await ctx.db.patch(scorecard._id, {
        status: "correction_open",
        activeCorrectionCaseId: correctionCase._id,
        version: scorecard.version + 1,
        updatedAt: now,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "scorecard.correction.decide",
      requestFingerprint,
      targetType: "scorecard_correction_case",
      targetId: correctionCase._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "scorecard.correction.open",
      grantIds: permission.grantIds,
      scopeType: permission.scopeType,
      scopeId: permission.scopeId,
      action:
        args.decision === "open"
          ? "scorecard.correction_opened"
          : "scorecard.correction_rejected",
      targetType: "scorecard_correction_case",
      targetId: correctionCase._id,
      previousSummary: JSON.stringify({ state: correctionCase.state, version: correctionCase.version }),
      nextSummary: JSON.stringify({ state, version: correctionCase.version + 1 }),
      reason,
    });
    return {
      correctionCaseId: correctionCase._id,
      state,
      version: correctionCase.version + 1,
    };
  },
});

export const voidScorecard = mutation({
  args: {
    eventSlug: v.string(),
    scorecardId: v.id("scorecards"),
    expectedScorecardVersion: v.number(),
    category: correctionCategory,
    disposition: v.union(v.literal("exclude"), v.literal("replacement_review")),
    evidenceReference: v.string(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    correctionCaseId: v.id("scorecardCorrectionCases"),
    disposition: v.string(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Void reason", 5, 500);
    const evidenceReference = normalizedText(
      args.evidenceReference,
      "Evidence reference",
      3,
      500,
    );
    const requestFingerprint = operationFingerprint([
      args.scorecardId,
      args.expectedScorecardVersion,
      args.category,
      args.disposition,
      evidenceReference,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "scorecard.void",
      requestFingerprint,
    });
    if (prior) {
      const correctionCaseId = ctx.db.normalizeId("scorecardCorrectionCases", prior.targetId);
      if (!correctionCaseId) throw new Error("Prior void result is invalid.");
      const saved = await ctx.db.get(correctionCaseId);
      if (!saved?.voidDisposition) throw new Error("Prior void result no longer resolves.");
      return { correctionCaseId, disposition: saved.voidDisposition };
    }
    const scorecard = await ctx.db.get(args.scorecardId);
    if (
      !scorecard ||
      scorecard.eventId !== event._id ||
      scorecard.status !== "submitted" ||
      !scorecard.submittedVersionId ||
      scorecard.version !== args.expectedScorecardVersion
    ) {
      throw new ConvexError({
        code: "SCORECARD_CHANGED",
        message: "Only the current submitted scorecard can be voided.",
      });
    }
    const round = await requireRound(ctx, event._id, scorecard.roundId);
    if (round.status !== "open") {
      throw new ConvexError({
        code: "VOID_WINDOW_CLOSED",
        message: "This round is no longer open for scorecard remedies.",
      });
    }
    const permission = await scorecardAdministrationPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "scorecard.void",
      scorecardId: scorecard._id,
      reviewSessionId: scorecard.reviewSessionId,
    });
    const [session, evaluation, cases] = await Promise.all([
      ctx.db.get(scorecard.reviewSessionId),
      ctx.db
        .query("reviewEvaluations")
        .withIndex("by_session", (index) =>
          index.eq("reviewSessionId", scorecard.reviewSessionId),
        )
        .unique(),
      ctx.db
        .query("scorecardCorrectionCases")
        .withIndex("by_scorecard_state", (index) => index.eq("scorecardId", scorecard._id))
        .collect(),
    ]);
    if (!session || session.status !== "completed" || !evaluation || evaluation.state !== "complete") {
      throw new ConvexError({
        code: "COMPLETED_REVIEW_REQUIRED",
        message: "Void remedies apply only to a completed review with a computed result.",
      });
    }
    if (cases.some((correctionCase) => unresolvedCorrection(correctionCase.state))) {
      throw new ConvexError({
        code: "CORRECTION_ALREADY_PENDING",
        message: "Resolve the existing correction request before voiding this scorecard.",
      });
    }
    const teamState = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_team", (index) =>
        index.eq("roundId", round._id).eq("teamId", session.teamId),
      )
      .unique();
    const now = Date.now();
    const correctionCaseId = await ctx.db.insert("scorecardCorrectionCases", {
      eventId: event._id,
      roundId: round._id,
      reviewSessionId: session._id,
      scorecardId: scorecard._id,
      kind: "void",
      category: args.category,
      reason,
      evidenceReference,
      state: "closed",
      originalVersionId: scorecard.submittedVersionId,
      voidDisposition: args.disposition,
      requestedByPersonId: person._id,
      requestedAt: now,
      decidedByPersonId: person._id,
      decidedAt: now,
      version: 1,
    });
    await ctx.db.patch(scorecard._id, {
      status: "void",
      activeCorrectionCaseId: undefined,
      version: scorecard.version + 1,
      updatedAt: now,
    });
    await ctx.db.patch(evaluation._id, {
      state: "void",
      invalidatedAt: now,
      invalidatedByPersonId: person._id,
      invalidationReason: reason,
      version: evaluation.version + 1,
      computedAt: now,
    });
    if (args.disposition === "replacement_review") {
      if (!teamState || teamState.teamId !== session.teamId) {
        throw new Error("The completed review has no matching team-round state.");
      }
      await ctx.db.patch(teamState._id, {
        state: "held",
        holdReason: "Replacement review required after an invalidated scorecard",
        completedAt: undefined,
        version: teamState.version + 1,
        updatedByPersonId: person._id,
        updatedAt: now,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "scorecard.void",
      requestFingerprint,
      targetType: "scorecard_correction_case",
      targetId: correctionCaseId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "scorecard.void",
      grantIds: permission.grantIds,
      scopeType: permission.scopeType,
      scopeId: permission.scopeId,
      action: "scorecard.voided",
      targetType: "scorecard_correction_case",
      targetId: correctionCaseId,
      previousSummary: JSON.stringify({
        scorecardStatus: scorecard.status,
        evaluationState: evaluation.state,
        evaluationVersion: evaluation.version,
      }),
      nextSummary: JSON.stringify({
        scorecardStatus: "void",
        evaluationState: "void",
        disposition: args.disposition,
      }),
      reason,
    });
    return { correctionCaseId, disposition: args.disposition };
  },
});

export const publishRelease = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    expectedRoundVersion: v.number(),
    policyVersion: v.string(),
    includeCriterionScores: v.boolean(),
    includeTotalScore: v.boolean(),
    includeSharedFindings: v.boolean(),
    includeSharedCommitments: v.boolean(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    releaseId: v.id("scoreReleaseVersions"),
    publishedAt: v.number(),
    releasedTeamCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const policyVersion = normalizedText(args.policyVersion, "Release policy version", 3, 100);
    const reason = normalizedText(args.reason, "Release reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.roundId,
      args.expectedRoundVersion,
      policyVersion,
      args.includeCriterionScores,
      args.includeTotalScore,
      args.includeSharedFindings,
      args.includeSharedCommitments,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "score.release.publish",
      requestFingerprint,
    });
    if (prior) {
      const releaseId = ctx.db.normalizeId("scoreReleaseVersions", prior.targetId);
      if (!releaseId) throw new Error("Prior score-release result is invalid.");
      const release = await ctx.db.get(releaseId);
      if (!release) throw new Error("Prior score-release result no longer resolves.");
      const entries = await ctx.db
        .query("scoreReleaseEntries")
        .withIndex("by_release_team", (index) => index.eq("releaseId", releaseId))
        .collect();
      return {
        releaseId,
        publishedAt: release.publishedAt,
        releasedTeamCount: entries.length,
      };
    }
    const round = await requireRound(ctx, event._id, args.roundId);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "score.release",
      scopeType: "round",
      scopeId: round._id,
    });
    if (round.status !== "closed" || round.version !== args.expectedRoundVersion) {
      throw new ConvexError({
        code: "ROUND_NOT_RELEASEABLE",
        message: "Release requires the current immutable closed-round snapshot.",
      });
    }
    if (
      !args.includeCriterionScores &&
      !args.includeTotalScore &&
      !args.includeSharedFindings &&
      !args.includeSharedCommitments
    ) {
      throw new ConvexError({
        code: "EMPTY_RELEASE",
        message: "Choose at least one participant-visible result or feedback field.",
      });
    }
    const [closeSnapshot, roundExport, existing] = await Promise.all([
      round.activeCloseSnapshotId
        ? ctx.db.get(round.activeCloseSnapshotId)
        : Promise.resolve(null),
      round.activeRoundExportId
        ? ctx.db.get(round.activeRoundExportId)
        : Promise.resolve(null),
      ctx.db
        .query("scoreReleaseVersions")
        .withIndex("by_round", (index) => index.eq("roundId", round._id))
        .unique(),
    ]);
    if (
      !closeSnapshot ||
      !roundExport ||
      roundExport.closeSnapshotId !== closeSnapshot._id ||
      roundExport.state !== "verified"
    ) {
      throw new Error("A closed round has no verified export and close snapshot.");
    }
    if (existing) {
      throw new ConvexError({
        code: "ROUND_ALREADY_RELEASED",
        message: "This round already has an immutable participant release.",
      });
    }
    const now = Date.now();
    const checksum = operationFingerprint([
      closeSnapshot.checksum,
      roundExport.checksum,
      policyVersion,
      args.includeCriterionScores,
      args.includeTotalScore,
      args.includeSharedFindings,
      args.includeSharedCommitments,
    ]);
    const releaseId = await ctx.db.insert("scoreReleaseVersions", {
      eventId: event._id,
      roundId: round._id,
      closeSnapshotId: closeSnapshot._id,
      roundExportId: roundExport._id,
      policyVersion,
      includeCriterionScores: args.includeCriterionScores,
      includeTotalScore: args.includeTotalScore,
      includeSharedFindings: args.includeSharedFindings,
      includeSharedCommitments: args.includeSharedCommitments,
      checksum,
      publishedByPersonId: person._id,
      publishedAt: now,
      reason,
    });
    const closeEntries = await ctx.db
      .query("roundCloseEntries")
      .withIndex("by_snapshot_team", (index) =>
        index.eq("closeSnapshotId", closeSnapshot._id),
      )
      .collect();
    const resultEntries = closeEntries.filter(
      (entry) => entry.payload.kind === "result",
    );
    for (const entry of resultEntries) {
      if (entry.payload.kind !== "result") continue;
      const session = await ctx.db.get(entry.payload.reviewSessionId);
      if (!session || session.teamId !== entry.teamId || session.roundId !== round._id) {
        throw new Error("The close snapshot references an invalid review session.");
      }
      await ctx.db.insert("scoreReleaseEntries", {
        eventId: event._id,
        roundId: round._id,
        releaseId,
        teamId: entry.teamId,
        reviewSessionId: entry.payload.reviewSessionId,
        criterionResults: entry.payload.criterionResults.map((result) => ({
          criterionId: result.criterionId,
          meanScore: result.meanScore,
          weightedPoints: result.weightedPoints,
        })),
        totalPoints: entry.payload.totalPoints,
        ...(session.sharedFindings !== undefined
          ? { sharedFindings: session.sharedFindings }
          : {}),
        ...(session.sharedCommitments !== undefined
          ? { sharedCommitments: session.sharedCommitments }
          : {}),
        createdAt: now,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "score.release.publish",
      requestFingerprint,
      targetType: "score_release",
      targetId: releaseId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "score.release",
      grantIds,
      scopeType: "round",
      scopeId: round._id,
      action: "score.release_published",
      targetType: "score_release",
      targetId: releaseId,
      nextSummary: JSON.stringify({
        policyVersion,
        releasedTeamCount: resultEntries.length,
        includeCriterionScores: args.includeCriterionScores,
        includeTotalScore: args.includeTotalScore,
        includeSharedFindings: args.includeSharedFindings,
        includeSharedCommitments: args.includeSharedCommitments,
        checksum,
      }),
      reason,
    });
    return { releaseId, publishedAt: now, releasedTeamCount: resultEntries.length };
  },
});

export const participantFeedback = query({
  args: { eventSlug: v.string() },
  returns: v.array(
    v.object({
      roundId: v.id("reviewRounds"),
      roundName: v.string(),
      roundSequence: v.number(),
      policyVersion: v.string(),
      publishedAt: v.number(),
      totalScore: v.optional(v.number()),
      criteria: v.array(
        v.object({
          criterionId: v.id("reviewRubricCriteria"),
          label: v.string(),
          meanScore: v.number(),
          weightedPoints: v.number(),
        }),
      ),
      sharedFindings: v.optional(v.string()),
      sharedCommitments: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const person = await findCurrentPerson(ctx);
    if (!person) return [];
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const team = await currentTeam(ctx, event._id, person._id);
    if (!team) return [];
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "score.feedback.read",
      scopeType: "team",
      scopeId: team._id,
    });
    const entries = await ctx.db
      .query("scoreReleaseEntries")
      .withIndex("by_team_time", (index) => index.eq("teamId", team._id))
      .collect();
    const rows = [];
    for (const entry of entries) {
      const [release, round] = await Promise.all([
        ctx.db.get(entry.releaseId),
        ctx.db.get(entry.roundId),
      ]);
      if (
        !release ||
        !round ||
        release.eventId !== event._id ||
        round.eventId !== event._id
      ) {
        throw new Error("A released score entry has an invalid event context.");
      }
      const criteria = [];
      if (release.includeCriterionScores) {
        for (const result of entry.criterionResults) {
          const criterion = await ctx.db.get(result.criterionId);
          if (!criterion || criterion.rubricVersionId !== round.rubricVersionId) {
            throw new Error("A released criterion no longer matches its round rubric.");
          }
          criteria.push({
            criterionId: criterion._id,
            label: criterion.label,
            meanScore: result.meanScore,
            weightedPoints: result.weightedPoints,
          });
        }
      }
      rows.push({
        roundId: round._id,
        roundName: round.name,
        roundSequence: round.sequence,
        policyVersion: release.policyVersion,
        publishedAt: release.publishedAt,
        ...(release.includeTotalScore ? { totalScore: entry.totalPoints } : {}),
        criteria,
        ...(release.includeSharedFindings && entry.sharedFindings !== undefined
          ? { sharedFindings: entry.sharedFindings }
          : {}),
        ...(release.includeSharedCommitments && entry.sharedCommitments !== undefined
          ? { sharedCommitments: entry.sharedCommitments }
          : {}),
      });
    }
    return rows.sort((left, right) => left.roundSequence - right.roundSequence);
  },
});
