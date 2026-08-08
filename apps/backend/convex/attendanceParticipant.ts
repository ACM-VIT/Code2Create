import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { requirePermission } from "./lib/permissions";
import { latestVenueCheckIn } from "./lib/venueCheckInLifecycle";
import { sessionPresenceState, venuePresenceState } from "./values";

type ParticipantPhysicalCredential =
  | {
      kind: "vit_id_barcode";
      state: "not_enrolled" | "active" | "suspended";
    }
  | {
      kind: "badge_qr";
      state: "not_issued" | "revoked";
    }
  | {
      kind: "badge_qr";
      state: "active";
      badgeReference: string;
    };

export const mine = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    available: v.boolean(),
    physicalCredential: v.union(
      v.object({
        kind: v.literal("vit_id_barcode"),
        state: v.union(
          v.literal("not_enrolled"),
          v.literal("active"),
          v.literal("suspended"),
        ),
      }),
      v.object({
        kind: v.literal("badge_qr"),
        state: v.union(v.literal("not_issued"), v.literal("revoked")),
      }),
      v.object({
        kind: v.literal("badge_qr"),
        state: v.literal("active"),
        badgeReference: v.string(),
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
        requirement: v.string(),
        status: v.string(),
        startsAt: v.number(),
        endsAt: v.number(),
        checkInOpensAt: v.number(),
        checkInClosesAt: v.number(),
        zoneName: v.string(),
        state: sessionPresenceState,
        late: v.boolean(),
        updatedAt: v.number(),
      }),
    ),
    recentEvents: v.array(
      v.object({
        id: v.id("attendancePresenceEvents"),
        outcome: v.string(),
        reasonCode: v.string(),
        transition: v.string(),
        receivedAt: v.number(),
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
    const [
      venueCheckIn,
      venue,
      sessionParticipants,
      recentEvents,
      memberCredentials,
    ] = await Promise.all([
      latestVenueCheckIn(ctx, membership._id),
      ctx.db
        .query("attendanceVenueStates")
        .withIndex("by_event_membership", (index) =>
          index.eq("eventId", event._id).eq("membershipId", membership._id),
        )
        .unique(),
      ctx.db
        .query("attendanceSessionParticipants")
        .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
        .collect(),
      ctx.db
        .query("attendancePresenceEvents")
        .withIndex("by_membership_time", (index) => index.eq("membershipId", membership._id))
        .order("desc")
        .take(5),
      ctx.db
        .query("attendanceCredentials")
        .withIndex("by_membership_state", (index) => index.eq("membershipId", membership._id))
        .collect(),
    ]);
    const sessions = [];
    for (const participant of sessionParticipants) {
      const session = await ctx.db.get(participant.sessionId);
      if (!session || session.eventId !== event._id || session.status === "cancelled") continue;
      const zone = await ctx.db.get(session.zoneId);
      if (!zone || zone.eventId !== event._id) continue;
      sessions.push({
        id: session._id,
        name: session.name,
        requirement: session.requirement,
        status: session.status,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        checkInOpensAt: session.checkInOpensAt,
        checkInClosesAt: session.checkInClosesAt,
        zoneName: zone.name,
        state: participant.state,
        late: participant.late,
        updatedAt: participant.updatedAt,
      });
    }
    sessions.sort((left, right) => left.startsAt - right.startsAt);
    const planId = event.publishedAttendancePlanVersionId;
    const plan = planId ? await ctx.db.get(planId) : null;
    const physicalCredential = participantPhysicalCredential(
      membership.participantClass,
      memberCredentials,
    );
    return {
      available: Boolean(
        membership.eligibilityStatus === "eligible" &&
          membership.onboardingStatus === "accepted" &&
          plan &&
          plan.eventId === event._id &&
          plan.status === "published",
      ),
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
      recentEvents: recentEvents.map((presenceEvent) => ({
        id: presenceEvent._id,
        outcome: presenceEvent.outcome,
        reasonCode: presenceEvent.reasonCode,
        transition: presenceEvent.transition,
        receivedAt: presenceEvent.receivedAt,
      })),
    };
  },
});

function participantPhysicalCredential(
  participantClass: "vit_student" | "external_participant",
  credentials: Doc<"attendanceCredentials">[],
): ParticipantPhysicalCredential {
  if (participantClass === "vit_student") {
    const current = credentials.find(
      (credential) =>
        credential.kind === "vit_id_barcode" &&
        (credential.state === "active" || credential.state === "suspended"),
    );
    return {
      kind: "vit_id_barcode",
      state:
        current?.state === "active"
          ? "active"
          : current?.state === "suspended"
            ? "suspended"
            : "not_enrolled",
    };
  }
  const active = credentials.find(
    (credential) => credential.kind === "badge_qr" && credential.state === "active",
  );
  if (active) {
    if (!active.badgeReference) {
      throw new Error("An active external badge must have a printed reference.");
    }
    return {
      kind: "badge_qr",
      state: "active",
      badgeReference: active.badgeReference,
    };
  }
  const wasRevoked = credentials.some(
    (credential) =>
      credential.kind === "badge_qr" &&
      credential.state === "revoked" &&
      credential.verifiedAt !== undefined,
  );
  return {
    kind: "badge_qr",
    state: wasRevoked ? "revoked" : "not_issued",
  };
}
