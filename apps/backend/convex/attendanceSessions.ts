import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { moveSessionCounter } from "./lib/attendanceCounters";
import {
  attendanceSessionCutoffAt,
  attendanceSessionJobIsTerminal,
  extendedAttendanceSessionTiming,
} from "./lib/attendanceSessionLifecycle";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";

async function requireNoPendingManualSheets(
  ctx: MutationCtx,
  sessionId: Id<"attendanceSessions">,
) {
  const [draftManualSheet, submittedManualSheet] = await Promise.all([
    ctx.db
      .query("attendanceManualSheets")
      .withIndex("by_session_status_created", (index) =>
        index.eq("sessionId", sessionId).eq("status", "draft"),
      )
      .first(),
    ctx.db
      .query("attendanceManualSheets")
      .withIndex("by_session_status_created", (index) =>
        index.eq("sessionId", sessionId).eq("status", "submitted"),
      )
      .first(),
  ]);
  if (draftManualSheet || submittedManualSheet) {
    throw new ConvexError({
      code: "MANUAL_SHEETS_PENDING",
      message: "Cancel, reject, or import every pending paper sheet before closing or cancelling this session.",
    });
  }
}

async function membershipMatchesCohort(
  ctx: MutationCtx,
  membership: Doc<"eventMemberships">,
  session: Doc<"attendanceSessions">,
) {
  if (membership.onboardingStatus !== "accepted") return false;
  const cohort = session.expectedCohort;
  if (cohort.kind === "all_admitted") return true;
  if (cohort.kind === "participant_classes") {
    return cohort.participantClasses.some(
      (participantClass) => participantClass === membership.participantClass,
    );
  }
  if (cohort.kind === "explicit") {
    return cohort.membershipIds.some((membershipId) => membershipId === membership._id);
  }
  const teamMember = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", membership.eventId)
        .eq("membershipId", membership._id)
        .eq("status", "active"),
    )
    .unique();
  if (!teamMember) return false;
  const team = await ctx.db.get(teamMember.teamId);
  if (!team?.lockedProjectVersionId) return false;
  const project = await ctx.db.get(team.lockedProjectVersionId);
  return Boolean(
    project &&
      cohort.trackVersionIds.some((trackVersionId) =>
        trackVersionId === project.coreTrackVersionId,
      ),
  );
}

export const prepare = mutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    expectedSessionVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    jobId: v.id("attendanceSessionJobs"),
    sessionId: v.id("attendanceSessions"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.sessionId,
      args.expectedSessionVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.session.prepare",
      requestFingerprint,
    });
    if (prior) {
      const jobId = ctx.db.normalizeId("attendanceSessionJobs", prior.targetId);
      if (!jobId || !(await ctx.db.get(jobId))) {
        throw new Error("Prior attendance preparation no longer resolves.");
      }
      return { jobId, sessionId: args.sessionId };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "SESSION_NOT_FOUND", message: "Attendance session not found." });
    }
    if (session.version !== args.expectedSessionVersion) {
      throw new ConvexError({ code: "SESSION_CHANGED", message: "The session changed. Refresh and try again." });
    }
    if (session.status !== "scheduled" || session.expectationBuildState !== "not_started") {
      throw new ConvexError({ code: "SESSION_NOT_SCHEDULED", message: "This session cannot be prepared now." });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.session.manage",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    const plan = await ctx.db.get(session.planVersionId);
    if (!plan || plan.status !== "published" || plan.eventId !== event._id) {
      throw new ConvexError({ code: "PLAN_NOT_ACTIVE", message: "The session plan is not published." });
    }
    const now = Date.now();
    const jobId = await ctx.db.insert("attendanceSessionJobs", {
      eventId: event._id,
      sessionId: session._id,
      kind: "build_expectations",
      status: "queued",
      scannedCount: 0,
      affectedCount: 0,
      requestedByPersonId: person._id,
      clientOperationId: args.clientOperationId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(session._id, {
      status: "preparing",
      expectationBuildState: "running",
      expectationJobId: jobId,
      version: session.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.session.prepare",
      requestFingerprint,
      targetType: "attendance_session_job",
      targetId: jobId,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.attendanceSessions.buildExpectationBatch, { jobId });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.session.manage",
      grantIds,
      scopeType: "attendance_session",
      scopeId: session._id,
      action: "attendance.session_preparation_started",
      targetType: "attendance_session",
      targetId: session._id,
      previousSummary: JSON.stringify({ status: session.status, version: session.version }),
      nextSummary: JSON.stringify({ status: "preparing", jobId }),
      reason: "Build the published attendance expectation set",
    });
    return { jobId, sessionId: session._id };
  },
});

