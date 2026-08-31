import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { teamRoundTableLabel } from "./lib/floor";
import {
  requireCurrentPerson,
  requireEventSubject,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
  storedOperationVersion,
} from "./lib/operations";
import {
  boundedActivePermissionGrants,
  requirePermission,
} from "./lib/permissions";
import { maximumActiveReviewGrantsPerPermission } from "./lib/reviewLimits";
import { patchTeamRoundState } from "./lib/reviewQueueProjection";
import {
  cleanAssignedRatings,
  computeReviewEvaluation,
  requireCompleteAssignedRatings,
} from "./lib/reviewScores";
import { normalizedText, optionalNormalizedText } from "./lib/strings";

const maximumSourceBytes = 900_000;
const sourceContentType = "image/jpeg";
const readyUploadKind: "ready" = "ready";
const completeUploadKind: "complete" = "complete";
const rejectedRecordStatus: "rejected" = "rejected";
const importedRecordStatus: "imported" = "imported";

function sourceUploadFingerprint(args: {
  recordId: Id<"manualReviewRecords">;
  expectedRecordVersion: number;
  fileName: string;
  sourceSha256: string;
  sourceByteCount: number;
}) {
  return operationFingerprint([
    args.recordId,
    args.expectedRecordVersion,
    args.fileName,
    sourceContentType,
    args.sourceSha256,
    args.sourceByteCount,
  ]);
}

function validatedSourceSha256(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ConvexError({
      code: "SOURCE_DIGEST_INVALID",
      message: "The paper source checksum is invalid.",
    });
  }
  return value;
}

const manualReviewVerificationOperationResult = z
  .object({
    version: z.number().int().positive(),
    status: z.enum(["imported", "rejected"]),
    evaluationId: z.string().min(1).optional(),
  })
  .strict();

type ReadCtx = QueryCtx | MutationCtx;
type ManualReviewPermission =
  | "review.manual_record.read"
  | "review.manual_record.enter"
  | "review.manual_record.verify"
  | "review.manual_record.source.read";

const ratingInput = v.object({
  criterionId: v.id("reviewRubricCriteria"),
  score: v.number(),
  evidenceNote: v.optional(v.string()),
});

const reviewerEntryInput = v.object({
  scorecardId: v.id("scorecards"),
  expectedScorecardVersion: v.number(),
  signatureConfirmed: v.boolean(),
  ratings: v.array(ratingInput),
  privateNote: v.optional(v.string()),
});

const ratingView = v.object({
  criterionId: v.id("reviewRubricCriteria"),
  score: v.number(),
  evidenceNote: v.optional(v.string()),
});

const reviewerEntryView = v.object({
  assignmentId: v.id("reviewAssignments"),
  scorecardId: v.id("scorecards"),
  reviewerPersonId: v.id("people"),
  reviewerName: v.string(),
  expectedScorecardVersion: v.number(),
  signatureConfirmed: v.boolean(),
  ratings: v.array(ratingView),
  privateNote: v.optional(v.string()),
});

const recordView = v.object({
  id: v.id("manualReviewRecords"),
  incidentId: v.id("incidents"),
  incidentTitle: v.string(),
  serial: v.string(),
  revision: v.number(),
  startedAt: v.number(),
  endedAt: v.number(),
  unavailableReason: v.string(),
  reviewerEntries: v.array(reviewerEntryView),
  sharedFindings: v.optional(v.string()),
  sharedCommitments: v.optional(v.string()),
  status: v.union(
    v.literal("draft"),
    v.literal("submitted"),
    v.literal("imported"),
    v.literal("rejected"),
    v.literal("cancelled"),
  ),
  enteredByPersonId: v.id("people"),
  enteredByName: v.string(),
  enteredAt: v.number(),
  submittedAt: v.optional(v.number()),
  hasSource: v.boolean(),
  sourceFileName: v.optional(v.string()),
  sourceByteCount: v.optional(v.number()),
  verifiedByName: v.optional(v.string()),
  verifiedAt: v.optional(v.number()),
  rejectionReason: v.optional(v.string()),
  cancellationReason: v.optional(v.string()),
  evaluationId: v.optional(v.id("reviewEvaluations")),
  version: v.number(),
  canUploadSource: v.boolean(),
  canVerify: v.boolean(),
  canReadSource: v.boolean(),
});

const reviewView = v.object({
  id: v.id("reviewSessions"),
  teamName: v.string(),
  panelName: v.string(),
  tableLabel: v.optional(v.string()),
  status: v.string(),
  version: v.number(),
  roundVersion: v.number(),
  startedAt: v.optional(v.number()),
  requiresSharedCommitments: v.boolean(),
  rubric: v.object({
    id: v.id("reviewRubricVersions"),
    name: v.string(),
    scoreMinimum: v.number(),
    scoreMaximum: v.number(),
    criteria: v.array(
      v.object({
        id: v.id("reviewRubricCriteria"),
        label: v.string(),
        displayOrder: v.number(),
      }),
    ),
  }),
  scorecards: v.array(
    v.object({
      id: v.id("scorecards"),
      reviewerPersonId: v.id("people"),
      reviewerName: v.string(),
      assignedCriterionIds: v.array(v.id("reviewRubricCriteria")),
      status: v.string(),
      version: v.number(),
    }),
  ),
  canEnter: v.boolean(),
  canVerify: v.boolean(),
  canReadSource: v.boolean(),
  records: v.array(recordView),
});

function normalizedSerial(value: string) {
  const serial = normalizedText(value, "Paper serial", 3, 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(serial)) {
    throw new ConvexError({
      code: "PAPER_SERIAL_INVALID",
      message: "Use the printed letters, numbers, and hyphens from the paper serial.",
    });
  }
  return serial;
}

function liveReview(status: Doc<"reviewSessions">["status"]) {
  return status === "active" || status === "overdue";
}

