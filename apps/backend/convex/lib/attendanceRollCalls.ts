import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { attendanceCounterShardFor } from "./attendanceCounters";

export type RollCallState =
  | "not_arrived"
  | "inside"
  | "temporarily_out"
  | "departed"
  | "elsewhere"
  | "unknown";

export type RollCallCounts = {
  expected: number;
  notArrived: number;
  inside: number;
  temporarilyOut: number;
  departed: number;
  elsewhere: number;
  unknown: number;
};

type VenueProjection = {
  state: Doc<"attendanceVenueStates">["state"];
  zoneId?: Id<"attendanceZones">;
} | null;

export function emptyRollCallCounts(): RollCallCounts {
  return {
    expected: 0,
    notArrived: 0,
    inside: 0,
    temporarilyOut: 0,
    departed: 0,
    elsewhere: 0,
    unknown: 0,
  };
}

export function rollCallStateFor(
  venue: VenueProjection,
  zoneId: Id<"attendanceZones">,
): RollCallState {
  if (!venue || venue.state === "not_arrived") return "not_arrived";
  if (venue.state === "unknown") return "unknown";
  if (venue.state === "departed") return "departed";
  if (venue.zoneId !== zoneId) return "elsewhere";
  return venue.state;
}

export function moveRollCallCount(counts: RollCallCounts, state: RollCallState, amount: -1 | 1) {
  if (state === "not_arrived") counts.notArrived += amount;
  if (state === "inside") counts.inside += amount;
  if (state === "temporarily_out") counts.temporarilyOut += amount;
  if (state === "departed") counts.departed += amount;
  if (state === "elsewhere") counts.elsewhere += amount;
  if (state === "unknown") counts.unknown += amount;
}

export function totalRollCallStates(counts: RollCallCounts) {
  return (
    counts.notArrived +
    counts.inside +
    counts.temporarilyOut +
    counts.departed +
    counts.elsewhere +
    counts.unknown
  );
}

export function sumRollCallShards(
  shards: Array<Doc<"attendanceRollCallCounterShards">>,
): RollCallCounts {
  return shards.reduce<RollCallCounts>(
    (total, shard) => ({
      expected: total.expected + shard.expected,
      notArrived: total.notArrived + shard.notArrived,
      inside: total.inside + shard.inside,
      temporarilyOut: total.temporarilyOut + shard.temporarilyOut,
      departed: total.departed + shard.departed,
      elsewhere: total.elsewhere + shard.elsewhere,
      unknown: total.unknown + shard.unknown,
    }),
    emptyRollCallCounts(),
  );
}

export async function updateActiveRollCallsForVenueChange(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membershipId: Id<"eventMemberships">;
    previousVenue: VenueProjection;
    nextVenue: VenueProjection;
    now: number;
  },
) {
  const activeRollCalls = await ctx.db
    .query("attendanceRollCalls")
    .withIndex("by_event_state_started", (index) =>
      index.eq("eventId", args.eventId).eq("state", "active"),
    )
    .collect();
  for (const rollCall of activeRollCalls) {
    const participant = await ctx.db
      .query("attendanceSessionParticipants")
      .withIndex("by_session_membership", (index) =>
        index.eq("sessionId", rollCall.sessionId).eq("membershipId", args.membershipId),
      )
      .unique();
    if (!participant || participant.eventId !== args.eventId) continue;
    const previousState = rollCallStateFor(args.previousVenue, rollCall.zoneId);
    const nextState = rollCallStateFor(args.nextVenue, rollCall.zoneId);
    if (previousState === nextState) continue;
    const shard = attendanceCounterShardFor(args.membershipId);
    const current = await ctx.db
      .query("attendanceRollCallCounterShards")
      .withIndex("by_roll_call_shard", (index) =>
        index.eq("rollCallId", rollCall._id).eq("shard", shard),
      )
      .unique();
    if (!current) {
      throw new Error("Active roll-call counter shard is missing.");
    }
    const counts: RollCallCounts = {
      expected: current.expected,
      notArrived: current.notArrived,
      inside: current.inside,
      temporarilyOut: current.temporarilyOut,
      departed: current.departed,
      elsewhere: current.elsewhere,
      unknown: current.unknown,
    };
    moveRollCallCount(counts, previousState, -1);
    moveRollCallCount(counts, nextState, 1);
    if (
      Object.values(counts).some((count) => count < 0) ||
      totalRollCallStates(counts) !== counts.expected
    ) {
      throw new Error("Roll-call counters would become inconsistent.");
    }
    await ctx.db.patch(current._id, {
      ...counts,
      version: current.version + 1,
      updatedAt: args.now,
    });
  }
}
