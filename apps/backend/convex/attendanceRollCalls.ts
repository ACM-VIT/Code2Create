import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { attendanceCounterShardFor } from "./lib/attendanceCounters";
import {
  emptyRollCallCounts,
  moveRollCallCount,
  rollCallStateFor,
  sumRollCallShards,
  totalRollCallStates,
  type RollCallCounts,
} from "./lib/attendanceRollCalls";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
  type OperationFingerprintPart,
} from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import {
  attendanceSessionExpectation,
  rollCallPresenceState,
} from "./values";

const rollCallKind = v.union(v.literal("incident"), v.literal("drill"));
const rollCallState = v.union(v.literal("active"), v.literal("closed"));
const closedRollCallState = "closed" as const;
const rollCallCounts = v.object({
  expected: v.number(),
  notArrived: v.number(),
  inside: v.number(),
  temporarilyOut: v.number(),
  departed: v.number(),
  elsewhere: v.number(),
  unknown: v.number(),
});

function assertCounts(counts: RollCallCounts) {
  if (
    Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0) ||
    totalRollCallStates(counts) !== counts.expected
  ) {
    throw new Error("Roll-call counts are inconsistent.");
  }
}

export const start = mutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    expectedSessionVersion: v.number(),
    kind: rollCallKind,
    name: v.string(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    rollCallId: v.id("attendanceRollCalls"),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const name = normalizedText(args.name, "Roll-call name", 3, 100);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.sessionId,
      args.expectedSessionVersion,
      args.kind,
      name,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.roll_call.start",
      requestFingerprint,
    });
    if (prior) {
      const rollCallId = ctx.db.normalizeId("attendanceRollCalls", prior.targetId);
      if (!rollCallId) throw new Error("The stored roll-call start is invalid.");
      return {
        rollCallId,
        version: storedOperationVersion(prior.resultJson, "roll-call start"),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({
        code: "SESSION_NOT_FOUND",
        message: "Attendance session not found.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.roll_call.start",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (session.version !== args.expectedSessionVersion) {
      throw new ConvexError({
        code: "SESSION_CHANGED",
        message: "The attendance session changed. Review it before starting roll call.",
      });
    }
    if (
      session.expectationBuildState !== "complete" ||
      session.expectationCount < 1 ||
      (session.status !== "ready" &&
        session.status !== "open" &&
        session.status !== "closing")
    ) {
      throw new ConvexError({
        code: "ROLL_CALL_COHORT_NOT_READY",
        message: "Choose a prepared attendance session with a frozen expected cohort.",
      });
    }
    const existing = await ctx.db
      .query("attendanceRollCalls")
      .withIndex("by_zone_state_started", (index) =>
        index.eq("zoneId", session.zoneId).eq("state", "active"),
      )
      .first();
    if (existing) {
      throw new ConvexError({
        code: "ROLL_CALL_ALREADY_ACTIVE",
        message: "That zone already has an active roll call.",
      });
    }
    const [participants, venueStates] = await Promise.all([
      ctx.db
        .query("attendanceSessionParticipants")
        .withIndex("by_session_membership", (index) =>
          index.eq("sessionId", session._id),
        )
        .collect(),
      ctx.db
        .query("attendanceVenueStates")
        .withIndex("by_event_membership", (index) =>
          index.eq("eventId", event._id),
        )
        .collect(),
    ]);
    if (participants.length !== session.expectationCount) {
      throw new ConvexError({
        code: "ROLL_CALL_COHORT_INCONSISTENT",
        message: "The session cohort count does not match its frozen participants.",
      });
    }
    const venueByMembership = new Map(
      venueStates.map((venueState) => [venueState.membershipId, venueState]),
    );
    const snapshotAt = Date.now();
    const snapshotCounts = emptyRollCallCounts();
    const shardCounts = new Map<number, RollCallCounts>();
    const checksumParts: OperationFingerprintPart[] = [
      session._id,
      session.version,
      session.expectationCount,
      snapshotAt,
    ];
    const orderedParticipants = [...participants].sort((left, right) =>
      left.membershipId.localeCompare(right.membershipId),
    );
    for (const participant of orderedParticipants) {
      const venue = venueByMembership.get(participant.membershipId) ?? null;
      const state = rollCallStateFor(venue, session.zoneId);
      snapshotCounts.expected += 1;
      moveRollCallCount(snapshotCounts, state, 1);
      const shard = attendanceCounterShardFor(participant.membershipId);
      const counts = shardCounts.get(shard) ?? emptyRollCallCounts();
      counts.expected += 1;
      moveRollCallCount(counts, state, 1);
      shardCounts.set(shard, counts);
      checksumParts.push(
        participant.membershipId,
        participant.version,
        venue?.state ?? "not_arrived",
        venue?.zoneId ?? null,
        venue?.version ?? null,
        venue?.lastEventId ?? null,
      );
    }
    assertCounts(snapshotCounts);
    const snapshotChecksum = operationFingerprint(checksumParts);
    const rollCallId = await ctx.db.insert("attendanceRollCalls", {
      eventId: event._id,
      sessionId: session._id,
      zoneId: session.zoneId,
      kind: args.kind,
      name,
      reason,
      state: "active",
      sessionVersion: session.version,
      expectedCount: participants.length,
      snapshotAt,
      snapshotChecksum,
      snapshotCounts,
      startedByPersonId: person._id,
      version: 1,
      createdAt: snapshotAt,
      updatedAt: snapshotAt,
    });
    for (const [shard, counts] of shardCounts) {
      assertCounts(counts);
      await ctx.db.insert("attendanceRollCallCounterShards", {
        eventId: event._id,
        rollCallId,
        shard,
        ...counts,
        version: 1,
        updatedAt: snapshotAt,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.roll_call.start",
      requestFingerprint,
      targetType: "attendance_roll_call",
      targetId: rollCallId,
      resultJson: "1",
      createdAt: snapshotAt,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.roll_call.start",
      grantIds,
      scopeType: "attendance_session",
      scopeId: session._id,
      action: "attendance.roll_call_started",
      targetType: "attendance_roll_call",
      targetId: rollCallId,
      nextSummary: JSON.stringify({
        kind: args.kind,
        zoneId: session.zoneId,
        sessionVersion: session.version,
        expectedCount: participants.length,
        snapshotChecksum,
        snapshotCounts,
      }),
      reason,
    });
    return { rollCallId, version: 1 };
  },
});

export const close = mutation({
  args: {
    eventSlug: v.string(),
    rollCallId: v.id("attendanceRollCalls"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    rollCallId: v.id("attendanceRollCalls"),
    state: v.literal("closed"),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Close reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.rollCallId,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.roll_call.close",
      requestFingerprint,
    });
    if (prior) {
      const rollCallId = ctx.db.normalizeId("attendanceRollCalls", prior.targetId);
      if (!rollCallId) throw new Error("The stored roll-call close is invalid.");
      return {
        rollCallId,
        state: closedRollCallState,
        version: storedOperationVersion(prior.resultJson, "roll-call close"),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const rollCall = await ctx.db.get(args.rollCallId);
    if (!rollCall || rollCall.eventId !== event._id) {
      throw new ConvexError({
        code: "ROLL_CALL_NOT_FOUND",
        message: "Roll call not found.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.roll_call.close",
      scopeType: "attendance_session",
      scopeId: rollCall.sessionId,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (rollCall.state !== "active" || rollCall.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "ROLL_CALL_CHANGED",
        message: "The roll call changed. Review the current state before closing it.",
      });
    }
    const shards = await ctx.db
      .query("attendanceRollCallCounterShards")
      .withIndex("by_roll_call_shard", (index) =>
        index.eq("rollCallId", rollCall._id),
      )
      .collect();
    const finalCounts = sumRollCallShards(shards);
    assertCounts(finalCounts);
    if (finalCounts.expected !== rollCall.expectedCount) {
      throw new ConvexError({
        code: "ROLL_CALL_COUNTS_INCONSISTENT",
        message: "Roll-call counters do not match the frozen expected cohort.",
      });
    }
    const now = Date.now();
    const version = rollCall.version + 1;
    await ctx.db.patch(rollCall._id, {
      state: "closed",
      closedByPersonId: person._id,
      closedAt: now,
      closeReason: reason,
      finalCounts,
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.roll_call.close",
      requestFingerprint,
      targetType: "attendance_roll_call",
      targetId: rollCall._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.roll_call.close",
      grantIds,
      scopeType: "attendance_session",
      scopeId: rollCall.sessionId,
      action: "attendance.roll_call_closed",
      targetType: "attendance_roll_call",
      targetId: rollCall._id,
      previousSummary: JSON.stringify({
        state: rollCall.state,
        version: rollCall.version,
        snapshotCounts: rollCall.snapshotCounts,
      }),
      nextSummary: JSON.stringify({ state: "closed", finalCounts }),
      reason,
    });
    return {
      rollCallId: rollCall._id,
      state: closedRollCallState,
      version,
    };
  },
});

const rollCallView = v.object({
  id: v.id("attendanceRollCalls"),
  kind: rollCallKind,
  name: v.string(),
  reason: v.string(),
  state: rollCallState,
  version: v.number(),
  snapshotAt: v.number(),
  snapshotChecksum: v.string(),
  snapshotCounts: rollCallCounts,
  currentCounts: rollCallCounts,
  closedAt: v.optional(v.number()),
  closeReason: v.optional(v.string()),
});

export const forSession = query({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
  },
  returns: v.object({
    serverTime: v.number(),
    zoneName: v.string(),
    rollCalls: v.array(rollCallView),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({
        code: "SESSION_NOT_FOUND",
        message: "Attendance session not found.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.roll_call.read",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    const zone = await ctx.db.get(session.zoneId);
    if (!zone || zone.eventId !== event._id) {
      throw new Error("Attendance session zone is missing.");
    }
    const rollCalls = await ctx.db
      .query("attendanceRollCalls")
      .withIndex("by_session_started", (index) =>
        index.eq("sessionId", session._id),
      )
      .order("desc")
      .take(5);
    const visible = [];
    for (const rollCall of rollCalls) {
      const shards = await ctx.db
        .query("attendanceRollCallCounterShards")
        .withIndex("by_roll_call_shard", (index) =>
          index.eq("rollCallId", rollCall._id),
        )
        .collect();
      const currentCounts = sumRollCallShards(shards);
      assertCounts(currentCounts);
      visible.push({
        id: rollCall._id,
        kind: rollCall.kind,
        name: rollCall.name,
        reason: rollCall.reason,
        state: rollCall.state,
        version: rollCall.version,
        snapshotAt: rollCall.snapshotAt,
        snapshotChecksum: rollCall.snapshotChecksum,
        snapshotCounts: rollCall.snapshotCounts,
        currentCounts,
        ...(rollCall.closedAt !== undefined ? { closedAt: rollCall.closedAt } : {}),
        ...(rollCall.closeReason !== undefined
          ? { closeReason: rollCall.closeReason }
          : {}),
      });
    }
    return { serverTime: Date.now(), zoneName: zone.name, rollCalls: visible };
  },
});

const rosterItem = v.object({
  membershipId: v.id("eventMemberships"),
  displayName: v.string(),
  teamName: v.optional(v.string()),
  expectation: attendanceSessionExpectation,
  state: rollCallPresenceState,
  updatedAt: v.optional(v.number()),
});

export const roster = query({
  args: {
    eventSlug: v.string(),
    rollCallId: v.id("attendanceRollCalls"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(rosterItem),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const rollCall = await ctx.db.get(args.rollCallId);
    if (!rollCall || rollCall.eventId !== event._id) {
      throw new ConvexError({
        code: "ROLL_CALL_NOT_FOUND",
        message: "Roll call not found.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.roll_call.read",
      scopeType: "attendance_session",
      scopeId: rollCall.sessionId,
    });
    const page = await ctx.db
      .query("attendanceSessionParticipants")
      .withIndex("by_session_membership", (index) =>
        index.eq("sessionId", rollCall.sessionId),
      )
      .paginate(args.paginationOpts);
    const rows = [];
    for (const participant of page.page) {
      const membership = await ctx.db.get(participant.membershipId);
      if (!membership || membership.eventId !== event._id) {
        throw new Error("Roll-call participant membership is missing.");
      }
      const [venue, profile, participantPerson, teamMember] = await Promise.all([
        ctx.db
          .query("attendanceVenueStates")
          .withIndex("by_event_membership", (index) =>
            index
              .eq("eventId", event._id)
              .eq("membershipId", membership._id),
          )
          .unique(),
        ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) =>
            index.eq("membershipId", membership._id),
          )
          .unique(),
        ctx.db.get(membership.personId),
        ctx.db
          .query("teamMembers")
          .withIndex("by_event_membership_status", (index) =>
            index
              .eq("eventId", event._id)
              .eq("membershipId", membership._id)
              .eq("status", "active"),
          )
          .unique(),
      ]);
      if (!participantPerson) {
        throw new Error("Roll-call participant person is missing.");
      }
      const team = teamMember ? await ctx.db.get(teamMember.teamId) : null;
      rows.push({
        membershipId: membership._id,
        displayName:
          profile?.fullName ?? participantPerson.displayName,
        ...(team ? { teamName: team.name } : {}),
        expectation: participant.expectation,
        state: rollCallStateFor(venue, rollCall.zoneId),
        ...(venue ? { updatedAt: venue.updatedAt } : {}),
      });
    }
    return { ...page, page: rows };
  },
});