async function activeManualGrants(
  ctx: ReadCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  permissionKey: ManualReviewPermission,
) {
  return boundedActivePermissionGrants(ctx, {
    eventId,
    eventAccessSubjectId,
    permissionKey,
    maximumGrantCount: maximumActiveReviewGrantsPerPermission,
  });
}

function grantsAllowReview(
  grants: Array<Doc<"permissionGrants">>,
  reviewSessionId: Id<"reviewSessions">,
) {
  return grants.some(
    (grant) =>
      grant.scopeType === "event" ||
      (grant.scopeType === "review" && grant.scopeId === reviewSessionId),
  );
}

async function requireReviewPermission(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: ManualReviewPermission;
    reviewSessionId: Id<"reviewSessions">;
  },
) {
  return requirePermission(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: args.permissionKey,
    scopeType: "review",
    scopeId: args.reviewSessionId,
  });
}

export const workspace = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.object({
    serverNow: v.number(),
    reviews: v.array(reviewView),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const round = await ctx.db.get(args.roundId);
    if (!round || round.eventId !== event._id) {
      throw new ConvexError({ code: "ROUND_NOT_FOUND", message: "Review round not found." });
    }
    const [readGrants, enterGrants, verifyGrants, sourceGrants, sessions, criteria] =
      await Promise.all([
        activeManualGrants(ctx, event._id, subject._id, "review.manual_record.read"),
        activeManualGrants(ctx, event._id, subject._id, "review.manual_record.enter"),
        activeManualGrants(ctx, event._id, subject._id, "review.manual_record.verify"),
        activeManualGrants(ctx, event._id, subject._id, "review.manual_record.source.read"),
        ctx.db
          .query("reviewSessions")
          .withIndex("by_round_team_status", (index) => index.eq("roundId", round._id))
          .collect(),
        ctx.db
          .query("reviewRubricCriteria")
          .withIndex("by_rubric_order", (index) =>
            index.eq("rubricVersionId", round.rubricVersionId),
          )
          .collect(),
      ]);
    const rubric = await ctx.db.get(round.rubricVersionId);
    if (!rubric || rubric.eventId !== event._id) {
      throw new Error("The round rubric no longer resolves.");
    }
    const reviews = [];
    for (const session of sessions.sort((left, right) => left.createdAt - right.createdAt)) {
      if (!grantsAllowReview(readGrants, session._id)) continue;
      const [team, panel, assignments, scorecards, records] = await Promise.all([
        ctx.db.get(session.teamId),
        ctx.db.get(session.panelId),
        ctx.db
          .query("reviewAssignments")
          .withIndex("by_session_person", (index) =>
            index.eq("reviewSessionId", session._id),
          )
          .collect(),
        ctx.db
          .query("scorecards")
          .withIndex("by_session_status", (index) =>
            index.eq("reviewSessionId", session._id),
          )
          .collect(),
        ctx.db
          .query("manualReviewRecords")
          .withIndex("by_review_created", (index) =>
            index.eq("reviewSessionId", session._id),
          )
          .order("desc")
          .take(10),
      ]);
      if (!team || !panel) throw new Error("A review references a missing team or panel.");
      const scorecardViews = [];
      for (const assignment of assignments.filter((entry) => entry.status === "assigned")) {
        const scorecard = scorecards.find((entry) => entry.assignmentId === assignment._id);
        const reviewer = await ctx.db.get(assignment.reviewerPersonId);
        if (!scorecard || !reviewer) {
          throw new Error("A review assignment is missing its reviewer or scorecard.");
        }
        scorecardViews.push({
          id: scorecard._id,
          reviewerPersonId: reviewer._id,
          reviewerName: reviewer.displayName,
          assignedCriterionIds: assignment.assignedCriterionIds,
          status: scorecard.status,
          version: scorecard.version,
        });
      }
      const recordViews = [];
      for (const record of records) {
        const [incident, enteredBy, verifiedBy] = await Promise.all([
          ctx.db.get(record.incidentId),
          ctx.db.get(record.enteredByPersonId),
          record.verifiedByPersonId
            ? ctx.db.get(record.verifiedByPersonId)
            : Promise.resolve(null),
        ]);
        if (!incident || !enteredBy) continue;
        recordViews.push({
          id: record._id,
          incidentId: incident._id,
          incidentTitle: incident.title,
          serial: record.serial,
          revision: record.revision,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          unavailableReason: record.unavailableReason,
          reviewerEntries: record.reviewerEntries,
          ...(record.sharedFindings !== undefined
            ? { sharedFindings: record.sharedFindings }
            : {}),
          ...(record.sharedCommitments !== undefined
            ? { sharedCommitments: record.sharedCommitments }
            : {}),
          status: record.status,
          enteredByPersonId: record.enteredByPersonId,
          enteredByName: enteredBy.displayName,
          enteredAt: record.enteredAt,
          ...(record.submittedAt !== undefined ? { submittedAt: record.submittedAt } : {}),
          hasSource: record.sourceStorageId !== undefined,
          ...(record.sourceFileName !== undefined
            ? { sourceFileName: record.sourceFileName }
            : {}),
          ...(record.sourceByteCount !== undefined
            ? { sourceByteCount: record.sourceByteCount }
            : {}),
          ...(verifiedBy ? { verifiedByName: verifiedBy.displayName } : {}),
          ...(record.verifiedAt !== undefined ? { verifiedAt: record.verifiedAt } : {}),
          ...(record.rejectionReason !== undefined
            ? { rejectionReason: record.rejectionReason }
            : {}),
          ...(record.cancellationReason !== undefined
            ? { cancellationReason: record.cancellationReason }
            : {}),
          ...(record.evaluationId !== undefined ? { evaluationId: record.evaluationId } : {}),
          version: record.version,
          canUploadSource:
            grantsAllowReview(enterGrants, session._id) &&
            record.enteredByPersonId === person._id &&
            record.status === "draft",
          canVerify:
            grantsAllowReview(verifyGrants, session._id) &&
            grantsAllowReview(sourceGrants, session._id) &&
            record.enteredByPersonId !== person._id &&
            record.status === "submitted",
          canReadSource:
            grantsAllowReview(sourceGrants, session._id) &&
            record.sourceStorageId !== undefined,
        });
      }
      const reviewTableLabel = await teamRoundTableLabel(ctx, round._id, team._id);
      reviews.push({
        id: session._id,
        teamName: team.name,
        panelName: panel.name,
        ...(reviewTableLabel !== undefined ? { tableLabel: reviewTableLabel } : {}),
        status: session.status,
        version: session.version,
        roundVersion: round.version,
        ...(session.startedAt !== undefined ? { startedAt: session.startedAt } : {}),
        requiresSharedCommitments: round.requiresSharedCommitments,
        rubric: {
          id: rubric._id,
          name: rubric.name,
          scoreMinimum: rubric.scoreMinimum,
          scoreMaximum: rubric.scoreMaximum,
          criteria: criteria.map((criterion) => ({
            id: criterion._id,
            label: criterion.label,
            displayOrder: criterion.displayOrder,
          })),
        },
        scorecards: scorecardViews,
        canEnter: grantsAllowReview(enterGrants, session._id),
        canVerify: grantsAllowReview(verifyGrants, session._id),
        canReadSource: grantsAllowReview(sourceGrants, session._id),
        records: recordViews,
      });
    }
    return { serverNow: Date.now(), reviews };
  },
});

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    incidentId: v.id("incidents"),
    reviewSessionId: v.id("reviewSessions"),
    expectedIncidentVersion: v.number(),
    expectedRoundVersion: v.number(),
    expectedReviewVersion: v.number(),
    serial: v.string(),
    startedAt: v.number(),
    endedAt: v.number(),
    unavailableReason: v.string(),
    reviewerEntries: v.array(reviewerEntryInput),
    sharedFindings: v.optional(v.string()),
    sharedCommitments: v.optional(v.string()),
    clientOperationId: v.string(),
  },
  returns: v.object({ id: v.id("manualReviewRecords"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const serial = normalizedSerial(args.serial);
    const unavailableReason = normalizedText(
      args.unavailableReason,
      "Service-unavailability reason",
      5,
      500,
    );
    const requestFingerprint = operationFingerprint([
      args.incidentId,
      args.reviewSessionId,
      args.expectedIncidentVersion,
      args.expectedRoundVersion,
      args.expectedReviewVersion,
      serial,
      args.startedAt,
      args.endedAt,
      unavailableReason,
      JSON.stringify(args.reviewerEntries),
      args.sharedFindings ?? null,
      args.sharedCommitments ?? null,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.manual_record.create",
      requestFingerprint,
    });
    if (prior) {
      const recordId = ctx.db.normalizeId("manualReviewRecords", prior.targetId);
      if (!recordId) throw new Error("The stored paper-review draft is invalid.");
      return {
        id: recordId,
        version: storedOperationVersion(prior.resultJson, "paper-review draft"),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const [incident, session] = await Promise.all([
      ctx.db.get(args.incidentId),
      ctx.db.get(args.reviewSessionId),
    ]);
    if (
      !incident ||
      incident.eventId !== event._id ||
      incident.affectedService !== "review_backend"
    ) {
      throw new ConvexError({
        code: "REVIEW_INCIDENT_NOT_FOUND",
        message: "Choose an approved review-backend incident.",
      });
    }
    if (
      incident.version !== args.expectedIncidentVersion ||
      incident.state === "resolved" ||
      incident.manualModeState !== "approved" ||
      incident.manualModeApprovalCount !== 2
    ) {
      throw new ConvexError({
        code: "MANUAL_MODE_NOT_APPROVED",
        message: "This review incident needs two current manual-mode approvals.",
      });
    }
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "Review not found." });
    }
    const grantIds = await requireReviewPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.manual_record.enter",
      reviewSessionId: session._id,
    });
    const [round, panel, rubric, assignments, scorecards, pendingDraft, pendingSubmitted] =
      await Promise.all([
        ctx.db.get(session.roundId),
        ctx.db.get(session.panelId),
        ctx.db.get(session.rubricVersionId),
        ctx.db
          .query("reviewAssignments")
          .withIndex("by_session_person", (index) =>
            index.eq("reviewSessionId", session._id),
          )
          .collect(),
        ctx.db
          .query("scorecards")
          .withIndex("by_session_status", (index) =>
            index.eq("reviewSessionId", session._id),
          )
          .collect(),
        ctx.db
          .query("manualReviewRecords")
          .withIndex("by_review_status_created", (index) =>
            index.eq("reviewSessionId", session._id).eq("status", "draft"),
          )
          .first(),
        ctx.db
          .query("manualReviewRecords")
          .withIndex("by_review_status_created", (index) =>
            index.eq("reviewSessionId", session._id).eq("status", "submitted"),
          )
          .first(),
      ]);
    if (
      !round ||
      !panel ||
      !rubric ||
      round.eventId !== event._id ||
      panel.eventId !== event._id ||
      rubric.eventId !== event._id
    ) {
      throw new Error("The fixed review context no longer resolves.");
    }
    if (
      round.status !== "open" ||
      round.version !== args.expectedRoundVersion ||
      session.version !== args.expectedReviewVersion ||
      !liveReview(session.status) ||
      session.startedAt === undefined ||
      session.rubricVersionId !== round.rubricVersionId ||
      panel.version !== session.panelVersion
    ) {
      throw new ConvexError({
        code: "REVIEW_CHANGED",
        message: "The round, panel, rubric, or active review changed. Refresh before entry.",
      });
    }
    if (pendingDraft || pendingSubmitted) {
      throw new ConvexError({
        code: "PAPER_REVIEW_ALREADY_PENDING",
        message: "This review already has a paper record awaiting a decision.",
      });
    }
    const now = Date.now();
    if (
      !Number.isSafeInteger(args.startedAt) ||
      !Number.isSafeInteger(args.endedAt) ||
      args.startedAt < session.startedAt - 5 * 60_000 ||
      args.startedAt > args.endedAt ||
      args.endedAt > now + 5 * 60_000
    ) {
      throw new ConvexError({
        code: "PAPER_REVIEW_TIME_INVALID",
        message: "The copied start and end times must match this active review and cannot be in the future.",
      });
    }
    const assigned = assignments.filter((assignment) => assignment.status === "assigned");
    if (
      assigned.length !== round.requiredPanelSize ||
      scorecards.length !== assigned.length ||
      args.reviewerEntries.length !== assigned.length
    ) {
      throw new ConvexError({
        code: "PAPER_REVIEW_PANEL_INCOMPLETE",
        message: "Copy one signed scorecard for every currently assigned reviewer.",
      });
    }
    const inputScorecardIds = new Set<string>();
    const reviewerEntries: Doc<"manualReviewRecords">["reviewerEntries"] = [];
    for (const input of args.reviewerEntries) {
      if (inputScorecardIds.has(input.scorecardId)) {
        throw new ConvexError({
          code: "PAPER_SCORECARD_REPEATED",
          message: "Each assigned scorecard may appear only once.",
        });
      }
      inputScorecardIds.add(input.scorecardId);
      const scorecard = scorecards.find((entry) => entry._id === input.scorecardId);
      const assignment = scorecard
        ? assigned.find((entry) => entry._id === scorecard.assignmentId)
        : undefined;
      const reviewer = assignment ? await ctx.db.get(assignment.reviewerPersonId) : null;
      if (
        !scorecard ||
        !assignment ||
        !reviewer ||
        scorecard.status !== "draft" ||
        scorecard.submittedVersionId !== undefined ||
        scorecard.activeCorrectionCaseId !== undefined ||
        scorecard.version !== input.expectedScorecardVersion ||
        scorecard.reviewerPersonId !== assignment.reviewerPersonId ||
        !input.signatureConfirmed
      ) {
        throw new ConvexError({
          code: "PAPER_SCORECARD_CHANGED",
          message: "Every paper scorecard needs the assigned reviewer's signature and unchanged digital draft.",
        });
      }
      const ratings = requireCompleteAssignedRatings(
        cleanAssignedRatings(
          input.ratings,
          assignment.assignedCriterionIds,
          rubric.scoreMinimum,
          rubric.scoreMaximum,
        ),
        assignment.assignedCriterionIds,
        rubric.scoreMinimum,
        rubric.scoreMaximum,
      );
      const privateNote = optionalNormalizedText(input.privateNote, "Private note", 2_000);
      reviewerEntries.push({
        assignmentId: assignment._id,
        scorecardId: scorecard._id,
        reviewerPersonId: reviewer._id,
        reviewerName: reviewer.displayName,
        expectedScorecardVersion: scorecard.version,
        signatureConfirmed: true,
        ratings,
        ...(privateNote !== undefined ? { privateNote } : {}),
      });
    }
    // Leave the location blank when the team had no mapped table.
    const recordTableLabel = await teamRoundTableLabel(ctx, round._id, session.teamId);
    const sharedFindings = optionalNormalizedText(
      args.sharedFindings,
      "Shared findings",
      4_000,
    );
    const sharedCommitments = optionalNormalizedText(
      args.sharedCommitments,
      "Shared commitments",
      4_000,
    );
    if (round.requiresSharedCommitments && (!sharedFindings || !sharedCommitments)) {
      throw new ConvexError({
        code: "PAPER_SHARED_NOTES_REQUIRED",
        message: "Copy the shared findings and next-checkpoint commitments from the sheet.",
      });
    }
    const revisions = await ctx.db
      .query("manualReviewRecords")
      .withIndex("by_event_serial_revision", (index) =>
        index.eq("eventId", event._id).eq("serial", serial),
      )
      .collect();
    if (revisions.some((record) => record.status !== "rejected" && record.status !== "cancelled")) {
      throw new ConvexError({
        code: "PAPER_SERIAL_ALREADY_USED",
        message: "That paper serial already has an active or imported record.",
      });
    }
    const revision = revisions.reduce(
      (highest, record) => Math.max(highest, record.revision),
      0,
    ) + 1;
    const recordId = await ctx.db.insert("manualReviewRecords", {
      eventId: event._id,
      incidentId: incident._id,
      roundId: round._id,
      reviewSessionId: session._id,
      teamId: session.teamId,
      panelId: panel._id,
      tableLabel: recordTableLabel ?? "",
      evidenceCheckpointSetId: session.evidenceCheckpointSetId,
      rubricVersionId: rubric._id,
      panelVersion: panel.version,
      expectedRoundVersion: round.version,
      expectedReviewVersion: session.version,
      serial,
      revision,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      unavailableReason,
      reviewerEntries,
      ...(sharedFindings !== undefined ? { sharedFindings } : {}),
      ...(sharedCommitments !== undefined ? { sharedCommitments } : {}),
      status: "draft",
      enteredByPersonId: person._id,
      enteredAt: now,
      version: 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.manual_record.create",
      requestFingerprint,
      targetType: "manual_review_record",
      targetId: recordId,
      resultJson: "1",
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.manual_record.enter",
      grantIds,
      scopeType: "review",
      scopeId: session._id,
      action: "review.manual_record_entered",
      targetType: "manual_review_record",
      targetId: recordId,
      nextSummary: JSON.stringify({
        incidentId: incident._id,
        serial,
        revision,
        reviewerCount: reviewerEntries.length,
        rubricVersionId: rubric._id,
        evidenceCheckpointSetId: session.evidenceCheckpointSetId,
      }),
      reason: unavailableReason,
    });
    return { id: recordId, version: 1 };
  },
});

