import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";

import { internalMutation, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEligibleMembership, requireMembership, requireEventSubject } from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { outingDurationMs, outingPhase } from "./lib/outingValues";
import {
  deleteParticipantServiceQueueEntry, insertParticipantServiceQueueEntry,
  participantServiceQueueStatus, outingPolicy, outingRequest, participantIsOnsite,
  fillOutingCapacity, expireOutingPermission, outingWindow,
} from "./lib/participantServiceQueue";

const serviceQueueKind = v.literal("outing_permission");
const serviceQueueView = v.object({
  kind: serviceQueueKind,
  opensAt: v.number(), closesAt: v.number(),
  requestId: v.union(v.id("participantServiceQueueEntries"), v.null()),
  status: v.union(v.literal("available"), v.literal("waiting"), v.literal("permitted"),
    v.literal("out"), v.literal("overdue"), v.literal("expired"), v.literal("unconfigured"), v.literal("offsite")),
  position: v.union(v.null(), v.number()),
  waitingCount: v.number(),
  capacity: v.union(v.null(), v.number()),
  occupiedCount: v.number(),
  permissionExpiresAt: v.union(v.null(), v.number()),
  returnBy: v.union(v.null(), v.number()),
  canRequest: v.boolean(),
  serverNow: v.number(),
});

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.array(serviceQueueView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const membership = requireEligibleMembership(await requireMembership(ctx, event._id, person._id));
    if (membership.onboardingStatus !== "accepted") return [];
    const entry = await outingRequest(ctx, membership._id);
    const window = await outingWindow(ctx, event);
    if (!window) return [];
    const policy = await outingPolicy(ctx, event._id);
    const onsite = await participantIsOnsite(ctx, membership._id, event._id);
    const queue = await participantServiceQueueStatus(ctx, event._id, entry);
    const now = Date.now();
    const phase = entry?.phase;
    const status: Infer<typeof serviceQueueView>["status"] = phase?.status === "permitted" && phase.expiresAt <= now ? "expired"
      : phase?.status === "out" && phase.returnBy <= now ? "overdue"
      : phase?.status ?? (!policy ? "unconfigured" : onsite ? "available" : "offsite");
    return [{
      kind: "outing_permission" as const, ...window, requestId: entry?._id ?? null, status,
      ...queue, capacity: policy?.capacity ?? null, occupiedCount: policy?.occupiedCount ?? 0,
      permissionExpiresAt: phase?.status === "permitted" ? phase.expiresAt : null,
      returnBy: phase?.status === "out" || phase?.status === "overdue" ? phase.returnBy : null,
      canRequest: now >= window.opensAt && now < window.closesAt && policy !== null && onsite && (!entry || status === "expired"),
      serverNow: now,
    }];
  },
});

export const join = mutation({
  args: { eventSlug: v.string(), kind: serviceQueueKind, clientOperationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const membership = requireEligibleMembership(await requireMembership(ctx, event._id, person._id));
    const operation = {
      eventId: event._id, actorPersonId: person._id, clientOperationId: args.clientOperationId,
      commandName: "outing.request", requestFingerprint: operationFingerprint([args.kind]),
    };
    if (await findOperation(ctx, operation)) return null;
    const now = Date.now();
    const window = await outingWindow(ctx, event);
    if (!window || now < window.opensAt || now >= window.closesAt || membership.onboardingStatus !== "accepted") {
      throw new ConvexError({ code: "QUEUE_CLOSED", message: "Outing requests are available to confirmed participants while the event is live." });
    }
    if (!(await outingPolicy(ctx, event._id))) {
      throw new ConvexError({ code: "OUTING_NOT_CONFIGURED", message: "Staff have not configured outing capacity yet." });
    }
    let entry = await outingRequest(ctx, membership._id);
    if (entry?.phase.status === "permitted" && entry.phase.expiresAt <= now) {
      await expireOutingPermission(ctx, entry, now);
      entry = await outingRequest(ctx, membership._id);
    }
    if (!entry || entry.phase.status === "expired") {
      if (!(await participantIsOnsite(ctx, membership._id, event._id))) {
        throw new ConvexError({ code: "OUTING_NOT_PRESENT", message: "Check in or have your return scanned before requesting an outing." });
      }
      if (entry) await deleteParticipantServiceQueueEntry(ctx, entry);
      entry = await insertParticipantServiceQueueEntry(ctx, {
        eventId: event._id, membershipId: membership._id, personId: person._id,
        kind: args.kind, joinedAt: now, phase: { status: "waiting" },
      });
      await fillOutingCapacity(ctx, event._id, now);
    }
    await recordOperation(ctx, { ...operation, targetType: "outing_request", targetId: entry._id, createdAt: now });
    return null;
  },
});

