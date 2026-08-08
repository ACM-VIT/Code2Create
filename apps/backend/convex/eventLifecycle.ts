import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import {
  eventLifecycleBlockers,
  eventLifecycleTargets,
  eventLifecycleTransitionAllowed,
  type EventLifecycleConfiguration,
} from "./lib/eventLifecycle";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { eventStatus } from "./values";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";

const lifecycleBlocker = v.object({ key: v.string(), label: v.string() });

const lifecycleTransition = v.object({
  targetStatus: eventStatus,
  blockers: v.array(lifecycleBlocker),
});

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    status: eventStatus,
    eventVersion: v.number(),
    canManage: v.boolean(),
    transitions: v.array(lifecycleTransition),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "event.lifecycle.read",
      scopeType: "event",
    });
    const [manageGrantIds, configuration] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "event.lifecycle.manage",
        scopeType: "event",
      }),
      readLifecycleConfiguration(ctx, event),
    ]);
    return {
      status: event.status,
      eventVersion: event.version,
      canManage: manageGrantIds.length > 0,
      transitions: eventLifecycleTargets(event.status).map((targetStatus) => ({
        targetStatus,
        blockers: eventLifecycleBlockers(event.status, targetStatus, configuration),
      })),
    };
  },
});

export const transition = mutation({
  args: {
    eventSlug: v.string(),
    targetStatus: eventStatus,
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ status: eventStatus, eventVersion: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.targetStatus,
      args.expectedEventVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "event.lifecycle.transition",
      requestFingerprint,
    });
    if (prior) {
      return {
        status: args.targetStatus,
        eventVersion: args.expectedEventVersion + 1,
      };
    }

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "event.lifecycle.manage",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CHANGED",
        message: "The event changed. Review its current state before trying again.",
      });
    }
    if (!eventLifecycleTransitionAllowed(event.status, args.targetStatus)) {
      throw new ConvexError({
        code: "EVENT_TRANSITION_NOT_ALLOWED",
        message: "That event-state change is not available from the current state.",
      });
    }
    const configuration = await readLifecycleConfiguration(ctx, event);
    const blockers = eventLifecycleBlockers(event.status, args.targetStatus, configuration);
    if (blockers.length > 0) {
      throw new ConvexError({
        code: "EVENT_NOT_READY",
        message: `Finish this setup first: ${blockers.map((blocker) => blocker.label).join(", ")}.`,
      });
    }

    const reason = normalizedText(args.reason, "Reason", 5, 500);
    const now = Date.now();
    const nextVersion = event.version + 1;
    await ctx.db.patch(event._id, {
      status: args.targetStatus,
      version: nextVersion,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "event.lifecycle.transition",
      requestFingerprint,
      targetType: "event",
      targetId: event._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "event.lifecycle.manage",
      grantIds,
      scopeType: "event",
      action: "event_lifecycle_transitioned",
      targetType: "event",
      targetId: event._id,
      previousSummary: JSON.stringify({ status: event.status, version: event.version }),
      nextSummary: JSON.stringify({ status: args.targetStatus, version: nextVersion }),
      reason,
    });
    return { status: args.targetStatus, eventVersion: nextVersion };
  },
});

async function readLifecycleConfiguration(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
): Promise<EventLifecycleConfiguration> {
  const [
    publishedReviewRound,
    preparingAttendanceSession,
    readyAttendanceSession,
    openAttendanceSession,
    closingAttendanceSession,
    openReviewRound,
    closingReviewRound,
  ] = await Promise.all([
    ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (index) =>
        index.eq("eventId", event._id).eq("status", "published"),
      )
      .first(),
    attendanceSessionInState(ctx, event._id, "preparing"),
    attendanceSessionInState(ctx, event._id, "ready"),
    attendanceSessionInState(ctx, event._id, "open"),
    attendanceSessionInState(ctx, event._id, "closing"),
    reviewRoundInState(ctx, event._id, "open"),
    reviewRoundInState(ctx, event._id, "closing"),
  ]);
  return {
    hasActiveAttendanceSession: Boolean(
      preparingAttendanceSession ||
      readyAttendanceSession ||
      openAttendanceSession ||
      closingAttendanceSession,
    ),
    hasActiveReviewRound: Boolean(openReviewRound || closingReviewRound),
    hasAdmissionPolicy: event.publishedAdmissionPolicyId !== undefined,
    hasAttendancePlan: event.publishedAttendancePlanVersionId !== undefined,
    hasCommunicationsPolicy: event.publishedCommunicationsPolicyId !== undefined,
    hasEventDates:
      event.startsAt !== undefined &&
      event.endsAt !== undefined &&
      event.startsAt < event.endsAt,
    hasFloorPlan: event.publishedFloorPlanVersionId !== undefined,
    hasIntegrationPolicy: event.publishedIntegrationPolicyId !== undefined,
    hasIntakePolicy: event.publishedIntakePolicyId !== undefined,
    hasParticipantPolicy: event.publishedParticipantPolicyId !== undefined,
    hasPhaseSchedule: event.publishedEventPhaseScheduleId !== undefined,
    hasProjectCheckpointPlan: event.publishedProjectCheckpointPlanId !== undefined,
    hasPublishedReviewRound: publishedReviewRound !== null,
    hasTrackCatalog: event.publishedTrackCatalogId !== undefined,
  };
}

function attendanceSessionInState(
  ctx: QueryCtx | MutationCtx,
  eventId: Doc<"events">["_id"],
  status: "preparing" | "ready" | "open" | "closing",
) {
  return ctx.db
    .query("attendanceSessions")
    .withIndex("by_event_status_start", (index) =>
      index.eq("eventId", eventId).eq("status", status),
    )
    .first();
}

function reviewRoundInState(
  ctx: QueryCtx | MutationCtx,
  eventId: Doc<"events">["_id"],
  status: "open" | "closing",
) {
  return ctx.db
    .query("reviewRounds")
    .withIndex("by_event_status_start", (index) =>
      index.eq("eventId", eventId).eq("status", status),
    )
    .first();
}
