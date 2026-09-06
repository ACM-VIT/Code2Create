import { TableAggregate } from "@convex-dev/aggregate";
import type { Infer } from "convex/values";
import type { AttendanceMovementReason } from "@code2create/domain";

import { components, internal } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { outingDurationMs, outingScanDecision } from "./outingValues";
import { loadPublishedPhaseSchedule } from "./phaseSchedule";
import { latestVenueCheckIn } from "./venueCheckInLifecycle";

type Entry = Doc<"participantServiceQueueEntries">;
type ReadCtx = QueryCtx | MutationCtx;
type OutingScanResult =
  | { allowed: true; outing: Infer<typeof outingScanDecision> | null }
  | { allowed: false; outing: Infer<typeof outingScanDecision> };

// Only waiting requests enter the rank projection; permissions occupy capacity.
const waiting = new TableAggregate<{
  Namespace: Id<"events">;
  Key: [number, number];
  DataModel: DataModel;
  TableName: "participantServiceQueueEntries";
}>(components.participantServiceQueues, {
  namespace: (entry) => entry.eventId,
  sortKey: (entry) => [entry.joinedAt, entry._creationTime],
});

export async function outingWindow(ctx: ReadCtx, event: Doc<"events">) {
  if (event.status !== "live" && event.status !== "registration_closed") return null;
  const phases = await loadPublishedPhaseSchedule(ctx, event);
  const opensAt = phases?.windows[0]?.startsAt ?? event.startsAt;
  const closesAt = phases?.windows.at(-1)?.endsAt ?? event.endsAt;
  return opensAt !== undefined && closesAt !== undefined ? { opensAt, closesAt } : null;
}

export function outingPolicy(ctx: ReadCtx, eventId: Id<"events">) {
  return ctx.db.query("outingPolicies").withIndex("by_event", (q) => q.eq("eventId", eventId)).unique();
}

export function outingRequest(ctx: ReadCtx, membershipId: Id<"eventMemberships">) {
  return ctx.db.query("participantServiceQueueEntries")
    .withIndex("by_membership_kind", (q) => q.eq("membershipId", membershipId).eq("kind", "outing_permission"))
    .unique();
}

export async function participantIsOnsite(ctx: ReadCtx, membershipId: Id<"eventMemberships">, eventId: Id<"events">) {
  const venue = await ctx.db.query("attendanceVenueStates")
    .withIndex("by_event_membership", (q) => q.eq("eventId", eventId).eq("membershipId", membershipId)).unique();
  if (venue && venue.state !== "not_arrived") return venue.state === "inside";
  return (await latestVenueCheckIn(ctx, membershipId))?.status === "checked_in";
}

export async function participantServiceQueueStatus(ctx: ReadCtx, eventId: Id<"events">, entry: Entry | null) {
  return {
    waitingCount: await waiting.count(ctx, { namespace: eventId }),
    position: entry?.phase.status === "waiting" ? (await waiting.indexOfDoc(ctx, entry)) + 1 : null,
  };
}

export async function insertParticipantServiceQueueEntry(ctx: MutationCtx, value: Omit<Entry, "_id" | "_creationTime">) {
  const id = await ctx.db.insert("participantServiceQueueEntries", value);
  const entry = await ctx.db.get(id);
  if (!entry) throw new Error("The outing request did not persist.");
  if (entry.phase.status === "waiting") await waiting.insert(ctx, entry);
  return entry;
}

export async function deleteParticipantServiceQueueEntry(ctx: MutationCtx, entry: Entry) {
  if (entry.phase.status === "waiting") await waiting.delete(ctx, entry);
  if (["permitted", "out", "overdue"].includes(entry.phase.status)) {
    const policy = await outingPolicy(ctx, entry.eventId);
    if (!policy || policy.occupiedCount < 1) throw new Error("Outing capacity is inconsistent.");
    await ctx.db.patch(policy._id, { occupiedCount: policy.occupiedCount - 1 });
  }
  await ctx.db.delete(entry._id);
}

/** Every allocator serializes on the same event policy; rank order is indexed. */
export async function fillOutingCapacity(ctx: MutationCtx, eventId: Id<"events">, now: number) {
  const event = await ctx.db.get(eventId);
  const policy = await outingPolicy(ctx, eventId);
  const window = event ? await outingWindow(ctx, event) : null;
  if (!window || now < window.opensAt || now >= window.closesAt || !policy || policy.occupiedCount >= policy.capacity) return;
  const candidates = await ctx.db.query("participantServiceQueueEntries")
    .withIndex("by_event_phase_joinedAt", (q) => q.eq("eventId", eventId).eq("phase.status", "waiting"))
    .take(25);
  let occupied = policy.occupiedCount;
  for (const entry of candidates) {
    if (occupied >= policy.capacity) break;
    const membership = await ctx.db.get(entry.membershipId);
    const person = await ctx.db.get(entry.personId);
    if (!membership || membership.onboardingStatus !== "accepted" ||
        membership.eligibilityStatus !== "eligible" || person?.status !== "active" ||
        !(await participantIsOnsite(ctx, entry.membershipId, eventId))) {
      await deleteParticipantServiceQueueEntry(ctx, entry);
      continue;
    }
    await waiting.delete(ctx, entry);
    const expiresAt = Math.min(now + outingDurationMs, window.closesAt);
    await ctx.db.patch(entry._id, { phase: { status: "permitted", expiresAt } });
    await ctx.scheduler.runAt(expiresAt, internal.serviceQueues.advanceDeadline, { entryId: entry._id });
    occupied += 1;
  }
  await ctx.db.patch(policy._id, { occupiedCount: occupied });
  if (candidates.length === 25 && occupied < policy.capacity) {
    await ctx.scheduler.runAfter(0, internal.serviceQueues.fillCapacity, { eventId });
  }
}