export const buildExpectationBatch = internalMutation({
  args: { jobId: v.id("attendanceSessionJobs") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.kind !== "build_expectations" || attendanceSessionJobIsTerminal(job.status)) {
      return null;
    }
    const session = await ctx.db.get(job.sessionId);
    if (
      !session ||
      session.eventId !== job.eventId ||
      session.status !== "preparing" ||
      session.expectationJobId !== job._id
    ) {
      await ctx.db.patch(job._id, {
        status: "failed",
        failureCode: "session_state_changed",
        updatedAt: Date.now(),
      });
      return null;
    }
    const page = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", session.eventId).eq("eligibilityStatus", "eligible"),
      )
      .paginate({ cursor: job.cursor ?? null, numItems: 50 });
    let affectedCount = job.affectedCount;
    const now = Date.now();
    for (const membership of page.page) {
      if (!(await membershipMatchesCohort(ctx, membership, session))) continue;
      const existing = await ctx.db
        .query("attendanceSessionParticipants")
        .withIndex("by_session_membership", (index) =>
          index.eq("sessionId", session._id).eq("membershipId", membership._id),
        )
        .unique();
      if (existing) continue;
      const expectation = session.requirement === "required" ? "required" : "optional";
      await ctx.db.insert("attendanceSessionParticipants", {
        eventId: session.eventId,
        sessionId: session._id,
        membershipId: membership._id,
        expectation,
        state: "confirmation_due",
        late: false,
        version: 1,
        updatedAt: now,
      });
      await moveSessionCounter(ctx, {
        eventId: session.eventId,
        sessionId: session._id,
        membershipId: membership._id,
        previousState: null,
        nextState: "confirmation_due",
        expectedDelta: 1,
        wasLate: false,
        isLate: false,
        now,
      });
      affectedCount += 1;
    }
    const scannedCount = job.scannedCount + page.page.length;
    if (page.isDone) {
      await ctx.db.patch(job._id, {
        status: "complete",
        scannedCount,
        affectedCount,
        updatedAt: now,
        completedAt: now,
      });
      await ctx.db.patch(session._id, {
        status: "ready",
        expectationBuildState: "complete",
        expectationCount: affectedCount,
        version: session.version + 1,
        updatedAt: now,
      });
      return null;
    }
    await ctx.db.patch(job._id, {
      status: "running",
      cursor: page.continueCursor,
      scannedCount,
      affectedCount,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.attendanceSessions.buildExpectationBatch, {
      jobId: job._id,
    });
    return null;
  },
});

