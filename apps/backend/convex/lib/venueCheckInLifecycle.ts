import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { attendanceCounterShardFor } from "./attendanceCounters";
import { currentTeamForMembership } from "./floor";

type ReadCtx = QueryCtx | MutationCtx;
type VenueIdentityCheckMethod = Doc<"venueCheckIns">["identityCheckMethod"];

export async function activeVenueCheckIn(
  ctx: ReadCtx,
  eventId: Id<"events">,
  membershipId: Id<"eventMemberships">,
) {
  return ctx.db
    .query("venueCheckIns")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", eventId)
        .eq("membershipId", membershipId)
        .eq("status", "checked_in"),
    )
    .unique();
}

export async function latestVenueCheckIn(
  ctx: ReadCtx,
  membershipId: Id<"eventMemberships">,
) {
  return ctx.db
    .query("venueCheckIns")
    .withIndex("by_membership_time", (index) => index.eq("membershipId", membershipId))
    .order("desc")
    .first();
}

export async function recordStaffedVenueCheckIn(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membershipId: Id<"eventMemberships">;
    stationId: Id<"attendanceStations">;
    identityCheckMethod: VenueIdentityCheckMethod;
    checkInReason?: string;
    actorPersonId: Id<"people">;
    now: number;
  },
) {
  const [event, membership, station] = await Promise.all([
    ctx.db.get(args.eventId),
    ctx.db.get(args.membershipId),
    ctx.db.get(args.stationId),
  ]);
  if (!event) throw new Error("Venue check-in requires an event.");
  if (
    !membership ||
    membership.eventId !== event._id ||
    membership.eligibilityStatus !== "eligible" ||
    membership.onboardingStatus !== "accepted"
  ) {
    throw new ConvexError({
      code: "PARTICIPANT_NOT_CONFIRMED",
      message: "Only a participant on a confirmed team can check in at the venue.",
    });
  }
  if (
    !station ||
    station.eventId !== event._id ||
    station.planVersionId !== event.publishedAttendancePlanVersionId ||
    station.status !== "active"
  ) {
    throw new ConvexError({
      code: "ACTIVE_STATION_REQUIRED",
      message: "Use an active scanner station for staffed arrival check-in.",
    });
  }
  if (
    (membership.participantClass === "vit_student" &&
      args.identityCheckMethod === "external_photo_id") ||
    (membership.participantClass === "external_participant" &&
      args.identityCheckMethod === "vit_id")
  ) {
    throw new ConvexError({
      code: "IDENTITY_METHOD_MISMATCH",
      message: "The identity-check method does not match this participant class.",
    });
  }
  if (
    args.identityCheckMethod === "approved_exception" &&
    args.checkInReason === undefined
  ) {
    throw new Error("An approved identity exception requires its checked reason.");
  }
  const teamContext = await currentTeamForMembership(ctx, event._id, membership._id);
  if (
    !teamContext ||
    !["confirmed", "checked_in", "active"].some(
      (status) => status === teamContext.team.status,
    )
  ) {
    throw new ConvexError({
      code: "TEAM_NOT_CONFIRMED",
      message: "This participant's team has not confirmed its event offer.",
    });
  }
  const existing = await activeVenueCheckIn(ctx, event._id, membership._id);
  if (existing) {
    throw new ConvexError({
      code: "ALREADY_CHECKED_IN",
      message: "This participant is already checked in at the venue.",
    });
  }
  const credentials = await ctx.db
    .query("attendanceCredentials")
    .withIndex("by_membership_state", (index) =>
      index.eq("membershipId", membership._id).eq("state", "active"),
    )
    .collect();
  const activeCredential = credentials.find((credential) =>
    membership.participantClass === "vit_student"
      ? credential.kind === "vit_id_barcode"
      : credential.kind === "badge_qr",
  );
  if (activeCredential?.kind === "badge_qr" && !activeCredential.badgeReference) {
    throw new Error("An active external badge must have a printed reference.");
  }
  const checkInId = await ctx.db.insert("venueCheckIns", {
    eventId: event._id,
    membershipId: membership._id,
    stationId: station._id,
    zoneId: station.zoneId,
    identityCheckMethod: args.identityCheckMethod,
    ...(activeCredential
      ? {
          credentialId: activeCredential._id,
          credentialKind: activeCredential.kind,
          credentialVersion: activeCredential.version,
        }
      : {}),
    ...(activeCredential?.kind === "badge_qr"
      ? { badgeReference: activeCredential.badgeReference }
      : {}),
    status: "checked_in",
    checkedInByPersonId: args.actorPersonId,
    checkedInAt: args.now,
    ...(args.checkInReason !== undefined ? { checkInReason: args.checkInReason } : {}),
    version: 1,
  });
  await moveVenueCheckInCounter(ctx, {
    eventId: event._id,
    membershipId: membership._id,
    delta: 1,
    now: args.now,
  });
  const teamStatusChanged = await advanceTeamCheckInMilestone(ctx, {
    eventId: event._id,
    team: teamContext.team,
    now: args.now,
  });
  return {
    checkInId,
    checkedInAt: args.now,
    version: 1,
    identityCheckMethod: args.identityCheckMethod,
    teamStatusChanged,
  };
}

