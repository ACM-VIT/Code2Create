import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type ReadCtx = QueryCtx | MutationCtx;
type VenueState = Doc<"attendanceVenueStates">["state"];

export async function readAttendanceTeamAvailability(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
  },
) {
  const availability = await ctx.db
    .query("attendanceTeamAvailability")
    .withIndex("by_event_team", (index) =>
      index.eq("eventId", args.eventId).eq("teamId", args.teamId),
    )
    .unique();
  if (!availability) {
    throw new Error("A confirmed team has no attendance-availability projection.");
  }
  return availability;
}

export async function initializeAttendanceTeamAvailability(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    activeMemberCount: number;
    now: number;
  },
) {
  if (!Number.isSafeInteger(args.activeMemberCount) || args.activeMemberCount < 1) {
    throw new Error("A confirmed team must have at least one active member.");
  }
  const existing = await ctx.db
    .query("attendanceTeamAvailability")
    .withIndex("by_event_team", (index) =>
      index.eq("eventId", args.eventId).eq("teamId", args.teamId),
    )
    .unique();
  if (existing) {
    throw new Error("A team attendance-availability projection already exists.");
  }
  return ctx.db.insert("attendanceTeamAvailability", {
    eventId: args.eventId,
    teamId: args.teamId,
    activeMemberCount: args.activeMemberCount,
    insideMemberCount: 0,
    version: 1,
    updatedAt: args.now,
  });
}

export async function moveAttendanceTeamAvailability(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membershipId: Id<"eventMemberships">;
    previousState: VenueState;
    nextState: VenueState;
    now: number;
  },
) {
  const wasInside = args.previousState === "inside";
  const isInside = args.nextState === "inside";
  if (wasInside === isInside) return;

  const teamMember = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", args.eventId)
        .eq("membershipId", args.membershipId)
        .eq("status", "active"),
    )
    .unique();
  if (!teamMember) {
    throw new Error("An accepted attendance participant has no active team membership.");
  }
  const availability = await readAttendanceTeamAvailability(ctx, {
    eventId: args.eventId,
    teamId: teamMember.teamId,
  });
  const insideMemberCount =
    availability.insideMemberCount + (isInside ? 1 : -1);
  if (
    insideMemberCount < 0 ||
    insideMemberCount > availability.activeMemberCount
  ) {
    throw new Error("The team attendance-availability projection is inconsistent.");
  }
  await ctx.db.patch(availability._id, {
    insideMemberCount,
    version: availability.version + 1,
    updatedAt: args.now,
  });
}
