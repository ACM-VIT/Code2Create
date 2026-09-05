import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import {
  maximumAttendanceSessionsPerPlan,
  maximumSimultaneousAttendanceSessionsPerParticipant,
} from "./lib/attendancePlanLimits";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject, requireMembership } from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { latestVenueCheckIn } from "./lib/venueCheckInLifecycle";
import {
  attendanceSessionRequirement,
  attendanceSessionStatus,
  sessionPresenceState,
  venuePresenceState,
} from "./values";

type ParticipantPhysicalCredential =
  | {
      kind: "vit_id_barcode";
      state: "not_enrolled" | "active" | "suspended";
    }
  | {
      kind: "external_pass";
      state: "not_issued" | "active" | "suspended";
    };

export const mine = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    available: v.boolean(),
    canViewExternalPass: v.boolean(),
    canReadResultHistory: v.boolean(),
    physicalCredential: v.union(
      v.object({
        kind: v.literal("vit_id_barcode"),
        state: v.union(v.literal("not_enrolled"), v.literal("active"), v.literal("suspended")),
      }),
      v.object({
        kind: v.literal("external_pass"),
        state: v.union(v.literal("not_issued"), v.literal("active"), v.literal("suspended")),
      }),
    ),
    venueCheckIn: v.union(
      v.null(),
      v.object({
        status: v.union(v.literal("checked_in"), v.literal("reversed")),
        checkedInAt: v.number(),
        reversedAt: v.optional(v.number()),
      }),
    ),
    venue: v.union(
      v.null(),
      v.object({
        state: venuePresenceState,
        updatedAt: v.number(),
      }),
    ),
    sessions: v.array(
      v.object({
        id: v.id("attendanceSessions"),
        name: v.string(),
        requirement: attendanceSessionRequirement,
        status: attendanceSessionStatus,
        startsAt: v.number(),
        endsAt: v.number(),
        checkInOpensAt: v.number(),
        checkInClosesAt: v.number(),
        zoneName: v.string(),
        timing: v.union(v.literal("current"), v.literal("upcoming")),
        state: sessionPresenceState,
        late: v.boolean(),
        updatedAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.self.read",
      scopeType: "self",
      scopeId: membership._id,
    });
    const planId = event.publishedAttendancePlanVersionId;
    const plan = planId ? await ctx.db.get(planId) : null;
    const planIsPublished = Boolean(
      plan && plan.eventId === event._id && plan.status === "published",
    );
    const publishedPlanId = planIsPublished ? planId : undefined;
    const [
      venueCheckIn,
      venue,
      projections,
      physicalCredential,
      externalPassGrantIds,
      resultHistoryGrantIds,
    ] = await Promise.all([
      latestVenueCheckIn(ctx, membership._id),
      ctx.db
        .query("attendanceVenueStates")
        .withIndex("by_event_membership", (index) =>
          index.eq("eventId", event._id).eq("membershipId", membership._id),
        )
        .unique(),
      publishedPlanId
        ? ctx.db
            .query("attendanceParticipantCurrentSessions")
            .withIndex("by_membership_plan_start", (index) =>
              index.eq("membershipId", membership._id).eq("planVersionId", publishedPlanId),
            )
            .take(maximumAttendanceSessionsPerPlan + 1)
        : [],
      participantPhysicalCredential(ctx, membership._id, membership.participantClass),
      membership.participantClass === "external_participant"
        ? matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "attendance.external_pass.read",
            scopeType: "self",
            scopeId: membership._id,
          })
        : [],
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "attendance.remedy.self.read",
        scopeType: "self",
        scopeId: membership._id,
      }),
    ]);
    if (projections.length > maximumAttendanceSessionsPerPlan) {
      throw new ConvexError({
        code: "ATTENDANCE_PARTICIPANT_PROJECTION_INVALID",
        message: "The participant attendance schedule exceeds the published plan limit.",
      });
    }
    const projectedSessions = publishedPlanId
      ? await Promise.all(
          projections.map(async (projection) => {
            const session = await ctx.db.get(projection.sessionId);
            if (!session) {
              throw invalidParticipantProjection(
                "A projected attendance session no longer exists.",
              );
            }
            return await participantSessionView(ctx, {
              eventId: event._id,
              planVersionId: publishedPlanId,
              membershipId: membership._id,
              projection,
              session,
            });
          }),
        )
      : [];
    const currentSessions = projectedSessions.filter(
      (session) => session.status === "open" || session.status === "closing",
    );
    if (currentSessions.length > maximumSimultaneousAttendanceSessionsPerParticipant) {
      throw new ConvexError({
        code: "ATTENDANCE_SESSION_CONCURRENCY_LIMIT_REACHED",
        message: "The published attendance schedule has too many simultaneous sessions.",
      });
    }
    const nextSession = projectedSessions.find(
      (session) => session.status !== "open" && session.status !== "closing",
    );
    const sessions = [
      ...currentSessions.map((session) => ({ ...session, timing: "current" as const })),
      ...(nextSession ? [{ ...nextSession, timing: "upcoming" as const }] : []),
    ];
    return {
      available:
        membership.eligibilityStatus === "eligible" &&
        membership.onboardingStatus === "accepted" &&
        planIsPublished,
      canViewExternalPass: externalPassGrantIds.length > 0,
      canReadResultHistory: resultHistoryGrantIds.length > 0,
      physicalCredential,
      venueCheckIn: venueCheckIn
        ? {
            status: venueCheckIn.status,
            checkedInAt: venueCheckIn.checkedInAt,
            ...(venueCheckIn.reversedAt !== undefined
              ? { reversedAt: venueCheckIn.reversedAt }
              : {}),
          }
        : null,
      venue: venue ? { state: venue.state, updatedAt: venue.updatedAt } : null,
      sessions,
    };
  },
});