export async function reverseStaffedVenueCheckIn(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    checkInId: Id<"venueCheckIns">;
    expectedVersion: number;
    actorPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  const checkIn = await ctx.db.get(args.checkInId);
  if (!checkIn || checkIn.eventId !== args.eventId) {
    throw new ConvexError({
      code: "VENUE_CHECK_IN_NOT_FOUND",
      message: "Venue check-in not found.",
    });
  }
  if (checkIn.status !== "checked_in" || checkIn.version !== args.expectedVersion) {
    throw new ConvexError({
      code: "VENUE_CHECK_IN_CHANGED",
      message: "The venue check-in changed. Refresh before reversing it.",
    });
  }
  const membership = await ctx.db.get(checkIn.membershipId);
  if (!membership || membership.eventId !== args.eventId) {
    throw new Error("A venue check-in must resolve its event membership.");
  }
  const version = checkIn.version + 1;
  await ctx.db.patch(checkIn._id, {
    status: "reversed",
    reversedByPersonId: args.actorPersonId,
    reversedAt: args.now,
    reversalReason: args.reason,
    version,
  });
  await moveVenueCheckInCounter(ctx, {
    eventId: args.eventId,
    membershipId: membership._id,
    delta: -1,
    now: args.now,
  });
  const teamContext = await currentTeamForMembership(ctx, args.eventId, membership._id);
  let teamStatusChanged = false;
  if (teamContext?.team.status === "checked_in") {
    await ctx.db.patch(teamContext.team._id, {
      status: "confirmed",
      version: teamContext.team.version + 1,
      updatedAt: args.now,
    });
    teamStatusChanged = true;
  }
  return {
    checkInId: checkIn._id,
    membershipId: membership._id,
    reversedAt: args.now,
    version,
    teamStatusChanged,
  };
}

async function moveVenueCheckInCounter(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membershipId: Id<"eventMemberships">;
    delta: -1 | 1;
    now: number;
  },
) {
  const shard = attendanceCounterShardFor(args.membershipId);
  const current = await ctx.db
    .query("venueCheckInCounterShards")
    .withIndex("by_event_shard", (index) =>
      index.eq("eventId", args.eventId).eq("shard", shard),
    )
    .unique();
  const checkedIn = (current?.checkedIn ?? 0) + args.delta;
  if (checkedIn < 0) throw new Error("Venue check-in counters would become negative.");
  if (current) {
    await ctx.db.patch(current._id, {
      checkedIn,
      version: current.version + 1,
      updatedAt: args.now,
    });
    return;
  }
  if (args.delta !== 1) {
    throw new Error("A venue check-in counter shard must exist before reversal.");
  }
  await ctx.db.insert("venueCheckInCounterShards", {
    eventId: args.eventId,
    shard,
    checkedIn,
    version: 1,
    updatedAt: args.now,
  });
}

async function advanceTeamCheckInMilestone(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    team: Doc<"teams">;
    now: number;
  },
) {
  if (args.team.status !== "confirmed") return false;
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_team_status", (index) =>
      index.eq("teamId", args.team._id).eq("status", "active"),
    )
    .collect();
  if (members.length === 0) throw new Error("A confirmed team must have an active member.");
  for (const member of members) {
    const checkIn = await activeVenueCheckIn(ctx, args.eventId, member.membershipId);
    if (!checkIn) return false;
  }
  await ctx.db.patch(args.team._id, {
    status: "checked_in",
    version: args.team.version + 1,
    updatedAt: args.now,
  });
  return true;
}