export const sourceUploadContext = internalQuery({
  args: {
    eventSlug: v.string(),
    recordId: v.id("manualReviewRecords"),
    expectedRecordVersion: v.number(),
    fileName: v.string(),
    sourceSha256: v.string(),
    sourceByteCount: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.union(
    v.object({ kind: v.literal("ready") }),
    v.object({ kind: v.literal("complete"), version: v.number() }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const record = await ctx.db.get(args.recordId);
    if (!record || record.eventId !== event._id) {
      throw new ConvexError({ code: "PAPER_REVIEW_NOT_FOUND", message: "Paper review not found." });
    }
    await requireReviewPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.manual_record.enter",
      reviewSessionId: record.reviewSessionId,
    });
    if (record.enteredByPersonId !== person._id) {
      throw new ConvexError({
        code: "PAPER_REVIEW_OWNER_REQUIRED",
        message: "Only the person who entered this record may attach its source image.",
      });
    }
    const fileName = normalizedText(args.fileName, "Source file name", 1, 120);
    const sourceSha256 = validatedSourceSha256(args.sourceSha256);
    if (
      !Number.isSafeInteger(args.sourceByteCount) ||
      args.sourceByteCount < 1 ||
      args.sourceByteCount > maximumSourceBytes
    ) {
      throw new ConvexError({
        code: "SOURCE_SIZE_INVALID",
        message: "The compressed source image must be smaller than 900 KB.",
      });
    }
    const requestFingerprint = sourceUploadFingerprint({
      recordId: args.recordId,
      expectedRecordVersion: args.expectedRecordVersion,
      fileName,
      sourceSha256,
      sourceByteCount: args.sourceByteCount,
    });
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.manual_record.submit",
      requestFingerprint,
    });
    if (prior) {
      const priorRecordId = ctx.db.normalizeId("manualReviewRecords", prior.targetId);
      if (!priorRecordId || priorRecordId !== record._id) {
        throw new Error("The stored paper-review submission is invalid.");
      }
      return {
        kind: completeUploadKind,
        version: storedOperationVersion(prior.resultJson, "paper-review submission"),
      };
    }
    if (record.status === "submitted" && record.sourceStorageId !== undefined) {
      if (
        record.sourceFileName === fileName &&
        record.sourceSha256 === sourceSha256 &&
        record.sourceByteCount === args.sourceByteCount
      ) {
        return { kind: completeUploadKind, version: record.version };
      }
      throw new ConvexError({
        code: "PAPER_REVIEW_CHANGED",
        message: "This paper review already has a different source image.",
      });
    }
    if (record.version !== args.expectedRecordVersion || record.status !== "draft") {
      throw new ConvexError({
        code: "PAPER_REVIEW_CHANGED",
        message: "The paper review changed. Refresh and try again.",
      });
    }
    const [incident, session, round] = await Promise.all([
      ctx.db.get(record.incidentId),
      ctx.db.get(record.reviewSessionId),
      ctx.db.get(record.roundId),
    ]);
    if (
      !incident ||
      incident.state === "resolved" ||
      incident.manualModeState !== "approved" ||
      incident.affectedService !== "review_backend"
    ) {
      throw new ConvexError({
        code: "MANUAL_MODE_CLOSED",
        message: "Review manual mode is no longer open for this record.",
      });
    }
    if (
      !session ||
      !round ||
      !liveReview(session.status) ||
      round.status !== "open" ||
      session.version !== record.expectedReviewVersion ||
      round.version !== record.expectedRoundVersion
    ) {
      throw new ConvexError({
        code: "REVIEW_CHANGED",
        message: "The paper source cannot be submitted after its review context changes.",
      });
    }
    return { kind: readyUploadKind };
  },
});