export const leave = mutation({
  args: { eventSlug: v.string(), requestId: v.id("participantServiceQueueEntries"), clientOperationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const membership = requireEligibleMembership(await requireMembership(ctx, event._id, person._id));
    const operation = {
      eventId: event._id, actorPersonId: person._id, clientOperationId: args.clientOperationId,
      commandName: "outing.cancel", requestFingerprint: operationFingerprint([args.requestId]),
    };
    if (await findOperation(ctx, operation)) return null;
    const entry = await outingRequest(ctx, membership._id);
    if (entry?._id !== args.requestId) throw new ConvexError({ code: "STALE_REQUEST", message: "This outing request has already changed." });
    if (entry.phase.status === "out" || entry.phase.status === "overdue") {
      throw new ConvexError({ code: "RETURN_SCAN_REQUIRED", message: "Have your ID scanned on return to release your outing slot." });
    }
    await deleteParticipantServiceQueueEntry(ctx, entry);
    await fillOutingCapacity(ctx, event._id, Date.now());
    await recordOperation(ctx, { ...operation, targetType: "outing_request", targetId: args.requestId, createdAt: Date.now() });
    return null;
  },
});

export const configuration = query({
  args: { eventSlug: v.string() },
  returns: v.object({ capacity: v.union(v.number(), v.null()), occupiedCount: v.number(), waitingCount: v.number(), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, { eventId: event._id, eventAccessSubjectId: subject._id, permissionKey: "configuration.manage", scopeType: "event" });
    const policy = await outingPolicy(ctx, event._id);
    const queue = await participantServiceQueueStatus(ctx, event._id, null);
    return { capacity: policy?.capacity ?? null, occupiedCount: policy?.occupiedCount ?? 0, waitingCount: queue.waitingCount, version: policy?.version ?? 0 };
  },
});

export const configure = mutation({
  args: { eventSlug: v.string(), capacity: v.number(), expectedVersion: v.number(), clientOperationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, { eventId: event._id, eventAccessSubjectId: subject._id, permissionKey: "configuration.manage", scopeType: "event" });
    const operation = {
      eventId: event._id, actorPersonId: person._id, clientOperationId: args.clientOperationId,
      commandName: "outing.configure", requestFingerprint: operationFingerprint([args.capacity, args.expectedVersion]),
    };
    if (await findOperation(ctx, operation)) return null;
    if (!Number.isSafeInteger(args.capacity) || args.capacity < 1 || args.capacity > 1000) {
      throw new ConvexError({ code: "INVALID_CAPACITY", message: "Set outing capacity to a whole number from 1 to 1,000." });
    }
    const policy = await outingPolicy(ctx, event._id);
    if ((policy?.version ?? 0) !== args.expectedVersion) throw new ConvexError({ code: "STALE_VERSION", message: "Outing capacity changed. Reload the current setting and try again." });
    const now = Date.now();
    const id = policy ? policy._id : await ctx.db.insert("outingPolicies", {
      eventId: event._id, capacity: args.capacity, occupiedCount: 0, version: 1, updatedAt: now,
    });
    if (policy) await ctx.db.patch(policy._id, { capacity: args.capacity, version: policy.version + 1, updatedAt: now });
    await fillOutingCapacity(ctx, event._id, now);
    await writeAuditEvent(ctx, {
      eventId: event._id, actorPersonId: person._id, permissionKey: "configuration.manage", grantIds,
      scopeType: "event", action: "outing.capacity_changed", targetType: "outing_policy", targetId: id,
      previousSummary: JSON.stringify({ capacity: policy?.capacity ?? null }),
      nextSummary: JSON.stringify({ capacity: args.capacity, durationMinutes: outingDurationMs / 60_000 }),
      reason: "Updated the maximum number of simultaneous outings",
    });
    await recordOperation(ctx, { ...operation, targetType: "outing_policy", targetId: id, createdAt: now });
    return null;
  },
});

