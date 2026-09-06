import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { loadPublishedPhaseSchedule } from "./lib/phaseSchedule";
import { requirePermission } from "./lib/permissions";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireEligibleMembership,
  requireMembership,
} from "./lib/identity";
import {
  deleteParticipantServiceQueueEntry,
  insertParticipantServiceQueueEntry,
  participantServiceQueueStatus,
} from "./lib/participantServiceQueue";

type ReadCtx = QueryCtx | MutationCtx;

const serviceQueueKind = v.literal("outing_permission");

const serviceQueueView = v.object({
  kind: serviceQueueKind,
  opensAt: v.number(),
  closesAt: v.number(),
  joined: v.boolean(),
  position: v.union(v.null(), v.number()),
  waitingCount: v.number(),
  joinedAt: v.union(v.null(), v.number()),
});

async function participantContext(ctx: ReadCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const membership = requireEligibleMembership(
    await requireMembership(ctx, event._id, person._id),
  );
  return { event, person, membership };
}

async function queueWindow(ctx: ReadCtx, event: Doc<"events">) {
  if (event.status !== "live" && event.status !== "registration_closed")
    return null;
  const phases = await loadPublishedPhaseSchedule(ctx, event);
  const opensAt = phases?.windows[0]?.startsAt ?? event.startsAt;
  const closesAt = phases?.windows.at(-1)?.endsAt ?? event.endsAt;
  return opensAt !== undefined && closesAt !== undefined
    ? { opensAt, closesAt }
    : null;
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.array(serviceQueueView),
  handler: async (ctx, args) => {
    const { event, membership } = await participantContext(ctx, args.eventSlug);
    const window = await queueWindow(ctx, event);
    if (!window) return [];
    const ownEntry = await ctx.db
      .query("participantServiceQueueEntries")
      .withIndex("by_membership_kind", (index) =>
        index
          .eq("membershipId", membership._id)
          .eq("kind", "outing_permission"),
      )
      .unique();
    const status = await participantServiceQueueStatus(
      ctx,
      event._id,
      "outing_permission",
      ownEntry,
    );
    return [
      {
        kind: "outing_permission" as const,
        ...window,
        joined: ownEntry !== null,
        position: status.position,
        waitingCount: status.waitingCount,
        joinedAt: ownEntry?.joinedAt ?? null,
      },
    ];
  },
});

export const join = mutation({
  args: { eventSlug: v.string(), kind: serviceQueueKind },
  returns: v.object({ joined: v.boolean(), joinedAt: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership } = await participantContext(
      ctx,
      args.eventSlug,
    );
    const window = await queueWindow(ctx, event);
    const now = Date.now();
    if (!window || now < window.opensAt || now >= window.closesAt) {
      throw new ConvexError({
        code: "QUEUE_CLOSED",
        message:
          "The outing permission queue is available while the event is live.",
      });
    }
    const presence = await ctx.db
      .query("attendanceVenueStates")
      .withIndex("by_event_membership", (q) =>
        q.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    if (
      presence?.state === "temporarily_out" ||
      presence?.state === "departed"
    ) {
      throw new ConvexError({
        code: "ALREADY_OUTSIDE",
        message: "Scan your return before joining the washroom queue again.",
      });
    }
    const existing = await ctx.db
      .query("participantServiceQueueEntries")
      .withIndex("by_membership_kind", (index) =>
        index.eq("membershipId", membership._id).eq("kind", args.kind),
      )
      .unique();
    if (existing) return { joined: false, joinedAt: existing.joinedAt };
    const joinedAt = Date.now();
    await insertParticipantServiceQueueEntry(ctx, {
      eventId: event._id,
      membershipId: membership._id,
      personId: person._id,
      kind: args.kind,
      joinedAt,
    });
    return { joined: true, joinedAt };
  },
});

export const leave = mutation({
  args: { eventSlug: v.string(), kind: serviceQueueKind },
  returns: v.object({ left: v.boolean() }),
  handler: async (ctx, args) => {
    const { membership } = await participantContext(ctx, args.eventSlug);
    const existing = await ctx.db
      .query("participantServiceQueueEntries")
      .withIndex("by_membership_kind", (index) =>
        index.eq("membershipId", membership._id).eq("kind", args.kind),
      )
      .unique();
    if (!existing) return { left: false };
    await deleteParticipantServiceQueueEntry(ctx, existing);
    return { left: true };
  },
});

export const forStation = query({
  args: { eventSlug: v.string(), stationId: v.id("attendanceStations") },
  returns: v.object({
    waitingCount: v.number(),
    next: v.array(v.object({ displayName: v.string() })),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const station = await ctx.db.get(args.stationId);
    if (
      !station ||
      station.eventId !== event._id ||
      station.planVersionId !== event.publishedAttendancePlanVersionId ||
      station.status !== "active"
    ) {
      throw new ConvexError({
        code: "STATION_NOT_ACTIVE",
        message: "Use your assigned presence station.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.station.read",
      scopeType: "station",
      scopeId: station._id,
    });
    const status = await participantServiceQueueStatus(
      ctx,
      event._id,
      "outing_permission",
      null,
    );
    const entries = await ctx.db
      .query("participantServiceQueueEntries")
      .withIndex("by_event_kind_joined", (q) =>
        q.eq("eventId", event._id).eq("kind", "outing_permission"),
      )
      .take(3);
    const next = await Promise.all(
      entries.map(async (entry) => {
        const participant = await ctx.db.get(entry.personId);
        if (!participant) throw new Error("The queue participant is missing.");
        return { displayName: participant.displayName };
      }),
    );
    return { waitingCount: status.waitingCount, next };
  },
});