export const open = mutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    expectedSessionVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ sessionId: v.id("attendanceSessions") }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.sessionId,
      args.expectedSessionVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.session.open",
      requestFingerprint,
    });
    if (prior) return { sessionId: args.sessionId };
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "SESSION_NOT_FOUND", message: "Attendance session not found." });
    }
    if (session.version !== args.expectedSessionVersion) {
      throw new ConvexError({ code: "SESSION_CHANGED", message: "The session changed. Refresh and try again." });
    }
    if (session.status !== "ready" || session.expectationBuildState !== "complete") {
      throw new ConvexError({
        code: "EXPECTATIONS_NOT_READY",
        message: "Finish building the expected participant set before opening.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.session.manage",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    const now = Date.now();
    if (now < session.checkInOpensAt || now > session.checkInClosesAt) {
      throw new ConvexError({
        code: "SESSION_WINDOW_CLOSED",
        message: "The session can open only during its published check-in window.",
      });
    }
    await ctx.db.patch(session._id, {
      status: "open",
      openedAt: now,
      version: session.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.session.open",
      requestFingerprint,
      targetType: "attendance_session",
      targetId: session._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.session.manage",
      grantIds,
      scopeType: "attendance_session",
      scopeId: session._id,
      action: "attendance.session_opened",
      targetType: "attendance_session",
      targetId: session._id,
      previousSummary: JSON.stringify({ status: session.status, version: session.version }),
      nextSummary: JSON.stringify({ status: "open", openedAt: now }),
      reason: "Opened the prepared attendance session",
    });
    return { sessionId: session._id };
  },
});

export const extend = mutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    expectedSessionVersion: v.number(),
    extensionMinutes: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ sessionId: v.id("attendanceSessions") }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.sessionId,
      args.expectedSessionVersion,
      args.extensionMinutes,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.session.extend",
      requestFingerprint,
    });
    if (prior) return { sessionId: args.sessionId };
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({
        code: "SESSION_NOT_FOUND",
        message: "Attendance session not found.",
      });
    }
    if (session.version !== args.expectedSessionVersion) {
      throw new ConvexError({
        code: "SESSION_CHANGED",
        message: "The session changed. Refresh and try again.",
      });
    }
    if (session.status !== "open") {
      throw new ConvexError({
        code: "SESSION_NOT_OPEN",
        message: "Only an open attendance session can be extended.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.session.manage",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    const now = Date.now();
    const timing = extendedAttendanceSessionTiming({
      session,
      extensionMinutes: args.extensionMinutes,
      now,
      ...(event.endsAt !== undefined ? { eventEndsAt: event.endsAt } : {}),
    });
    await ctx.db.patch(session._id, {
      endsAt: timing.endsAt,
      checkInClosesAt: timing.checkInClosesAt,
      version: session.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.session.extend",
      requestFingerprint,
      targetType: "attendance_session",
      targetId: session._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.session.manage",
      grantIds,
      scopeType: "attendance_session",
      scopeId: session._id,
      action: "attendance.session_extended",
      targetType: "attendance_session",
      targetId: session._id,
      previousSummary: JSON.stringify({
        endsAt: session.endsAt,
        checkInClosesAt: session.checkInClosesAt,
        version: session.version,
      }),
      nextSummary: JSON.stringify({
        endsAt: timing.endsAt,
        checkInClosesAt: timing.checkInClosesAt,
        extensionMinutes: args.extensionMinutes,
        version: session.version + 1,
      }),
      reason,
    });
    return { sessionId: session._id };
  },
});

