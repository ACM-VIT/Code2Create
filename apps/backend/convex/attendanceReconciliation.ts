import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { moveSessionCounter } from "./lib/attendanceCounters";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { maximumAttendanceIntervalsPerParticipantSession } from "./lib/attendanceSessionTransition";

type SessionState = Doc<"attendanceSessionParticipants">["state"];
type DirectCorrectionKind =
  | "mark_present"
  | "mark_temporarily_out"
  | "mark_needs_review";
type ReconciliationAction =
  | { kind: DirectCorrectionKind; effectiveAt: number }
  | {
      kind: "void_last_transition";
      sourceEventId: Id<"attendancePresenceEvents">;
    };

const reconciliationAction = v.union(
  v.object({
    kind: v.literal("mark_present"),
    effectiveAt: v.number(),
  }),
  v.object({
    kind: v.literal("mark_temporarily_out"),
    effectiveAt: v.number(),
  }),
  v.object({
    kind: v.literal("mark_needs_review"),
    effectiveAt: v.number(),
  }),
  v.object({
    kind: v.literal("void_last_transition"),
    sourceEventId: v.id("attendancePresenceEvents"),
  }),
);

function fingerprintParts(action: ReconciliationAction) {
  if (action.kind === "void_last_transition") {
    return [action.kind, action.sourceEventId] as const;
  }
  return [action.kind, action.effectiveAt] as const;
}

function requireEffectiveTime(
  session: Doc<"attendanceSessions">,
  effectiveAt: number,
  now: number,
) {
  if (!Number.isSafeInteger(effectiveAt)) {
    throw new ConvexError({
      code: "INVALID_EFFECTIVE_TIME",
      message: "Choose a valid correction time.",
    });
  }
  if (session.openedAt === undefined || effectiveAt < session.openedAt || effectiveAt > now) {
    throw new ConvexError({
      code: "EFFECTIVE_TIME_OUTSIDE_SESSION",
      message: "The correction time must be between session opening and now.",
    });
  }
}

function latestClosedAt(intervals: Doc<"attendancePresenceIntervals">[]) {
  let latest: number | undefined;
  for (const interval of intervals) {
    if (interval.status !== "closed" || interval.closedAt === undefined) continue;
    if (latest === undefined || interval.closedAt > latest) latest = interval.closedAt;
  }
  return latest;
}

function requireNoOpenInterval(
  participant: Doc<"attendanceSessionParticipants">,
  openIntervals: Doc<"attendancePresenceIntervals">[],
) {
  if (participant.currentIntervalId !== undefined || openIntervals.length !== 0) {
    throw new ConvexError({
      code: "SESSION_INTERVAL_CONFLICT",
      message: "The current interval does not match this correction. Refresh and review the timeline.",
    });
  }
}

function requireCurrentOpenInterval(
  participant: Doc<"attendanceSessionParticipants">,
  openIntervals: Doc<"attendancePresenceIntervals">[],
) {
  const interval = openIntervals[0];
  if (
    openIntervals.length !== 1 ||
    interval === undefined ||
    participant.currentIntervalId !== interval._id
  ) {
    throw new ConvexError({
      code: "SESSION_INTERVAL_CONFLICT",
      message: "The current interval does not match this correction. Refresh and review the timeline.",
    });
  }
  return interval;
}

function entryPreviousState(value: string | undefined): "confirmation_due" | "temporarily_out" | null {
  if (value === "confirmation_due" || value === "temporarily_out") return value;
  return null;
}

async function insertReconciliationEvent(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    session: Doc<"attendanceSessions">;
    operatorPersonId: Id<"people">;
    membershipId: Id<"eventMemberships">;
    clientOperationId: string;
    requestFingerprint: string;
    capturedAt: number;
    receivedAt: number;
    correctionKind:
      | "presence_confirmed"
      | "temporary_exit"
      | "marked_needs_review"
      | "voided_transition";
    reasonCode: string;
    operatorReason: string;
    linkedParticipantVersion: number;
    linkedEventId?: Id<"attendancePresenceEvents">;
    previousState: SessionState;
    nextState: SessionState;
  },
) {
  return ctx.db.insert("attendancePresenceEvents", {
    eventId: args.eventId,
    sourceKind: "staff_reconciliation",
    zoneId: args.session.zoneId,
    sessionId: args.session._id,
    operatorPersonId: args.operatorPersonId,
    membershipId: args.membershipId,
    credentialKind: "manual",
    clientOperationId: args.clientOperationId,
    requestFingerprint: args.requestFingerprint,
    capturedAt: args.capturedAt,
    receivedAt: args.receivedAt,
    isOfflineReplay: false,
    transition: "manual_reconcile",
    outcome: "reconciled",
    reasonCode: args.reasonCode,
    previousState: args.previousState,
    nextState: args.nextState,
    correctionKind: args.correctionKind,
    operatorReason: args.operatorReason,
    linkedParticipantVersion: args.linkedParticipantVersion,
    ...(args.linkedEventId !== undefined ? { linkedEventId: args.linkedEventId } : {}),
  });
}

