import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { operationFingerprint } from "./operations";

type SessionState = Doc<"attendanceSessionParticipants">["state"];
type VenueState = Doc<"attendanceVenueStates">["state"];

export const attendanceCounterShardCount = 32;

export function attendanceCounterShardFor(membershipId: Id<"eventMemberships">) {
  return (
    Number.parseInt(operationFingerprint([membershipId]).slice(0, 8), 16) %
    attendanceCounterShardCount
  );
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
    membershipId: Id<"eventMemberships">;
    previousState: VenueState;
    previousZoneId?: Id<"attendanceZones">;
    nextState: VenueState;
    nextZoneId?: Id<"attendanceZones">;
    now: number;
  },
) {
  const counted = (state: VenueState) => state === "inside" || state === "unknown";
  if (counted(args.previousState) && args.previousZoneId === undefined) {
    throw new Error("A counted attendance venue state must own a zone.");
  }
  if (counted(args.nextState) && args.nextZoneId === undefined) {
    throw new Error("A counted attendance venue state must own a zone.");
  }
  if (
    args.previousState === args.nextState &&
    args.previousZoneId === args.nextZoneId
  ) {
    return;
  }
  const shard = attendanceCounterShardFor(args.membershipId);
  const deltas = new Map<Id<"attendanceZones">, { inside: number; unknown: number }>();
  const add = (
    zoneId: Id<"attendanceZones"> | undefined,
    state: VenueState,
    amount: -1 | 1,
  ) => {
    if (!counted(state)) return;
    if (zoneId === undefined) throw new Error("A counted attendance venue state has no zone.");
    const delta = deltas.get(zoneId) ?? { inside: 0, unknown: 0 };
    if (state === "inside") delta.inside += amount;
    if (state === "unknown") delta.unknown += amount;
    deltas.set(zoneId, delta);
  };
  add(args.previousZoneId, args.previousState, -1);
  add(args.nextZoneId, args.nextState, 1);

  for (const [zoneId, delta] of deltas) {
    if (delta.inside === 0 && delta.unknown === 0) continue;
    const current = await ctx.db
      .query("attendanceZoneCounterShards")
      .withIndex("by_zone_shard", (index) =>
        index.eq("zoneId", zoneId).eq("shard", shard),
      )
      .unique();
    const inside = (current?.inside ?? 0) + delta.inside;
    const unknown = (current?.unknown ?? 0) + delta.unknown;
    if (inside < 0 || unknown < 0) {
      throw new Error("Attendance zone counters would become negative.");
    }
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
        zoneId,
        shard,
        inside,
        unknown,
        version: 1,
        updatedAt: args.now,
      });
    }
  }
}
