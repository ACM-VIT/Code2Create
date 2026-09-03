import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { moveSessionCounter } from "./lib/attendanceCounters";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject, requireMembership } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
  storedOperationVersion,
} from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedLongText, normalizedText } from "./lib/strings";
import {
  attendanceCorrectionKind,
  attendancePresenceOutcome,
  attendancePresenceSourceKind,
  attendancePresenceTransition,
  attendanceSessionResult,
} from "./values";

const finalAttendanceResult = attendanceSessionResult;

const approvedAttendanceResult = v.union(
  v.literal("attended"),
  v.literal("absent"),
  v.literal("partial"),
  v.literal("excused"),
  v.literal("needs_review"),
);

const remedyState = v.union(v.literal("open"), v.literal("approved"), v.literal("declined"));

const remedyResolution = v.union(
  v.object({
    kind: v.literal("approve"),
    result: approvedAttendanceResult,
    presentDurationMinutes: v.number(),
    confirmedAt: v.optional(v.number()),
    participantNote: v.string(),
  }),
  v.object({
    kind: v.literal("decline"),
    participantNote: v.string(),
  }),
);

const remedyDecisionOperationResult = z
  .object({
    caseId: z.string().min(1),
    state: z.enum(["approved", "declined"]),
    version: z.number().int().positive(),
    participantVersion: z.number().int().positive(),
  })
  .strict();

type ReadCtx = QueryCtx | MutationCtx;

async function finalizedContext(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    sessionId: Id<"attendanceSessions">;
    membershipId: Id<"eventMemberships">;
  },
) {
  const [session, membership] = await Promise.all([
    ctx.db.get(args.sessionId),
    ctx.db.get(args.membershipId),
  ]);
  if (!session || session.eventId !== args.eventId) {
    throw new ConvexError({
      code: "SESSION_NOT_FOUND",
      message: "Attendance session not found.",
    });
  }
  if (!membership || membership.eventId !== args.eventId) {
    throw new ConvexError({
      code: "PARTICIPANT_NOT_FOUND",
      message: "The participant is not part of this event.",
    });
  }
  const participant = await ctx.db
    .query("attendanceSessionParticipants")
    .withIndex("by_session_membership", (index) =>
      index.eq("sessionId", session._id).eq("membershipId", membership._id),
    )
    .unique();
  if (!participant || participant.eventId !== args.eventId) {
    throw new ConvexError({
      code: "SESSION_PARTICIPANT_NOT_FOUND",
      message: "The participant is not in this session's frozen cohort.",
    });
  }
  const finalizationJob = session.finalizationJobId
    ? await ctx.db.get(session.finalizationJobId)
    : null;
  const closingCutoffAt = session.closingCutoffAt;
  if (
    session.status !== "closed" ||
    session.closedAt === undefined ||
    closingCutoffAt === undefined ||
    !finalizationJob ||
    finalizationJob.sessionId !== session._id ||
    finalizationJob.kind !== "finalize_results" ||
    finalizationJob.status !== "complete" ||
    participant.result === undefined ||
    participant.presentDurationMs === undefined ||
    participant.completedAt === undefined
  ) {
    throw new ConvexError({
      code: "RESULT_NOT_FINAL",
      message: "Wait for the session's result finalization to finish before opening a remedy.",
    });
  }
  return {
    session,
    membership,
    participant,
    result: participant.result,
    presentDurationMs: participant.presentDurationMs,
    closingCutoffAt,
  };
}

async function requireNoOpenCase(
  ctx: MutationCtx,
  sessionId: Id<"attendanceSessions">,
  membershipId: Id<"eventMemberships">,
) {
  const existing = await ctx.db
    .query("attendanceResultRemedyCases")
    .withIndex("by_session_membership_state", (index) =>
      index.eq("sessionId", sessionId).eq("membershipId", membershipId).eq("state", "open"),
    )
    .unique();
  if (existing) {
    throw new ConvexError({
      code: "REMEDY_ALREADY_OPEN",
      message: "This participant already has an open review for that session.",
    });
  }
}