export async function expireOutingPermission(ctx: MutationCtx, entry: Entry, now: number) {
  if (entry.phase.status !== "permitted" || entry.phase.expiresAt > now) return;
  const policy = await outingPolicy(ctx, entry.eventId);
  if (!policy || policy.occupiedCount < 1) throw new Error("Outing capacity is inconsistent.");
  await ctx.db.patch(entry._id, { phase: { status: "expired" } });
  await ctx.db.patch(policy._id, { occupiedCount: policy.occupiedCount - 1 });
  await fillOutingCapacity(ctx, entry.eventId, now);
}

/** Called only after attendance accepts the proposed movement, within its transaction. */
export async function applyOutingScan(ctx: MutationCtx, args: {
  movementReason: AttendanceMovementReason;
  eventId: Id<"events">;
  membershipId: Id<"eventMemberships">;
  transition: "venue_entry" | "venue_exit" | "zone_entry" | "zone_exit" | "session_confirm";
  isOfflineReplay: boolean;
  sessionId?: Id<"attendanceSessions">;
  now: number;
}): Promise<OutingScanResult> {
  const entry = await outingRequest(ctx, args.membershipId);
  const leaving = args.transition === "venue_exit" || args.transition === "zone_exit";
  const returning = args.transition === "venue_entry" || args.transition === "zone_entry";
  if (!leaving && !returning) return { allowed: true, outing: null };
  if (returning) {
    if (!entry || (entry.phase.status !== "out" && entry.phase.status !== "overdue")) {
      return { allowed: true, outing: null };
    }
    if (entry.phase.returnTransition !== args.transition || entry.phase.sessionId !== args.sessionId) {
      return { allowed: true, outing: null };
    }
    const returnBy = entry.phase.returnBy;
    await deleteParticipantServiceQueueEntry(ctx, entry);
    await fillOutingCapacity(ctx, args.eventId, args.now);
    return { allowed: true, outing: { status: "returned", position: null, returnBy } };
  }
  if (args.movementReason !== "short_break") {
    if (entry) {
      await deleteParticipantServiceQueueEntry(ctx, entry);
      await fillOutingCapacity(ctx, args.eventId, args.now);
    }
    return { allowed: true, outing: null };
  }
  // Offline evidence cannot authorize a short break against historical capacity.
  if (args.isOfflineReplay) {
    return { allowed: false, outing: { status: "online_required", position: null, returnBy: null } };
  }
  const event = await ctx.db.get(args.eventId);
  const window = event ? await outingWindow(ctx, event) : null;
  if (!window || args.now < window.opensAt || args.now >= window.closesAt) return { allowed: true, outing: null };
  const policy = await outingPolicy(ctx, args.eventId);
  if (!policy) return { allowed: false, outing: { status: "unconfigured", position: null, returnBy: null } };
  if (!entry) return { allowed: false, outing: { status: "required", position: null, returnBy: null } };
  if (entry.phase.status === "permitted" && entry.phase.expiresAt <= args.now) {
    await expireOutingPermission(ctx, entry, args.now);
    return { allowed: false, outing: { status: "expired", position: null, returnBy: null } };
  }
  if (entry.phase.status === "waiting") {
    const { position } = await participantServiceQueueStatus(ctx, args.eventId, entry);
    if (position === null) throw new Error("A waiting outing must have a queue position.");
    return { allowed: false, outing: { status: "waiting", position, returnBy: null } };
  }
  if (entry.phase.status === "expired") {
    return { allowed: false, outing: { status: "expired", position: null, returnBy: null } };
  }
  if (entry.phase.status === "out" || entry.phase.status === "overdue") {
    return { allowed: true, outing: {
      status: entry.phase.returnBy <= args.now ? "overdue" : "out",
      position: null, returnBy: entry.phase.returnBy,
    } };
  }
  const returnBy = args.now + outingDurationMs;
  await ctx.db.patch(entry._id, { phase: {
    status: "out", departedAt: args.now, returnBy,
    returnTransition: args.transition === "zone_exit" ? "zone_entry" : "venue_entry",
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
  } });
  await ctx.scheduler.runAt(returnBy, internal.serviceQueues.advanceDeadline, { entryId: entry._id });
  return { allowed: true, outing: { status: "out", position: null, returnBy } };
}
