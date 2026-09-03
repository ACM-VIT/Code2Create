import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import {
  eventLifecycleBlockers,
  eventLifecycleTargets,
  eventLifecycleTransitionAllowed,
  type EventLifecycleConfiguration,
} from "./lib/eventLifecycle";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { revokeOperationsAutonomyForEventClosure } from "./lib/operationsAutonomyRevocation";
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
        blockers: eventLifecycleBlockers(targetStatus, configuration),
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
        eventVersion: storedOperationVersion(prior.resultJson, "event lifecycle"),
      };
    }

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "event.lifecycle.manage",
      scopeType: "event",
    });
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
    const blockers = eventLifecycleBlockers(args.targetStatus, configuration);
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
    if (event.status === "live" && args.targetStatus !== "live") {
      await revokeOperationsAutonomyForEventClosure(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        reason,
        now,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "event.lifecycle.transition",
      requestFingerprint,
      targetType: "event",
      targetId: event._id,
      resultJson: String(nextVersion),
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

export const closeRegistrationAtDeadline = internalMutation({
  args: {
    eventId: v.id("events"),
    expectedApplicationsCloseAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (
      !event ||
      event.applicationsCloseAt !== args.expectedApplicationsCloseAt ||
      event.status !== "registration_open" ||
      Date.now() < event.applicationsCloseAt
    ) {
      return null;
    }
    const now = Date.now();
    const nextVersion = event.version + 1;
    await ctx.db.patch(event._id, {
      status: "registration_closed",
      version: nextVersion,
      updatedAt: now,
    });
    if (event.createdByPersonId !== undefined) {
      await ctx.db.insert("auditEvents", {
        eventId: event._id,
        actorPersonId: event.createdByPersonId,
        authorizingPermissionKey: "configured_application_deadline",
        authorizingGrantIds: [],
        resolvedScopeType: "event",
        action: "event_registration_closed_at_deadline",
        targetType: "event",
        targetId: event._id,
        previousSummary: JSON.stringify({
          status: event.status,
          version: event.version,
        }),
        nextSummary: JSON.stringify({
          status: "registration_closed",
          version: nextVersion,
          applicationsCloseAt: event.applicationsCloseAt,
        }),
        reason: "The configured application deadline passed",
        serverTime: now,
      });
    }
    return null;
  },
});

export const markExternalRegistrationClosedAtDeadline = internalMutation({
  args: {
    eventId: v.id("events"),
    expectedExternalApplicationsCloseAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (
      !event ||
      event.externalApplicationsCloseAt !== args.expectedExternalApplicationsCloseAt ||
      event.status !== "registration_open" ||
      Date.now() < args.expectedExternalApplicationsCloseAt ||
      event.updatedAt >= args.expectedExternalApplicationsCloseAt
    ) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(event._id, { updatedAt: now });
    if (event.createdByPersonId !== undefined) {
      await ctx.db.insert("auditEvents", {
        eventId: event._id,
        actorPersonId: event.createdByPersonId,
        authorizingPermissionKey: "configured_external_application_deadline",
        authorizingGrantIds: [],
        resolvedScopeType: "event",
        action: "event_external_registration_closed_at_deadline",
        targetType: "event",
        targetId: event._id,
        previousSummary: JSON.stringify({
          status: event.status,
          externalApplicationsCloseAt: event.externalApplicationsCloseAt,
          externalRegistrationOpen: true,
        }),
        nextSummary: JSON.stringify({
          status: event.status,
          externalApplicationsCloseAt: event.externalApplicationsCloseAt,
          externalRegistrationOpen: false,
        }),
        reason: "The external-participant application deadline passed",
        serverTime: now,
      });
    }
    return null;
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
      event.startsAt !== undefined && event.endsAt !== undefined && event.startsAt < event.endsAt,
    hasFutureApplicationDeadline: Date.now() < event.applicationsCloseAt,
    hasIntegrationPolicy: event.publishedIntegrationPolicyId !== undefined,
    hasIntakePolicy: event.publishedIntakePolicyId !== undefined,
    hasParticipantPolicy: event.publishedParticipantPolicyId !== undefined,
    hasPhaseSchedule: event.publishedEventPhaseScheduleId !== undefined,
    hasProjectCheckpointPlan: event.publishedProjectCheckpointPlanId !== undefined,
    hasPublishedReviewRound: publishedReviewRound !== null,
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