async function insertOpenCase(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    sessionId: Id<"attendanceSessions">;
    membershipId: Id<"eventMemberships">;
    expectedSessionVersion: number;
    expectedParticipantVersion: number;
    openedByPersonId: Id<"people">;
    openedByKind: "participant" | "staff";
    description: string;
    now: number;
  },
) {
  const context = await finalizedContext(ctx, args);
  if (context.session.version !== args.expectedSessionVersion) {
    throw new ConvexError({
      code: "SESSION_CHANGED",
      message: "The session changed. Review the current result before continuing.",
    });
  }
  if (context.participant.version !== args.expectedParticipantVersion) {
    throw new ConvexError({
      code: "RESULT_CHANGED",
      message: "The attendance result changed. Review it before opening another case.",
    });
  }
  if (context.participant.expectation === "not_expected") {
    throw new ConvexError({
      code: "REMEDY_NOT_AVAILABLE",
      message: "This participant was not expected for the session.",
    });
  }
  await requireNoOpenCase(ctx, context.session._id, context.membership._id);
  const caseId = await ctx.db.insert("attendanceResultRemedyCases", {
    eventId: args.eventId,
    sessionId: context.session._id,
    membershipId: context.membership._id,
    sessionParticipantId: context.participant._id,
    state: "open",
    openedByPersonId: args.openedByPersonId,
    openedByKind: args.openedByKind,
    description: args.description,
    openedAgainstSessionVersion: context.session.version,
    openedAgainstParticipantVersion: context.participant.version,
    openedAgainstResult: context.result,
    openedAgainstPresentDurationMs: context.presentDurationMs,
    ...(context.participant.confirmedAt !== undefined
      ? { openedAgainstConfirmedAt: context.participant.confirmedAt }
      : {}),
    openedAgainstLate: context.participant.late,
    ...(context.participant.lastEventId !== undefined
      ? { openedAgainstLastEventId: context.participant.lastEventId }
      : {}),
    version: 1,
    createdAt: args.now,
    updatedAt: args.now,
  });
  return { caseId, context };
}

const participantCaseView = v.object({
  id: v.id("attendanceResultRemedyCases"),
  state: remedyState,
  openedByKind: v.union(v.literal("participant"), v.literal("staff")),
  description: v.string(),
  participantResolutionNote: v.optional(v.string()),
  version: v.number(),
  createdAt: v.number(),
  resolvedAt: v.optional(v.number()),
});

const participantHistoryItem = v.object({
  sessionId: v.id("attendanceSessions"),
  sessionName: v.string(),
  sessionVersion: v.number(),
  participantVersion: v.number(),
  startsAt: v.number(),
  closedAt: v.number(),
  result: finalAttendanceResult,
  presentDurationMs: v.number(),
  latestCase: v.union(v.null(), participantCaseView),
  canRequest: v.boolean(),
});

export const maximumParticipantAttendanceHistoryPageSize = 10;

export function requireParticipantAttendanceHistoryPageSize(numItems: number) {
  if (
    !Number.isSafeInteger(numItems) ||
    numItems < 1 ||
    numItems > maximumParticipantAttendanceHistoryPageSize
  ) {
    throw new ConvexError({
      code: "INVALID_PAGE_SIZE",
      message: `Load between 1 and ${maximumParticipantAttendanceHistoryPageSize} attendance results at a time.`,
    });
  }
}

export const mine = query({
  args: {
    eventSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(participantHistoryItem),
  handler: async (ctx, args) => {
    requireParticipantAttendanceHistoryPageSize(args.paginationOpts.numItems);
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.remedy.self.read",
      scopeType: "self",
      scopeId: membership._id,
    });
    const [participantPage, openGrantIds] = await Promise.all([
      ctx.db
        .query("attendanceSessionParticipants")
        .withIndex("by_membership_completed", (index) =>
          index.eq("membershipId", membership._id).gt("completedAt", 0),
        )
        .order("desc")
        .paginate(args.paginationOpts),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "attendance.remedy.self.open",
        scopeType: "self",
        scopeId: membership._id,
      }),
    ]);
    const sessions = [];
    for (const participant of participantPage.page) {
      const session = await ctx.db.get(participant.sessionId);
      if (
        !session ||
        session.eventId !== event._id ||
        participant.eventId !== event._id ||
        participant.completedAt === undefined ||
        participant.result === undefined ||
        participant.presentDurationMs === undefined
      ) {
        throw new ConvexError({
          code: "ATTENDANCE_HISTORY_INVALID",
          message: "A finalized attendance result is incomplete. Ask an organizer to repair it.",
        });
      }
      if (session.status === "cancelled") continue;
      if (session.status !== "closed" || session.closedAt === undefined) {
        throw new ConvexError({
          code: "ATTENDANCE_HISTORY_INVALID",
          message: "A finalized attendance session is incomplete. Ask an organizer to repair it.",
        });
      }
      const latestCase = await ctx.db
        .query("attendanceResultRemedyCases")
        .withIndex("by_session_membership_created", (index) =>
          index.eq("sessionId", session._id).eq("membershipId", membership._id),
        )
        .order("desc")
        .first();
      sessions.push({
        sessionId: session._id,
        sessionName: session.name,
        sessionVersion: session.version,
        participantVersion: participant.version,
        startsAt: session.startsAt,
        closedAt: session.closedAt,
        result: participant.result,
        presentDurationMs: participant.presentDurationMs,
        latestCase: latestCase
          ? {
              id: latestCase._id,
              state: latestCase.state,
              openedByKind: latestCase.openedByKind,
              description: latestCase.description,
              ...(latestCase.participantResolutionNote !== undefined
                ? { participantResolutionNote: latestCase.participantResolutionNote }
                : {}),
              version: latestCase.version,
              createdAt: latestCase.createdAt,
              ...(latestCase.resolvedAt !== undefined ? { resolvedAt: latestCase.resolvedAt } : {}),
            }
          : null,
        canRequest:
          openGrantIds.length > 0 &&
          participant.expectation !== "not_expected" &&
          latestCase?.state !== "open",
      });
    }
    return { ...participantPage, page: sessions };
  },
});