export const attachSource = internalMutation({
  args: {
    eventSlug: v.string(),
    recordId: v.id("manualReviewRecords"),
    expectedRecordVersion: v.number(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    contentType: v.string(),
    sourceSha256: v.string(),
    sourceByteCount: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    id: v.id("manualReviewRecords"),
    version: v.number(),
    storageId: v.id("_storage"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const fileName = normalizedText(args.fileName, "Source file name", 1, 120);
    if (args.contentType !== sourceContentType) {
      throw new ConvexError({
        code: "SOURCE_TYPE_INVALID",
        message: "The paper source must be a compressed JPEG image.",
      });
    }
    const sourceSha256 = validatedSourceSha256(args.sourceSha256);
    const requestFingerprint = sourceUploadFingerprint({
      recordId: args.recordId,
      expectedRecordVersion: args.expectedRecordVersion,
      fileName,
      sourceSha256,
      sourceByteCount: args.sourceByteCount,
    });
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.manual_record.submit",
      requestFingerprint,
    });
    if (prior) {
      const recordId = ctx.db.normalizeId("manualReviewRecords", prior.targetId);
      const record = recordId ? await ctx.db.get(recordId) : null;
      if (!record || record.eventId !== event._id || !record.sourceStorageId) {
        throw new Error("The stored paper-review submission is invalid.");
      }
      return {
        id: record._id,
        version: storedOperationVersion(prior.resultJson, "paper-review submission"),
        storageId: record.sourceStorageId,
      };
    }
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (
      !metadata ||
      metadata.contentType !== sourceContentType ||
      metadata.size < 1 ||
      metadata.size > maximumSourceBytes ||
      metadata.size !== args.sourceByteCount ||
      metadata.sha256 !== sourceSha256
    ) {
      throw new ConvexError({
        code: "SOURCE_FILE_INVALID",
        message: "The source image is missing, too large, or not a JPEG.",
      });
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const record = await ctx.db.get(args.recordId);
    if (!record || record.eventId !== event._id) {
      throw new ConvexError({ code: "PAPER_REVIEW_NOT_FOUND", message: "Paper review not found." });
    }
    if (
      record.enteredByPersonId !== person._id ||
      record.version !== args.expectedRecordVersion ||
      record.status !== "draft"
    ) {
      throw new ConvexError({
        code: "PAPER_REVIEW_CHANGED",
        message: "Only the owner may submit the current paper-review draft.",
      });
    }
    const grantIds = await requireReviewPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.manual_record.enter",
      reviewSessionId: record.reviewSessionId,
    });
    const [incident, session, round, reusedSource] = await Promise.all([
      ctx.db.get(record.incidentId),
      ctx.db.get(record.reviewSessionId),
      ctx.db.get(record.roundId),
      ctx.db
        .query("manualReviewRecords")
        .withIndex("by_source_storage", (index) => index.eq("sourceStorageId", args.storageId))
        .unique(),
    ]);
    if (reusedSource) {
      throw new ConvexError({
        code: "SOURCE_ALREADY_USED",
        message: "That source image is already bound to a paper review.",
      });
    }
    if (
      !incident ||
      incident.state === "resolved" ||
      incident.manualModeState !== "approved" ||
      incident.affectedService !== "review_backend"
    ) {
      throw new ConvexError({
        code: "MANUAL_MODE_CLOSED",
        message: "Review manual mode is no longer approved.",
      });
    }
    if (
      !session ||
      !round ||
      !liveReview(session.status) ||
      round.status !== "open" ||
      session.version !== record.expectedReviewVersion ||
      round.version !== record.expectedRoundVersion
    ) {
      throw new ConvexError({
        code: "REVIEW_CHANGED",
        message: "The review changed before the source was submitted.",
      });
    }
    const now = Date.now();
    const version = record.version + 1;
    await ctx.db.patch(record._id, {
      status: "submitted",
      submittedAt: now,
      sourceStorageId: args.storageId,
      sourceFileName: fileName,
      sourceContentType: metadata.contentType,
      sourceByteCount: metadata.size,
      sourceSha256: metadata.sha256,
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.manual_record.submit",
      requestFingerprint,
      targetType: "manual_review_record",
      targetId: record._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.manual_record.enter",
      grantIds,
      scopeType: "review",
      scopeId: record.reviewSessionId,
      action: "review.manual_record_submitted",
      targetType: "manual_review_record",
      targetId: record._id,
      previousSummary: JSON.stringify({ status: record.status, version: record.version }),
      nextSummary: JSON.stringify({
        status: "submitted",
        version,
        sourceByteCount: metadata.size,
        sourceSha256: metadata.sha256,
      }),
      reason: "Attached the photographed paper review for independent verification",
    });
    return { id: record._id, version, storageId: args.storageId };
  },
});