export const roster = query({
  args: { eventSlug: v.string(), status: v.union(v.literal("waiting"), v.literal("permitted"), v.literal("out"), v.literal("overdue")), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ id: v.id("participantServiceQueueEntries"), name: v.string(), phase: outingPhase, joinedAt: v.number() })),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, { eventId: event._id, eventAccessSubjectId: subject._id, permissionKey: "configuration.manage", scopeType: "event" });
    const result = await ctx.db.query("participantServiceQueueEntries")
      .withIndex("by_event_phase_joinedAt", (q) => q.eq("eventId", event._id).eq("phase.status", args.status)).paginate(args.paginationOpts);
    return { ...result, page: await Promise.all(result.page.map(async (entry) => {
      const person = await ctx.db.get(entry.personId);
      return { id: entry._id, name: person?.displayName ?? "Participant", phase: entry.phase, joinedAt: entry.joinedAt };
    })) };
  },
});

export const fillCapacity = internalMutation({
  args: { eventId: v.id("events") }, returns: v.null(),
  handler: async (ctx, args) => { await fillOutingCapacity(ctx, args.eventId, Date.now()); return null; },
});

export const advanceDeadline = internalMutation({
  args: { entryId: v.id("participantServiceQueueEntries") }, returns: v.null(),
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.entryId);
    if (!entry) return null;
    const now = Date.now();
    if (entry.phase.status === "permitted") await expireOutingPermission(ctx, entry, now);
    if (entry.phase.status === "out" && entry.phase.returnBy <= now) {
      await ctx.db.patch(entry._id, { phase: { ...entry.phase, status: "overdue" } });
    }
    return null;
  },
});

export const forStation = query({
  args: { eventSlug: v.string(), stationId: v.id("attendanceStations") },
  returns: v.union(v.null(), v.object({
    capacity: v.union(v.number(), v.null()), occupiedCount: v.number(), waitingCount: v.number(),
    next: v.array(v.object({ displayName: v.string() })),
  })),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const station = await ctx.db.get(args.stationId);
    if (!station || station.eventId !== event._id || station.planVersionId !== event.publishedAttendancePlanVersionId) {
      return null;
    }
    // Outing status follows event scanner access, not the retired station-claim lifecycle.
    const grants = await matchingPermissionGrantIds(ctx, {
      eventId: event._id, eventAccessSubjectId: subject._id,
      permissionKey: "attendance.scan.execute", scopeType: "event",
    });
    if (grants.length === 0) return null;
    const policy = await outingPolicy(ctx, event._id);
    const status = await participantServiceQueueStatus(ctx, event._id, null);
    const entries = await ctx.db.query("participantServiceQueueEntries")
      .withIndex("by_event_phase_joinedAt", (q) => q.eq("eventId", event._id).eq("phase.status", "waiting")).take(3);
    const next = await Promise.all(entries.map(async (entry) => {
      const participant = await ctx.db.get(entry.personId);
      if (!participant) throw new Error("The queue participant is missing.");
      return { displayName: participant.displayName };
    }));
    return { capacity: policy?.capacity ?? null, occupiedCount: policy?.occupiedCount ?? 0, waitingCount: status.waitingCount, next };
  },
});