export const openMine = mutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    expectedSessionVersion: v.number(),
    expectedParticipantVersion: v.number(),
    description: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ caseId: v.id("attendanceResultRemedyCases"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const description = normalizedLongText(args.description, "Attendance issue", 10, 1_000);
    const requestFingerprint = operationFingerprint([
      args.sessionId,
      args.expectedSessionVersion,
      args.expectedParticipantVersion,
      description,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.remedy.self.open",
      requestFingerprint,
    });
    if (prior) {
      const caseId = ctx.db.normalizeId("attendanceResultRemedyCases", prior.targetId);
      if (!caseId) throw new Error("The stored attendance remedy request is invalid.");
      return {
        caseId,
        version: storedOperationVersion(prior.resultJson, "attendance remedy request"),
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.remedy.self.open",
      scopeType: "self",
      scopeId: membership._id,
    });
    const now = Date.now();
    const opened = await insertOpenCase(ctx, {
      eventId: event._id,
      sessionId: args.sessionId,
      membershipId: membership._id,
      expectedSessionVersion: args.expectedSessionVersion,
      expectedParticipantVersion: args.expectedParticipantVersion,
      openedByPersonId: person._id,
      openedByKind: "participant",
      description,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.remedy.self.open",
      requestFingerprint,
      targetType: "attendance_result_remedy",
      targetId: opened.caseId,
      resultJson: "1",
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.remedy.self.open",
      grantIds,
      scopeType: "self",
      scopeId: membership._id,
      action: "attendance.result_remedy_requested",
      targetType: "attendance_result_remedy",
      targetId: opened.caseId,
      nextSummary: JSON.stringify({
        sessionId: opened.context.session._id,
        participantVersion: opened.context.participant.version,
        state: "open",
      }),
      reason: "Participant requested review of a finalized attendance result",
    });
    return { caseId: opened.caseId, version: 1 };
  },
});

export const open = mutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    membershipId: v.id("eventMemberships"),
    expectedSessionVersion: v.number(),
    expectedParticipantVersion: v.number(),
    description: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ caseId: v.id("attendanceResultRemedyCases"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const description = normalizedLongText(args.description, "Attendance issue", 10, 1_000);
    const requestFingerprint = operationFingerprint([
      args.sessionId,
      args.membershipId,
      args.expectedSessionVersion,
      args.expectedParticipantVersion,
      description,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.remedy.open",
      requestFingerprint,
    });
    if (prior) {
      const caseId = ctx.db.normalizeId("attendanceResultRemedyCases", prior.targetId);
      if (!caseId) throw new Error("The stored attendance remedy case is invalid.");
      return {
        caseId,
        version: storedOperationVersion(prior.resultJson, "attendance remedy case"),
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.remedy.open",
      scopeType: "attendance_session",
      scopeId: args.sessionId,
    });
    const now = Date.now();
    const opened = await insertOpenCase(ctx, {
      eventId: event._id,
      sessionId: args.sessionId,
      membershipId: args.membershipId,
      expectedSessionVersion: args.expectedSessionVersion,
      expectedParticipantVersion: args.expectedParticipantVersion,
      openedByPersonId: person._id,
      openedByKind: "staff",
      description,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.remedy.open",
      requestFingerprint,
      targetType: "attendance_result_remedy",
      targetId: opened.caseId,
      resultJson: "1",
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.remedy.open",
      grantIds,
      scopeType: "attendance_session",
      scopeId: opened.context.session._id,
      action: "attendance.result_remedy_opened",
      targetType: "attendance_result_remedy",
      targetId: opened.caseId,
      nextSummary: JSON.stringify({
        membershipId: opened.context.membership._id,
        participantVersion: opened.context.participant.version,
        state: "open",
      }),
      reason: "Opened a review of a finalized attendance result",
    });
    return { caseId: opened.caseId, version: 1 };
  },
});