export const cancelDraft = mutation({
  args: {
    eventSlug: v.string(),
    recordId: v.id("manualReviewRecords"),
    expectedRecordVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ id: v.id("manualReviewRecords"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Cancellation reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.recordId,
      args.expectedRecordVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.manual_record.cancel",
      requestFingerprint,
    });
    if (prior) {
      const recordId = ctx.db.normalizeId("manualReviewRecords", prior.targetId);
      if (!recordId) throw new Error("The stored paper-review cancellation is invalid.");
      return {
        id: recordId,
        version: storedOperationVersion(prior.resultJson, "paper-review cancellation"),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const record = await ctx.db.get(args.recordId);
    if (
      !record ||
      record.eventId !== event._id ||
      record.enteredByPersonId !== person._id ||
      record.version !== args.expectedRecordVersion ||
      record.status !== "draft"
    ) {
      throw new ConvexError({
        code: "PAPER_REVIEW_NOT_CANCELLABLE",
        message: "Only the owner can cancel an unchanged draft before source submission.",
      });
    }
    const grantIds = await requireReviewPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.manual_record.enter",
      reviewSessionId: record.reviewSessionId,
    });
    const now = Date.now();
    const version = record.version + 1;
    await ctx.db.patch(record._id, {
      status: "cancelled",
      cancelledAt: now,
      cancellationReason: reason,
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.manual_record.cancel",
      requestFingerprint,
      targetType: "manual_review_record",
      targetId: record._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.manual_record.enter",
      grantIds,
      scopeType: "review",
      scopeId: record.reviewSessionId,
      action: "review.manual_record_cancelled",
      targetType: "manual_review_record",
      targetId: record._id,
      previousSummary: JSON.stringify({ status: record.status, version: record.version }),
      nextSummary: JSON.stringify({ status: "cancelled", version }),
      reason,
    });
    return { id: record._id, version };
  },
});