export const reconcile = mutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    membershipId: v.id("eventMemberships"),
    expectedSessionVersion: v.number(),
    expectedParticipantVersion: v.number(),
    action: reconciliationAction,
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ presenceEventId: v.id("attendancePresenceEvents") }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.sessionId,
      args.membershipId,
      args.expectedSessionVersion,
      args.expectedParticipantVersion,
      ...fingerprintParts(args.action),
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.presence.reconcile",
      requestFingerprint,
    });
    if (prior) {
      const presenceEventId = ctx.db.normalizeId("attendancePresenceEvents", prior.targetId);
      if (!presenceEventId) {
        throw new Error("Prior attendance reconciliation result is invalid.");
      }
      return { presenceEventId };
    }
    const reusedPresenceOperation = await ctx.db
      .query("attendancePresenceEvents")
      .withIndex("by_operator_operation", (index) =>
        index
          .eq("operatorPersonId", person._id)
          .eq("clientOperationId", args.clientOperationId),
      )
      .unique();
    if (reusedPresenceOperation) {
      throw new ConvexError({
        code: "OPERATION_ID_REUSED",
        message: "That operation ID was already used for another attendance command.",
      });
    }

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const [session, membership] = await Promise.all([
      ctx.db.get(args.sessionId),
      ctx.db.get(args.membershipId),
    ]);
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
        message: "Live reconciliation is available only while the session is open.",
      });
    }
    if (!membership || membership.eventId !== event._id) {
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
    if (!participant || participant.eventId !== event._id) {
      throw new ConvexError({
        code: "SESSION_PARTICIPANT_NOT_FOUND",
        message: "The participant is not in this session's frozen cohort.",
      });
    }
    if (participant.version !== args.expectedParticipantVersion) {
      throw new ConvexError({
        code: "PRESENCE_CHANGED",
        message: "This participant's attendance changed. Refresh and review the latest state.",
      });
    }
    if (
      participant.state === "complete" ||
      participant.state === "excused" ||
      participant.state === "not_expected"
    ) {
      throw new ConvexError({
        code: "PRESENCE_NOT_LIVE",
        message: "This attendance state needs the post-session remedy workflow.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.presence.reconcile",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);

    const intervals = await ctx.db
      .query("attendancePresenceIntervals")
      .withIndex("by_session_membership", (index) =>
        index.eq("sessionId", session._id).eq("membershipId", membership._id),
      )
      .take(maximumAttendanceIntervalsPerParticipantSession + 1);
    if (intervals.length > maximumAttendanceIntervalsPerParticipantSession) {
      throw new ConvexError({
        code: "ATTENDANCE_INTERVAL_LIMIT_EXCEEDED",
        message: "This session has more presence intervals than the attendance policy permits.",
      });
    }
    const openIntervals = intervals.filter((interval) => interval.status === "open");
    const now = Date.now();
    let nextState: SessionState;
    let isLate = participant.late;
    let currentIntervalId = participant.currentIntervalId;
    let presenceEventId: Id<"attendancePresenceEvents">;

    if (args.action.kind === "void_last_transition") {
      const source = await ctx.db.get(args.action.sourceEventId);
      if (
        !source ||
        source.eventId !== event._id ||
        source.sessionId !== session._id ||
        source.membershipId !== membership._id ||
        source.sourceKind !== "scanner" ||
        source.outcome !== "accepted" ||
        participant.lastEventId !== source._id
      ) {
        throw new ConvexError({
          code: "SOURCE_EVENT_CHANGED",
          message: "Only the participant's latest accepted scanner transition can be voided.",
        });
      }
      const previousEntryState = entryPreviousState(source.previousState);
      const reversesEntry =
        (source.transition === "session_confirm" || source.transition === "zone_entry") &&
        source.nextState === "present" &&
        previousEntryState !== null &&
        participant.state === "present";
      const reversesExit =
        source.transition === "zone_exit" &&
        source.previousState === "present" &&
        source.nextState === "temporarily_out" &&
        participant.state === "temporarily_out";
      if (!reversesEntry && !reversesExit) {
        throw new ConvexError({
          code: "SOURCE_EVENT_NOT_REVERSIBLE",
          message: "That scanner event cannot be safely voided from the current state.",
        });
      }
      if (reversesEntry) {
        if (previousEntryState === null) {
          throw new Error("A reversible entry must have a prior session state.");
        }
        nextState = previousEntryState;
      } else {
        nextState = "present";
      }
      presenceEventId = await insertReconciliationEvent(ctx, {
        eventId: event._id,
        session,
        operatorPersonId: person._id,
        membershipId: membership._id,
        clientOperationId: args.clientOperationId,
        requestFingerprint,
        capturedAt: now,
        receivedAt: now,
        correctionKind: "voided_transition",
        reasonCode: "latest_scanner_transition_voided",
        operatorReason: reason,
        linkedParticipantVersion: participant.version,
        linkedEventId: source._id,
        previousState: participant.state,
        nextState,
      });
      if (reversesEntry) {
        const interval = requireCurrentOpenInterval(participant, openIntervals);
        if (interval.openedByEventId !== source._id) {
          throw new ConvexError({
            code: "SOURCE_INTERVAL_CHANGED",
            message: "The scanner event no longer owns the current interval.",
          });
        }
        await ctx.db.patch(interval._id, {
          status: "voided",
          voidedByEventId: presenceEventId,
          voidedAt: now,
          lastReconciledByEventId: presenceEventId,
        });
        currentIntervalId = undefined;
        if (nextState === "confirmation_due") isLate = false;
      } else {
        requireNoOpenInterval(participant, openIntervals);
        const closedBySource = intervals.filter(
          (interval) =>
            interval.status === "closed" && interval.closedByEventId === source._id,
        );
        const interval = closedBySource[0];
        if (closedBySource.length !== 1 || interval === undefined) {
          throw new ConvexError({
            code: "SOURCE_INTERVAL_CHANGED",
            message: "The scanner event no longer closes one exact interval.",
          });
        }
        await ctx.db.patch(interval._id, {
          status: "open",
          closedByEventId: undefined,
          closedAt: undefined,
          lastReconciledByEventId: presenceEventId,
        });
        currentIntervalId = interval._id;
      }
    } else {
      requireEffectiveTime(session, args.action.effectiveAt, now);
      if (args.action.kind === "mark_present") {
        if (
          participant.state !== "confirmation_due" &&
          participant.state !== "temporarily_out" &&
          participant.state !== "needs_review"
        ) {
          throw new ConvexError({
            code: "PRESENCE_ALREADY_SET",
            message: "The participant cannot be marked present from the current state.",
          });
        }
        const existingOpenInterval =
          participant.state === "needs_review" && openIntervals.length > 0
            ? requireCurrentOpenInterval(participant, openIntervals)
            : null;
        if (
          existingOpenInterval &&
          args.action.effectiveAt < existingOpenInterval.openedAt
        ) {
          throw new ConvexError({
            code: "EFFECTIVE_TIME_BEFORE_ENTRY",
            message: "The presence correction cannot precede the recorded entry.",
          });
        }
        if (!existingOpenInterval) {
          requireNoOpenInterval(participant, openIntervals);
          const previousClosedAt = latestClosedAt(intervals);
          if (previousClosedAt !== undefined && args.action.effectiveAt < previousClosedAt) {
            throw new ConvexError({
              code: "EFFECTIVE_TIME_OVERLAPS_INTERVAL",
              message: "The correction time cannot precede the latest recorded exit.",
            });
          }
        }
        nextState = "present";
        isLate = participant.late || args.action.effectiveAt > session.startsAt;
        presenceEventId = await insertReconciliationEvent(ctx, {
          eventId: event._id,
          session,
          operatorPersonId: person._id,
          membershipId: membership._id,
          clientOperationId: args.clientOperationId,
          requestFingerprint,
          capturedAt: args.action.effectiveAt,
          receivedAt: now,
          correctionKind: "presence_confirmed",
          reasonCode: "missing_presence_transition_reconciled",
          operatorReason: reason,
          linkedParticipantVersion: participant.version,
          ...(participant.lastEventId !== undefined
            ? { linkedEventId: participant.lastEventId }
            : {}),
          previousState: participant.state,
          nextState,
        });
        if (existingOpenInterval) {
          await ctx.db.patch(existingOpenInterval._id, {
            lastReconciledByEventId: presenceEventId,
          });
          currentIntervalId = existingOpenInterval._id;
        } else {
          if (intervals.length >= maximumAttendanceIntervalsPerParticipantSession) {
            throw new ConvexError({
              code: "ATTENDANCE_INTERVAL_LIMIT_REACHED",
              message: "This session reached its presence-interval limit. Keep the result in review.",
            });
          }
          currentIntervalId = await ctx.db.insert("attendancePresenceIntervals", {
            eventId: event._id,
            membershipId: membership._id,
            zoneId: session.zoneId,
            sessionId: session._id,
            kind: "session",
            status: "open",
            openedByEventId: presenceEventId,
            openedAt: args.action.effectiveAt,
          });
        }
      } else if (args.action.kind === "mark_temporarily_out") {
        if (participant.state !== "present" && participant.state !== "needs_review") {
          throw new ConvexError({
            code: "PRESENCE_NOT_INSIDE",
            message: "Only a participant with an open presence interval can be marked out.",
          });
        }
        const interval = requireCurrentOpenInterval(participant, openIntervals);
        if (args.action.effectiveAt < interval.openedAt) {
          throw new ConvexError({
            code: "EFFECTIVE_TIME_BEFORE_ENTRY",
            message: "The exit correction cannot precede the recorded entry.",
          });
        }
        nextState = "temporarily_out";
        presenceEventId = await insertReconciliationEvent(ctx, {
          eventId: event._id,
          session,
          operatorPersonId: person._id,
          membershipId: membership._id,
          clientOperationId: args.clientOperationId,
          requestFingerprint,
          capturedAt: args.action.effectiveAt,
          receivedAt: now,
          correctionKind: "temporary_exit",
          reasonCode: "missing_temporary_exit_reconciled",
          operatorReason: reason,
          linkedParticipantVersion: participant.version,
          ...(participant.lastEventId !== undefined
            ? { linkedEventId: participant.lastEventId }
            : {}),
          previousState: participant.state,
          nextState,
        });
        await ctx.db.patch(interval._id, {
          status: "closed",
          closedByEventId: presenceEventId,
          closedAt: args.action.effectiveAt,
          lastReconciledByEventId: presenceEventId,
        });
        currentIntervalId = undefined;
      } else {
        if (participant.state === "needs_review") {
          throw new ConvexError({
            code: "PRESENCE_ALREADY_NEEDS_REVIEW",
            message: "This participant is already marked for review.",
          });
        }
        let interval: Doc<"attendancePresenceIntervals"> | null = null;
        if (participant.currentIntervalId !== undefined || openIntervals.length > 0) {
          interval = requireCurrentOpenInterval(participant, openIntervals);
          if (args.action.effectiveAt < interval.openedAt) {
            throw new ConvexError({
              code: "EFFECTIVE_TIME_BEFORE_ENTRY",
              message: "The review marker cannot precede the recorded entry.",
            });
          }
        } else {
          requireNoOpenInterval(participant, openIntervals);
        }
        nextState = "needs_review";
        presenceEventId = await insertReconciliationEvent(ctx, {
          eventId: event._id,
          session,
          operatorPersonId: person._id,
          membershipId: membership._id,
          clientOperationId: args.clientOperationId,
          requestFingerprint,
          capturedAt: args.action.effectiveAt,
          receivedAt: now,
          correctionKind: "marked_needs_review",
          reasonCode: "presence_marked_for_review",
          operatorReason: reason,
          linkedParticipantVersion: participant.version,
          ...(participant.lastEventId !== undefined
            ? { linkedEventId: participant.lastEventId }
            : {}),
          previousState: participant.state,
          nextState,
        });
        if (interval) {
          await ctx.db.patch(interval._id, {
            status: "closed",
            closedByEventId: presenceEventId,
            closedAt: args.action.effectiveAt,
            lastReconciledByEventId: presenceEventId,
          });
          currentIntervalId = undefined;
        }
      }
    }

    await ctx.db.patch(participant._id, {
      state: nextState,
      ...(participant.confirmedAt === undefined && nextState === "present"
        ? { confirmedAt: args.action.kind === "void_last_transition" ? now : args.action.effectiveAt }
        : {}),
      ...(args.action.kind === "void_last_transition" && nextState === "confirmation_due"
        ? { confirmedAt: undefined }
        : {}),
      late: isLate,
      currentIntervalId,
      lastEventId: presenceEventId,
      version: participant.version + 1,
      updatedAt: now,
    });
    await moveSessionCounter(ctx, {
      eventId: event._id,
      sessionId: session._id,
      membershipId: membership._id,
      previousState: participant.state,
      nextState,
      expectedDelta: 0,
      wasLate: participant.late,
      isLate,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.presence.reconcile",
      requestFingerprint,
      targetType: "attendance_presence_event",
      targetId: presenceEventId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.presence.reconcile",
      grantIds,
      scopeType: "attendance_session",
      scopeId: session._id,
      action: "attendance.presence_reconciled",
      targetType: "attendance_session_participant",
      targetId: participant._id,
      previousSummary: JSON.stringify({
        state: participant.state,
        version: participant.version,
        currentIntervalId: participant.currentIntervalId ?? null,
        lastEventId: participant.lastEventId ?? null,
      }),
      nextSummary: JSON.stringify({
        state: nextState,
        version: participant.version + 1,
        currentIntervalId: currentIntervalId ?? null,
        presenceEventId,
        correctionKind: args.action.kind,
      }),
      reason,
    });
    return { presenceEventId };
  },
});