export const close = mutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    expectedSessionVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    sessionId: v.id("attendanceSessions"),
    jobId: v.id("attendanceSessionJobs"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.sessionId,
      args.expectedSessionVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.session.close",
      requestFingerprint,
    });
    if (prior) {
      const jobId = ctx.db.normalizeId("attendanceSessionJobs", prior.targetId);
      if (!jobId || !(await ctx.db.get(jobId))) {
        throw new Error("Prior attendance finalization no longer resolves.");
      }
      return { sessionId: args.sessionId, jobId };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "SESSION_NOT_FOUND", message: "Attendance session not found." });
    }
    if (session.version !== args.expectedSessionVersion) {
      throw new ConvexError({
        code: "SESSION_CHANGED",
        message: "The session changed. Refresh and try again.",
      });
    }
    if (session.status !== "open") {
      throw new ConvexError({
        code: "SESSION_NOT_OPEN",
        message: "Only an open attendance session can be closed.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.session.manage",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    await requireNoPendingManualSheets(ctx, session._id);
    const now = Date.now();
    const closingCutoffAt = attendanceSessionCutoffAt(session, now);
    const jobId = await ctx.db.insert("attendanceSessionJobs", {
      eventId: event._id,
      sessionId: session._id,
      kind: "finalize_results",
      status: "queued",
      scannedCount: 0,
      affectedCount: 0,
      requestedByPersonId: person._id,
      clientOperationId: args.clientOperationId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(session._id, {
      status: "closing",
      closingCutoffAt,
      finalizationJobId: jobId,
      version: session.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.session.close",
      requestFingerprint,
      targetType: "attendance_session_job",
      targetId: jobId,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.attendanceSessions.finalizeResultBatch, { jobId });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.session.manage",
      grantIds,
      scopeType: "attendance_session",
      scopeId: session._id,
      action: "attendance.session_closing",
      targetType: "attendance_session",
      targetId: session._id,
      previousSummary: JSON.stringify({ status: session.status, version: session.version }),
      nextSummary: JSON.stringify({
        status: "closing",
        requestedAt: now,
        cutoffAt: closingCutoffAt,
        jobId,
      }),
      reason,
    });
    return { sessionId: session._id, jobId };
  },
});

export const cancel = mutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    expectedSessionVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    sessionId: v.id("attendanceSessions"),
    jobId: v.id("attendanceSessionJobs"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Cancellation reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.sessionId,
      args.expectedSessionVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.session.cancel",
      requestFingerprint,
    });
    if (prior) {
      const jobId = ctx.db.normalizeId("attendanceSessionJobs", prior.targetId);
      if (!jobId || !(await ctx.db.get(jobId))) {
        throw new Error("Prior attendance cancellation no longer resolves.");
      }
      return { sessionId: args.sessionId, jobId };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({
        code: "SESSION_NOT_FOUND",
        message: "Attendance session not found.",
      });
    }
    if (session.version !== args.expectedSessionVersion) {
      throw new ConvexError({
        code: "SESSION_CHANGED",
        message: "The session changed. Refresh and try again.",
      });
    }
    if (
      session.status !== "scheduled" &&
      session.status !== "preparing" &&
      session.status !== "ready" &&
      session.status !== "open"
    ) {
      throw new ConvexError({
        code: "SESSION_NOT_CANCELLABLE",
        message: "Only a scheduled, preparing, ready, or open session can be cancelled.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.session.manage",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    await requireNoPendingManualSheets(ctx, session._id);
    const now = Date.now();
    const closingCutoffAt = attendanceSessionCutoffAt(session, now);
    if (session.expectationJobId !== undefined) {
      const expectationJob = await ctx.db.get(session.expectationJobId);
      if (
        expectationJob &&
        expectationJob.eventId === event._id &&
        expectationJob.sessionId === session._id &&
        !attendanceSessionJobIsTerminal(expectationJob.status)
      ) {
        await ctx.db.patch(expectationJob._id, {
          status: "cancelled",
          updatedAt: now,
          completedAt: now,
        });
      }
    }
    const jobId = await ctx.db.insert("attendanceSessionJobs", {
      eventId: event._id,
      sessionId: session._id,
      kind: "cancel_results",
      status: "queued",
      scannedCount: 0,
      affectedCount: 0,
      requestedByPersonId: person._id,
      clientOperationId: args.clientOperationId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(session._id, {
      status: "closing",
      closingCutoffAt,
      finalizationJobId: jobId,
      expectationBuildState:
        session.expectationBuildState === "complete" ? "complete" : "cancelled",
      cancelledByPersonId: person._id,
      cancellationReason: reason,
      version: session.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.session.cancel",
      requestFingerprint,
      targetType: "attendance_session_job",
      targetId: jobId,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.attendanceSessions.cancelResultBatch, { jobId });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.session.manage",
      grantIds,
      scopeType: "attendance_session",
      scopeId: session._id,
      action: "attendance.session_cancellation_started",
      targetType: "attendance_session",
      targetId: session._id,
      previousSummary: JSON.stringify({
        status: session.status,
        version: session.version,
        endsAt: session.endsAt,
      }),
      nextSummary: JSON.stringify({
        status: "closing",
        outcome: "cancelled",
        requestedAt: now,
        cutoffAt: closingCutoffAt,
        jobId,
      }),
      reason,
    });
    return { sessionId: session._id, jobId };
  },
});

type FinalResult = NonNullable<Doc<"attendanceSessionParticipants">["result"]>;

function finalResultFor(
  participant: Doc<"attendanceSessionParticipants">,
  intervalsValid: boolean,
): { state: Doc<"attendanceSessionParticipants">["state"]; result: FinalResult } {
  if (!intervalsValid || participant.state === "needs_review") {
    return { state: "needs_review", result: "needs_review" };
  }
  if (participant.state === "excused") return { state: "excused", result: "excused" };
  if (participant.state === "not_expected") {
    return { state: "complete", result: "not_expected" };
  }
  if (participant.state === "confirmation_due") {
    return { state: "complete", result: "absent" };
  }
  if (participant.state === "temporarily_out") {
    return { state: "complete", result: "partial" };
  }
  if (participant.state === "present") {
    return { state: "complete", result: "attended" };
  }
  return {
    state: "complete",
    result: participant.result ?? (participant.confirmedAt ? "attended" : "absent"),
  };
}

export const finalizeResultBatch = internalMutation({
  args: { jobId: v.id("attendanceSessionJobs") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.kind !== "finalize_results" || attendanceSessionJobIsTerminal(job.status)) {
      return null;
    }
    const session = await ctx.db.get(job.sessionId);
    if (
      !session ||
      session.eventId !== job.eventId ||
      session.status !== "closing" ||
      session.finalizationJobId !== job._id ||
      session.closingCutoffAt === undefined
    ) {
      await ctx.db.patch(job._id, {
        status: "failed",
        failureCode: "session_state_changed",
        updatedAt: Date.now(),
      });
      return null;
    }
    const page = await ctx.db
      .query("attendanceSessionParticipants")
      .withIndex("by_session_membership", (index) => index.eq("sessionId", session._id))
      .paginate({ cursor: job.cursor ?? null, numItems: 50 });
    const now = Date.now();
    let affectedCount = job.affectedCount;
    for (const participant of page.page) {
      const intervals = await ctx.db
        .query("attendancePresenceIntervals")
        .withIndex("by_session_membership", (index) =>
          index.eq("sessionId", session._id).eq("membershipId", participant.membershipId),
        )
        .collect();
      const openIntervals = intervals.filter((interval) => interval.status === "open");
      const expectsOpenInterval = participant.state === "present";
      let intervalsValid = expectsOpenInterval
        ? openIntervals.length === 1 &&
          participant.currentIntervalId === openIntervals[0]?._id
        : openIntervals.length === 0 && participant.currentIntervalId === undefined;
      let presentDurationMs = 0;
      for (const interval of intervals) {
        if (interval.status === "voided") continue;
        const closedAt =
          interval.status === "open" ? session.closingCutoffAt : interval.closedAt;
        if (closedAt === undefined || closedAt < interval.openedAt) {
          intervalsValid = false;
          continue;
        }
        presentDurationMs += closedAt - interval.openedAt;
        if (interval.status === "open") {
          await ctx.db.patch(interval._id, {
            status: "closed",
            closedAt: session.closingCutoffAt,
          });
        }
      }
      const final = finalResultFor(participant, intervalsValid);
      await ctx.db.patch(participant._id, {
        state: final.state,
        result: final.result,
        presentDurationMs,
        completedAt: session.closingCutoffAt,
        currentIntervalId: undefined,
        version: participant.version + 1,
        updatedAt: now,
      });
      await moveSessionCounter(ctx, {
        eventId: session.eventId,
        sessionId: session._id,
        membershipId: participant.membershipId,
        previousState: participant.state,
        nextState: final.state,
        expectedDelta: 0,
        wasLate: participant.late,
        isLate: participant.late,
        now,
      });
      affectedCount += 1;
    }
    const scannedCount = job.scannedCount + page.page.length;
    if (page.isDone) {
      await ctx.db.patch(job._id, {
        status: "complete",
        scannedCount,
        affectedCount,
        updatedAt: now,
        completedAt: now,
      });
      await ctx.db.patch(session._id, {
        status: "closed",
        closedAt: session.closingCutoffAt,
        version: session.version + 1,
        updatedAt: now,
      });
      return null;
    }
    await ctx.db.patch(job._id, {
      status: "running",
      cursor: page.continueCursor,
      scannedCount,
      affectedCount,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.attendanceSessions.finalizeResultBatch, {
      jobId: job._id,
    });
    return null;
  },
});

export const cancelResultBatch = internalMutation({
  args: { jobId: v.id("attendanceSessionJobs") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.kind !== "cancel_results" || attendanceSessionJobIsTerminal(job.status)) {
      return null;
    }
    const session = await ctx.db.get(job.sessionId);
    if (
      !session ||
      session.eventId !== job.eventId ||
      session.status !== "closing" ||
      session.finalizationJobId !== job._id ||
      session.closingCutoffAt === undefined ||
      session.cancelledByPersonId === undefined ||
      session.cancellationReason === undefined
    ) {
      await ctx.db.patch(job._id, {
        status: "failed",
        failureCode: "session_state_changed",
        updatedAt: Date.now(),
      });
      return null;
    }
    const page = await ctx.db
      .query("attendanceSessionParticipants")
      .withIndex("by_session_membership", (index) => index.eq("sessionId", session._id))
      .paginate({ cursor: job.cursor ?? null, numItems: 50 });
    const now = Date.now();
    let affectedCount = job.affectedCount;
    for (const participant of page.page) {
      const intervals = await ctx.db
        .query("attendancePresenceIntervals")
        .withIndex("by_session_membership", (index) =>
          index.eq("sessionId", session._id).eq("membershipId", participant.membershipId),
        )
        .collect();
      let presentDurationMs = 0;
      for (const interval of intervals) {
        if (interval.status === "voided") continue;
        const closedAt =
          interval.status === "open" ? session.closingCutoffAt : interval.closedAt;
        if (closedAt === undefined || closedAt < interval.openedAt) {
          throw new Error("A session presence interval has invalid accepted bounds.");
        }
        presentDurationMs += closedAt - interval.openedAt;
        if (interval.status === "open") {
          await ctx.db.patch(interval._id, {
            status: "closed",
            closedAt: session.closingCutoffAt,
          });
        }
      }
      await ctx.db.patch(participant._id, {
        state: "complete",
        result: "not_expected",
        presentDurationMs,
        completedAt: session.closingCutoffAt,
        currentIntervalId: undefined,
        version: participant.version + 1,
        updatedAt: now,
      });
      await moveSessionCounter(ctx, {
        eventId: session.eventId,
        sessionId: session._id,
        membershipId: participant.membershipId,
        previousState: participant.state,
        nextState: "complete",
        expectedDelta: 0,
        wasLate: participant.late,
        isLate: participant.late,
        now,
      });
      affectedCount += 1;
    }
    const scannedCount = job.scannedCount + page.page.length;
    if (page.isDone) {
      await ctx.db.patch(job._id, {
        status: "complete",
        scannedCount,
        affectedCount,
        updatedAt: now,
        completedAt: now,
      });
      await ctx.db.patch(session._id, {
        status: "cancelled",
        cancelledAt: session.closingCutoffAt,
        version: session.version + 1,
        updatedAt: now,
      });
      return null;
    }
    await ctx.db.patch(job._id, {
      status: "running",
      cursor: page.continueCursor,
      scannedCount,
      affectedCount,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.attendanceSessions.cancelResultBatch, {
      jobId: job._id,
    });
    return null;
  },
});