export const sourceContext = internalQuery({
  args: { eventSlug: v.string(), recordId: v.id("manualReviewRecords") },
  returns: v.object({
    storageId: v.id("_storage"),
    contentType: v.string(),
    byteCount: v.number(),
    sha256: v.string(),
    fileName: v.string(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const record = await ctx.db.get(args.recordId);
    if (
      !record ||
      record.eventId !== event._id ||
      !record.sourceStorageId ||
      !record.sourceContentType ||
      record.sourceByteCount === undefined ||
      !record.sourceSha256 ||
      !record.sourceFileName
    ) {
      throw new ConvexError({
        code: "PAPER_SOURCE_NOT_FOUND",
        message: "Paper-review source image not found.",
      });
    }
    await requireReviewPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.manual_record.source.read",
      reviewSessionId: record.reviewSessionId,
    });
    return {
      storageId: record.sourceStorageId,
      contentType: record.sourceContentType,
      byteCount: record.sourceByteCount,
      sha256: record.sourceSha256,
      fileName: record.sourceFileName,
    };
  },
});

export const verify = mutation({
  args: {
    eventSlug: v.string(),
    recordId: v.id("manualReviewRecords"),
    expectedRecordVersion: v.number(),
    decision: v.union(
      v.object({
        kind: v.literal("import"),
        originalFiled: v.boolean(),
        expectedRoundVersion: v.number(),
        expectedReviewVersion: v.number(),
      }),
      v.object({ kind: v.literal("reject") }),
    ),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    id: v.id("manualReviewRecords"),
    version: v.number(),
    status: v.union(v.literal("imported"), v.literal("rejected")),
    evaluationId: v.optional(v.id("reviewEvaluations")),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Verification reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.recordId,
      args.expectedRecordVersion,
      args.decision.kind,
      args.decision.kind === "import"
        ? operationFingerprint([
            args.decision.originalFiled,
            args.decision.expectedRoundVersion,
            args.decision.expectedReviewVersion,
          ])
        : null,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.manual_record.verify",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "paper-review verification",
        manualReviewVerificationOperationResult,
      );
      const recordId = ctx.db.normalizeId("manualReviewRecords", prior.targetId);
      const evaluationId = result.evaluationId
        ? ctx.db.normalizeId("reviewEvaluations", result.evaluationId)
        : undefined;
      if (!recordId || (result.evaluationId && !evaluationId)) {
        throw new Error("The stored paper-review verification is invalid.");
      }
      return {
        id: recordId,
        version: result.version,
        status: result.status,
        ...(evaluationId ? { evaluationId } : {}),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const record = await ctx.db.get(args.recordId);
    if (!record || record.eventId !== event._id) {
      throw new ConvexError({ code: "PAPER_REVIEW_NOT_FOUND", message: "Paper review not found." });
    }
    if (record.enteredByPersonId === person._id) {
      throw new ConvexError({
        code: "SECOND_VERIFIER_REQUIRED",
        message: "A different authorized person must verify this paper review.",
      });
    }
    if (record.version !== args.expectedRecordVersion || record.status !== "submitted") {
      throw new ConvexError({
        code: "PAPER_REVIEW_CHANGED",
        message: "The paper review changed. Refresh and try again.",
      });
    }
    const [verifyGrantIds, sourceGrantIds] = await Promise.all([
      requireReviewPermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "review.manual_record.verify",
        reviewSessionId: record.reviewSessionId,
      }),
      requireReviewPermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "review.manual_record.source.read",
        reviewSessionId: record.reviewSessionId,
      }),
    ]);
    const authorizationGrantIds = [...verifyGrantIds, ...sourceGrantIds];
    const [incident, session, round, rubric, panel, sourceMetadata] = await Promise.all([
      ctx.db.get(record.incidentId),
      ctx.db.get(record.reviewSessionId),
      ctx.db.get(record.roundId),
      ctx.db.get(record.rubricVersionId),
      ctx.db.get(record.panelId),
      record.sourceStorageId
        ? ctx.db.system.get("_storage", record.sourceStorageId)
        : Promise.resolve(null),
    ]);
    if (
      !record.sourceStorageId ||
      !record.sourceSha256 ||
      record.sourceByteCount === undefined ||
      !sourceMetadata ||
      sourceMetadata.sha256 !== record.sourceSha256 ||
      sourceMetadata.size !== record.sourceByteCount ||
      sourceMetadata.contentType !== sourceContentType
    ) {
      throw new ConvexError({
        code: "SOURCE_CHANGED",
        message: "The protected paper source no longer matches its submitted manifest.",
      });
    }
    const now = Date.now();
    const version = record.version + 1;
    if (args.decision.kind === "reject") {
      await ctx.db.patch(record._id, {
        status: "rejected",
        rejectedByPersonId: person._id,
        rejectedAt: now,
        rejectionReason: reason,
        version,
        updatedAt: now,
      });
      const result = { version, status: rejectedRecordStatus };
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "review.manual_record.verify",
        requestFingerprint,
        targetType: "manual_review_record",
        targetId: record._id,
        resultJson: JSON.stringify(result),
        createdAt: now,
      });
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        permissionKey: "review.manual_record.verify",
        grantIds: authorizationGrantIds,
        scopeType: "review",
        scopeId: record.reviewSessionId,
        action: "review.manual_record_rejected",
        targetType: "manual_review_record",
        targetId: record._id,
        previousSummary: JSON.stringify({ status: record.status, version: record.version }),
        nextSummary: JSON.stringify({ status: "rejected", version }),
        reason,
      });
      return { id: record._id, ...result };
    }
    if (!args.decision.originalFiled) {
      throw new ConvexError({
        code: "ORIGINAL_REVIEW_NOT_FILED",
        message: "File the numbered original in the event audit packet before importing it.",
      });
    }
    if (
      !incident ||
      incident.eventId !== event._id ||
      incident.affectedService !== "review_backend" ||
      incident.state === "resolved" ||
      incident.manualModeState !== "approved" ||
      incident.manualModeApprovalCount !== 2
    ) {
      throw new ConvexError({
        code: "MANUAL_MODE_CLOSED",
        message: "Review manual mode is no longer approved for this incident.",
      });
    }
    if (
      !session ||
      !round ||
      !rubric ||
      !panel ||
      session.eventId !== event._id ||
      round.eventId !== event._id ||
      rubric.eventId !== event._id ||
      panel.eventId !== event._id ||
      !liveReview(session.status) ||
      round.status !== "open" ||
      args.decision.expectedReviewVersion !== record.expectedReviewVersion ||
      args.decision.expectedRoundVersion !== record.expectedRoundVersion ||
      session.version !== record.expectedReviewVersion ||
      round.version !== record.expectedRoundVersion ||
      session.rubricVersionId !== record.rubricVersionId ||
      session.evidenceCheckpointSetId !== record.evidenceCheckpointSetId ||
      session.panelId !== record.panelId ||
      panel.version !== record.panelVersion
    ) {
      throw new ConvexError({
        code: "REVIEW_CHANGED",
        message: "The round, review, panel, rubric, or evidence snapshot changed. Reject and reconcile this record.",
      });
    }
    const [existingEvaluation, state, assignments, scorecards] = await Promise.all([
      ctx.db
        .query("reviewEvaluations")
        .withIndex("by_session", (index) => index.eq("reviewSessionId", session._id))
        .unique(),
      ctx.db
        .query("teamRoundStates")
        .withIndex("by_round_team", (index) =>
          index.eq("roundId", round._id).eq("teamId", session.teamId),
        )
        .unique(),
      ctx.db
        .query("reviewAssignments")
        .withIndex("by_session_person", (index) =>
          index.eq("reviewSessionId", session._id),
        )
        .collect(),
      ctx.db
        .query("scorecards")
        .withIndex("by_session_status", (index) =>
          index.eq("reviewSessionId", session._id),
        )
        .collect(),
    ]);
    if (existingEvaluation) {
      throw new ConvexError({
        code: "REVIEW_ALREADY_EVALUATED",
        message: "This review already has a result. Reject and reconcile the paper record.",
      });
    }
    if (!state || state.state !== "in_review" || state.panelId !== session.panelId) {
      throw new ConvexError({
        code: "QUEUE_STATE_CHANGED",
        message: "The team is no longer in this active review.",
      });
    }
    const assigned = assignments.filter((assignment) => assignment.status === "assigned");
    if (
      assigned.length !== round.requiredPanelSize ||
      scorecards.length !== assigned.length ||
      record.reviewerEntries.length !== assigned.length
    ) {
      throw new ConvexError({
        code: "PAPER_REVIEW_PANEL_CHANGED",
        message: "The assigned panel no longer matches the signed paper review.",
      });
    }
    const importedScorecardVersionIds: Array<Id<"scorecardVersions">> = [];
    for (const entry of record.reviewerEntries) {
      const assignment = assigned.find((candidate) => candidate._id === entry.assignmentId);
      const scorecard = scorecards.find((candidate) => candidate._id === entry.scorecardId);
      if (
        !assignment ||
        !scorecard ||
        !entry.signatureConfirmed ||
        assignment.reviewerPersonId !== entry.reviewerPersonId ||
        scorecard.assignmentId !== assignment._id ||
        scorecard.reviewerPersonId !== entry.reviewerPersonId ||
        scorecard.status !== "draft" ||
        scorecard.submittedVersionId !== undefined ||
        scorecard.activeCorrectionCaseId !== undefined ||
        scorecard.version !== entry.expectedScorecardVersion
      ) {
        throw new ConvexError({
          code: "PAPER_SCORECARD_CHANGED",
          message: "A signed scorecard or its assignment changed before import.",
        });
      }
      const ratings = requireCompleteAssignedRatings(
        cleanAssignedRatings(
          entry.ratings,
          assignment.assignedCriterionIds,
          rubric.scoreMinimum,
          rubric.scoreMaximum,
        ),
        assignment.assignedCriterionIds,
        rubric.scoreMinimum,
        rubric.scoreMaximum,
      );
      const priorVersion = await ctx.db
        .query("scorecardVersions")
        .withIndex("by_scorecard_version", (index) =>
          index.eq("scorecardId", scorecard._id),
        )
        .order("desc")
        .first();
      const scorecardVersion = (priorVersion?.version ?? 0) + 1;
      const checksum = operationFingerprint([
        scorecard._id,
        rubric._id,
        scorecardVersion,
        record._id,
        JSON.stringify(ratings),
        entry.privateNote ?? null,
      ]);
      const scorecardVersionId = await ctx.db.insert("scorecardVersions", {
        eventId: event._id,
        roundId: round._id,
        reviewSessionId: session._id,
        scorecardId: scorecard._id,
        reviewerPersonId: entry.reviewerPersonId,
        version: scorecardVersion,
        rubricVersionId: rubric._id,
        ratings,
        ...(entry.privateNote !== undefined ? { privateNote: entry.privateNote } : {}),
        checksum,
        clientOperationId: `manual:${record._id}:${scorecard._id}`,
        manualReviewRecordId: record._id,
        submittedAt: record.endedAt,
      });
      await ctx.db.patch(scorecard._id, {
        status: "submitted",
        ratings,
        ...(entry.privateNote !== undefined
          ? { privateNote: entry.privateNote }
          : { privateNote: undefined }),
        submittedVersionId: scorecardVersionId,
        submittedAt: record.endedAt,
        version: scorecard.version + 1,
        updatedAt: now,
      });
      importedScorecardVersionIds.push(scorecardVersionId);
    }
    const evaluation = await computeReviewEvaluation(ctx, { round, session, rubric });
    const evaluationId = await ctx.db.insert("reviewEvaluations", {
      eventId: event._id,
      roundId: round._id,
      reviewSessionId: session._id,
      teamId: session.teamId,
      rubricVersionId: rubric._id,
      criterionResults: evaluation.criterionResults,
      totalPoints: evaluation.totalPoints,
      state: "complete",
      inputChecksum: evaluation.inputChecksum,
      version: 1,
      computedAt: now,
    });
    await ctx.db.patch(session._id, {
      status: "completed",
      ...(record.sharedFindings !== undefined
        ? { sharedFindings: record.sharedFindings }
        : {}),
      ...(record.sharedCommitments !== undefined
        ? { sharedCommitments: record.sharedCommitments }
        : {}),
      sharedNotesVersion: session.sharedNotesVersion + 1,
      sharedNotesByPersonId: record.enteredByPersonId,
      completedAt: record.endedAt,
      completedByManualReviewRecordId: record._id,
      version: session.version + 1,
      updatedAt: now,
    });
    await patchTeamRoundState(ctx, state, {
      state: "completed",
      completedAt: record.endedAt,
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await ctx.db.patch(record._id, {
      status: "imported",
      verifiedByPersonId: person._id,
      verifiedAt: now,
      verificationReason: reason,
      originalFiledByPersonId: person._id,
      originalFiledAt: now,
      evaluationId,
      importedScorecardVersionIds,
      version,
      updatedAt: now,
    });
    const result = {
      version,
      status: importedRecordStatus,
      evaluationId,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.manual_record.verify",
      requestFingerprint,
      targetType: "manual_review_record",
      targetId: record._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.manual_record.verify",
      grantIds: authorizationGrantIds,
      scopeType: "review",
      scopeId: session._id,
      action: "review.manual_record_imported",
      targetType: "manual_review_record",
      targetId: record._id,
      previousSummary: JSON.stringify({
        status: record.status,
        reviewStatus: session.status,
        version: record.version,
      }),
      nextSummary: JSON.stringify({
        status: "imported",
        reviewStatus: "completed",
        version,
        scorecardVersionCount: importedScorecardVersionIds.length,
        evaluationId,
        evaluationInputChecksum: evaluation.inputChecksum,
        sourceSha256: record.sourceSha256,
        originalFiled: true,
      }),
      reason,
    });
    return { id: record._id, ...result };
  },
});
