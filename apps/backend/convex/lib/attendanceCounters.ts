import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { operationFingerprint } from "./operations";

type SessionState = Doc<"attendanceSessionParticipants">["state"];
type VenueState = Doc<"attendanceVenueStates">["state"];

export function attendanceCounterShardFor(membershipId: Id<"eventMemberships">) {
  return Number.parseInt(operationFingerprint([membershipId]).slice(0, 8), 16) % 32;
}

export async function moveSessionCounter(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    sessionId: Id<"attendanceSessions">;
    membershipId: Id<"eventMemberships">;
    previousState: SessionState | null;
    nextState: SessionState;
    expectedDelta: 0 | 1;
    wasLate: boolean;
    isLate: boolean;
    now: number;
  },
) {
  if (
    args.previousState === args.nextState &&
    args.wasLate === args.isLate &&
    args.expectedDelta === 0
  ) {
    return;
  }
  const shard = attendanceCounterShardFor(args.membershipId);
  const current = await ctx.db
    .query("attendanceSessionCounterShards")
    .withIndex("by_session_shard", (index) =>
      index.eq("sessionId", args.sessionId).eq("shard", shard),
    )
    .unique();
  const expected = (current?.expected ?? 0) + args.expectedDelta;
  let confirmationDue = current?.confirmationDue ?? 0;
  let present = current?.present ?? 0;
  let temporarilyOut = current?.temporarilyOut ?? 0;
  let complete = current?.complete ?? 0;
  let excused = current?.excused ?? 0;
  let needsReview = current?.needsReview ?? 0;
  let late = current?.late ?? 0;
  const move = (state: SessionState, amount: -1 | 1) => {
    if (state === "confirmation_due") confirmationDue += amount;
    if (state === "present") present += amount;
    if (state === "temporarily_out") temporarilyOut += amount;
    if (state === "complete") complete += amount;
    if (state === "excused") excused += amount;
    if (state === "needs_review") needsReview += amount;
  };
  if (args.previousState !== null) move(args.previousState, -1);
  move(args.nextState, 1);
  if (args.wasLate !== args.isLate) late += args.isLate ? 1 : -1;
  if (
    [expected, confirmationDue, present, temporarilyOut, complete, excused, needsReview, late].some(
      (count) => count < 0,
    )
  ) {
    throw new Error("Attendance session counters would become negative.");
  }
  if (current) {
    await ctx.db.patch(current._id, {
      expected,
      confirmationDue,
      present,
      temporarilyOut,
      complete,
      excused,
      needsReview,
      late,
      version: current.version + 1,
      updatedAt: args.now,
    });
  } else {
    await ctx.db.insert("attendanceSessionCounterShards", {
      eventId: args.eventId,
      sessionId: args.sessionId,
      shard,
      expected,
      confirmationDue,
      present,
      temporarilyOut,
      complete,
      excused,
      needsReview,
      late,
      version: 1,
      updatedAt: args.now,
    });
  }
}

export async function moveZoneCounter(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    zoneId: Id<"attendanceZones">;
    membershipId: Id<"eventMemberships">;
    previousState: VenueState;
    nextState: VenueState;
    now: number;
  },
) {
  if (args.previousState === args.nextState) return;
  const shard = attendanceCounterShardFor(args.membershipId);
  const current = await ctx.db
    .query("attendanceZoneCounterShards")
    .withIndex("by_zone_shard", (index) =>
      index.eq("zoneId", args.zoneId).eq("shard", shard),
    )
    .unique();
  let inside = current?.inside ?? 0;
  let unknown = current?.unknown ?? 0;
  if (args.previousState === "inside") inside -= 1;
  if (args.previousState === "unknown") unknown -= 1;
  if (args.nextState === "inside") inside += 1;
  if (args.nextState === "unknown") unknown += 1;
  if (inside < 0 || unknown < 0) throw new Error("Attendance zone counters would become negative.");
  if (current) {
    await ctx.db.patch(current._id, {
      inside,
      unknown,
      version: current.version + 1,
      updatedAt: args.now,
    });
  } else {
    await ctx.db.insert("attendanceZoneCounterShards", {
      eventId: args.eventId,
      zoneId: args.zoneId,
      shard,
      inside,
      unknown,
      version: 1,
      updatedAt: args.now,
    });
  }
}