const operationsCaseView = v.object({
  id: v.id("attendanceResultRemedyCases"),
  state: remedyState,
  openedByKind: v.union(v.literal("participant"), v.literal("staff")),
  description: v.string(),
  openedAgainstResult: finalAttendanceResult,
  openedAgainstPresentDurationMs: v.number(),
  decisionReason: v.optional(v.string()),
  participantResolutionNote: v.optional(v.string()),
  approvedResult: v.optional(finalAttendanceResult),
  approvedPresentDurationMs: v.optional(v.number()),
  version: v.number(),
  createdAt: v.number(),
  resolvedAt: v.optional(v.number()),
});

export const forParticipant = query({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    membershipId: v.id("eventMemberships"),
  },
  returns: v.object({
    sessionVersion: v.number(),
    participantVersion: v.number(),
    result: finalAttendanceResult,
    presentDurationMs: v.number(),
    confirmedAt: v.optional(v.number()),
    late: v.boolean(),
    maximumPresentDurationMinutes: v.number(),
    cases: v.array(operationsCaseView),
    recentEvents: v.array(
      v.object({
        id: v.id("attendancePresenceEvents"),
        sourceKind: attendancePresenceSourceKind,
        transition: attendancePresenceTransition,
        outcome: attendancePresenceOutcome,
        correctionKind: v.optional(attendanceCorrectionKind),
        effectiveAt: v.number(),
        recordedAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.remedy.read",
      scopeType: "attendance_session",
      scopeId: args.sessionId,
    });
    const context = await finalizedContext(ctx, {
      eventId: event._id,
      sessionId: args.sessionId,
      membershipId: args.membershipId,
    });
    const [cases, recentEvents] = await Promise.all([
      ctx.db
        .query("attendanceResultRemedyCases")
        .withIndex("by_session_membership_created", (index) =>
          index.eq("sessionId", context.session._id).eq("membershipId", context.membership._id),
        )
        .order("desc")
        .take(5),
      ctx.db
        .query("attendancePresenceEvents")
        .withIndex("by_session_membership_time", (index) =>
          index.eq("sessionId", context.session._id).eq("membershipId", context.membership._id),
        )
        .order("desc")
        .take(10),
    ]);
    const sessionStart = context.session.openedAt ?? context.session.startsAt;
    return {
      sessionVersion: context.session.version,
      participantVersion: context.participant.version,
      result: context.result,
      presentDurationMs: context.presentDurationMs,
      ...(context.participant.confirmedAt !== undefined
        ? { confirmedAt: context.participant.confirmedAt }
        : {}),
      late: context.participant.late,
      maximumPresentDurationMinutes: Math.floor((context.closingCutoffAt - sessionStart) / 60_000),
      cases: cases.map((remedy) => ({
        id: remedy._id,
        state: remedy.state,
        openedByKind: remedy.openedByKind,
        description: remedy.description,
        openedAgainstResult: remedy.openedAgainstResult,
        openedAgainstPresentDurationMs: remedy.openedAgainstPresentDurationMs,
        ...(remedy.decisionReason !== undefined ? { decisionReason: remedy.decisionReason } : {}),
        ...(remedy.participantResolutionNote !== undefined
          ? { participantResolutionNote: remedy.participantResolutionNote }
          : {}),
        ...(remedy.approvedResult !== undefined ? { approvedResult: remedy.approvedResult } : {}),
        ...(remedy.approvedPresentDurationMs !== undefined
          ? { approvedPresentDurationMs: remedy.approvedPresentDurationMs }
          : {}),
        version: remedy.version,
        createdAt: remedy.createdAt,
        ...(remedy.resolvedAt !== undefined ? { resolvedAt: remedy.resolvedAt } : {}),
      })),
      recentEvents: recentEvents.map((presenceEvent) => ({
        id: presenceEvent._id,
        sourceKind: presenceEvent.sourceKind,
        transition: presenceEvent.transition,
        outcome: presenceEvent.outcome,
        ...(presenceEvent.correctionKind !== undefined
          ? { correctionKind: presenceEvent.correctionKind }
          : {}),
        effectiveAt: presenceEvent.capturedAt,
        recordedAt: presenceEvent.receivedAt,
      })),
    };
  },
});

function nextSessionState(result: "attended" | "absent" | "partial" | "excused" | "needs_review") {
  if (result === "excused") return "excused" as const;
  if (result === "needs_review") return "needs_review" as const;
  return "complete" as const;
}

function approvedResultValues(
  session: Doc<"attendanceSessions">,
  closingCutoffAt: number,
  expectation: Doc<"attendanceSessionParticipants">["expectation"],
  resolution: Extract<typeof remedyResolution.type, { kind: "approve" }>,
) {
  if (!Number.isSafeInteger(resolution.presentDurationMinutes)) {
    throw new ConvexError({
      code: "INVALID_PRESENT_DURATION",
      message: "Present duration must be a whole number of minutes.",
    });
  }
  const sessionStart = session.openedAt ?? session.startsAt;
  const maximumMinutes = Math.floor((closingCutoffAt - sessionStart) / 60_000);
  if (resolution.presentDurationMinutes < 0 || resolution.presentDurationMinutes > maximumMinutes) {
    throw new ConvexError({
      code: "INVALID_PRESENT_DURATION",
      message: "Present duration must fit within the finalized session window.",
    });
  }
  if (expectation === "not_expected") {
    throw new ConvexError({
      code: "REMEDY_NOT_AVAILABLE",
      message: "A not-expected result cannot be replaced through this workflow.",
    });
  }
  const confirmedAt = resolution.confirmedAt;
  if (
    confirmedAt !== undefined &&
    (!Number.isSafeInteger(confirmedAt) ||
      confirmedAt < sessionStart ||
      confirmedAt > closingCutoffAt)
  ) {
    throw new ConvexError({
      code: "INVALID_CONFIRMATION_TIME",
      message: "Confirmation time must fall within the finalized session window.",
    });
  }
  if (
    (resolution.result === "attended" || resolution.result === "partial") &&
    (resolution.presentDurationMinutes === 0 || confirmedAt === undefined)
  ) {
    throw new ConvexError({
      code: "INCOMPLETE_APPROVED_RESULT",
      message: "Attended and partial results need a confirmation time and present duration.",
    });
  }
  if (
    resolution.result === "absent" &&
    (resolution.presentDurationMinutes !== 0 || confirmedAt !== undefined)
  ) {
    throw new ConvexError({
      code: "INVALID_ABSENT_RESULT",
      message: "An absent result cannot contain presence time or a confirmation time.",
    });
  }
  return {
    result: resolution.result,
    state: nextSessionState(resolution.result),
    presentDurationMs: resolution.presentDurationMinutes * 60_000,
    confirmedAt,
    late: confirmedAt !== undefined && confirmedAt > session.startsAt,
  };
}

export const decide = mutation({
  args: {
    eventSlug: v.string(),
    caseId: v.id("attendanceResultRemedyCases"),
    expectedCaseVersion: v.number(),
    expectedSessionVersion: v.number(),
    expectedParticipantVersion: v.number(),
    resolution: remedyResolution,
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    caseId: v.id("attendanceResultRemedyCases"),
    state: v.union(v.literal("approved"), v.literal("declined")),
    version: v.number(),
    participantVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Decision reason", 5, 300);
    const participantNote = normalizedText(
      args.resolution.participantNote,
      "Participant note",
      3,
      400,
    );
    const requestFingerprint = operationFingerprint([
      args.caseId,
      args.expectedCaseVersion,
      args.expectedSessionVersion,
      args.expectedParticipantVersion,
      args.resolution.kind,
      args.resolution.kind === "approve" ? args.resolution.result : null,
      args.resolution.kind === "approve" ? args.resolution.presentDurationMinutes : null,
      args.resolution.kind === "approve" ? (args.resolution.confirmedAt ?? null) : null,
      participantNote,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.remedy.decide",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "attendance remedy decision",
        remedyDecisionOperationResult,
      );
      const caseId = ctx.db.normalizeId("attendanceResultRemedyCases", result.caseId);
      if (!caseId || caseId !== prior.targetId) {
        throw new Error("The stored attendance remedy decision is invalid.");
      }
      return {
        caseId,
        state: result.state,
        version: result.version,
        participantVersion: result.participantVersion,
      };
    }
    const remedy = await ctx.db.get(args.caseId);
    if (!remedy || remedy.eventId !== event._id) {
      throw new ConvexError({
        code: "REMEDY_NOT_FOUND",
        message: "Attendance remedy case not found.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.remedy.decide",
      scopeType: "attendance_session",
      scopeId: remedy.sessionId,
    });
    const context = await finalizedContext(ctx, {
      eventId: event._id,
      sessionId: remedy.sessionId,
      membershipId: remedy.membershipId,
    });
    if (
      remedy.state !== "open" ||
      remedy.version !== args.expectedCaseVersion ||
      context.session.version !== args.expectedSessionVersion ||
      remedy.openedAgainstSessionVersion !== context.session.version ||
      context.participant.version !== args.expectedParticipantVersion ||
      remedy.sessionParticipantId !== context.participant._id ||
      remedy.openedAgainstParticipantVersion !== context.participant.version ||
      remedy.openedAgainstResult !== context.result ||
      remedy.openedAgainstPresentDurationMs !== context.presentDurationMs ||
      remedy.openedAgainstConfirmedAt !== context.participant.confirmedAt ||
      remedy.openedAgainstLate !== context.participant.late ||
      remedy.openedAgainstLastEventId !== context.participant.lastEventId
    ) {
      throw new ConvexError({
        code: "REMEDY_CHANGED",
        message: "The case or finalized result changed. Review the current state before deciding.",
      });
    }
    const now = Date.now();
    let state: "approved" | "declined";
    let participantVersion = context.participant.version;
    if (args.resolution.kind === "approve") {
      const approved = approvedResultValues(
        context.session,
        context.closingCutoffAt,
        context.participant.expectation,
        { ...args.resolution, participantNote },
      );
      if (
        approved.result === context.result &&
        approved.presentDurationMs === context.presentDurationMs &&
        approved.confirmedAt === context.participant.confirmedAt &&
        approved.late === context.participant.late &&
        approved.state === context.participant.state
      ) {
        throw new ConvexError({
          code: "REMEDY_HAS_NO_CHANGE",
          message: "The proposed approval does not change the finalized result.",
        });
      }
      participantVersion += 1;
      await ctx.db.patch(context.participant._id, {
        state: approved.state,
        result: approved.result,
        presentDurationMs: approved.presentDurationMs,
        confirmedAt: approved.confirmedAt,
        late: approved.late,
        version: participantVersion,
        updatedAt: now,
      });
      await moveSessionCounter(ctx, {
        eventId: event._id,
        sessionId: context.session._id,
        membershipId: context.membership._id,
        previousState: context.participant.state,
        nextState: approved.state,
        expectedDelta: 0,
        wasLate: context.participant.late,
        isLate: approved.late,
        now,
      });
      state = "approved";
      await ctx.db.patch(remedy._id, {
        state,
        resolvedByPersonId: person._id,
        resolvedAt: now,
        decisionReason: reason,
        participantResolutionNote: participantNote,
        approvedResult: approved.result,
        approvedPresentDurationMs: approved.presentDurationMs,
        approvedConfirmedAt: approved.confirmedAt,
        approvedLate: approved.late,
        appliedParticipantVersion: participantVersion,
        version: remedy.version + 1,
        updatedAt: now,
      });
    } else {
      state = "declined";
      await ctx.db.patch(remedy._id, {
        state,
        resolvedByPersonId: person._id,
        resolvedAt: now,
        decisionReason: reason,
        participantResolutionNote: participantNote,
        version: remedy.version + 1,
        updatedAt: now,
      });
    }
    const result = {
      caseId: remedy._id,
      state,
      version: remedy.version + 1,
      participantVersion,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.remedy.decide",
      requestFingerprint,
      targetType: "attendance_result_remedy",
      targetId: remedy._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.remedy.decide",
      grantIds,
      scopeType: "attendance_session",
      scopeId: context.session._id,
      action:
        state === "approved"
          ? "attendance.result_remedy_approved"
          : "attendance.result_remedy_declined",
      targetType: "attendance_result_remedy",
      targetId: remedy._id,
      previousSummary: JSON.stringify({
        caseState: remedy.state,
        result: context.result,
        presentDurationMs: context.presentDurationMs,
        participantVersion: context.participant.version,
      }),
      nextSummary: JSON.stringify({
        caseState: state,
        result: args.resolution.kind === "approve" ? args.resolution.result : context.result,
        participantVersion,
      }),
      reason,
    });
    return result;
  },
});