function invalidParticipantProjection(message: string) {
  return new ConvexError({
    code: "ATTENDANCE_PARTICIPANT_PROJECTION_INVALID",
    message: `${message} Ask an organizer to repair it.`,
  });
}

async function participantSessionView(
  ctx: QueryCtx,
  args: {
    eventId: Id<"events">;
    planVersionId: Id<"attendancePlanVersions">;
    membershipId: Id<"eventMemberships">;
    projection: Doc<"attendanceParticipantCurrentSessions">;
    session: Doc<"attendanceSessions">;
  },
) {
  const participant = await ctx.db.get(args.projection.sessionParticipantId);
  if (
    !participant ||
    args.projection.eventId !== args.eventId ||
    args.projection.membershipId !== args.membershipId ||
    args.projection.planVersionId !== args.planVersionId ||
    participant.eventId !== args.eventId ||
    participant.membershipId !== args.membershipId ||
    participant.sessionId !== args.session._id ||
    participant.completedAt !== undefined ||
    participant.result !== undefined ||
    args.session.eventId !== args.eventId ||
    args.session.planVersionId !== args.planVersionId ||
    args.session.startsAt !== args.projection.sessionStartsAt ||
    args.session.status === "closed" ||
    args.session.status === "cancelled"
  ) {
    throw invalidParticipantProjection("The current attendance schedule is inconsistent.");
  }
  const zone = await ctx.db.get(args.session.zoneId);
  if (!zone || zone.eventId !== args.eventId || zone.planVersionId !== args.planVersionId) {
    throw invalidParticipantProjection("The current attendance area is inconsistent.");
  }
  return {
    id: args.session._id,
    name: args.session.name,
    requirement: args.session.requirement,
    status: args.session.status,
    startsAt: args.session.startsAt,
    endsAt: args.session.endsAt,
    checkInOpensAt: args.session.checkInOpensAt,
    checkInClosesAt: args.session.checkInClosesAt,
    zoneName: zone.name,
    state: participant.state,
    late: participant.late,
    updatedAt: participant.updatedAt,
  };
}

async function participantPhysicalCredential(
  ctx: QueryCtx,
  membershipId: Id<"eventMemberships">,
  participantClass: "vit_student" | "external_participant",
): Promise<ParticipantPhysicalCredential> {
  if (participantClass === "vit_student") {
    const [active, suspended] = await Promise.all([
      ctx.db
        .query("attendanceCredentials")
        .withIndex("by_membership_state", (index) =>
          index.eq("membershipId", membershipId).eq("state", "active"),
        )
        .take(2),
      ctx.db
        .query("attendanceCredentials")
        .withIndex("by_membership_state", (index) =>
          index.eq("membershipId", membershipId).eq("state", "suspended"),
        )
        .take(2),
    ]);
    if (
      active.length > 1 ||
      suspended.length > 1 ||
      (active.length === 1 && suspended.length === 1) ||
      active[0]?.kind === "badge_qr" ||
      suspended[0]?.kind === "badge_qr"
    ) {
      throw new Error("A VIT participant must have at most one current VIT credential.");
    }
    return {
      kind: "vit_id_barcode",
      state: active.length === 1 ? "active" : suspended.length === 1 ? "suspended" : "not_enrolled",
    };
  }
  const pass = await ctx.db
    .query("attendanceExternalPasses")
    .withIndex("by_membership", (index) => index.eq("membershipId", membershipId))
    .unique();
  return {
    kind: "external_pass",
    state: pass?.state ?? "not_issued",
  };
}
