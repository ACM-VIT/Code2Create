import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import {
  attendanceCredentialKind,
  attendanceStationMode,
  barcodeSymbology,
  sessionPresenceState,
} from "./values";

const sessionCounters = v.object({
  expected: v.number(),
  confirmationDue: v.number(),
  present: v.number(),
  temporarilyOut: v.number(),
  complete: v.number(),
  excused: v.number(),
  needsReview: v.number(),
  late: v.number(),
});

const stationView = v.object({
  id: v.id("attendanceStations"),
  name: v.string(),
  mode: attendanceStationMode,
  status: v.string(),
  configurationVersion: v.number(),
  allowedCredentialKinds: v.array(attendanceCredentialKind),
  zoneName: v.string(),
  sessionName: v.optional(v.string()),
  canManage: v.boolean(),
  device: v.union(
    v.null(),
    v.object({
      name: v.string(),
      platform: v.union(v.literal("android"), v.literal("ios")),
      lastSeenAt: v.optional(v.number()),
      pendingReplayCount: v.number(),
      oldestPendingCapturedAt: v.optional(v.number()),
    }),
  ),
});

const sessionView = v.object({
  id: v.id("attendanceSessions"),
  name: v.string(),
  kind: v.string(),
  requirement: v.string(),
  zoneName: v.string(),
  status: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  checkInOpensAt: v.number(),
  checkInClosesAt: v.number(),
  awayAlertAfterMinutes: v.optional(v.number()),
  expectationBuildState: v.string(),
  expectationCount: v.number(),
  version: v.number(),
  openedAt: v.optional(v.number()),
  closingCutoffAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
  job: v.union(
    v.null(),
    v.object({
      kind: v.string(),
      status: v.string(),
      scannedCount: v.number(),
      affectedCount: v.number(),
      failureCode: v.optional(v.string()),
    }),
  ),
  counters: sessionCounters,
  canReadRoster: v.boolean(),
  canManage: v.boolean(),
  canReconcile: v.boolean(),
  canReadRemedies: v.boolean(),
  canOpenRemedy: v.boolean(),
  canDecideRemedy: v.boolean(),
  canReadRollCalls: v.boolean(),
  canStartRollCall: v.boolean(),
  canCloseRollCall: v.boolean(),
  canExport: v.boolean(),
  canReadManualSheets: v.boolean(),
  canEnterManualSheets: v.boolean(),
  canVerifyManualSheets: v.boolean(),
  canReadManualSources: v.boolean(),
});

type CounterSummary = {
  expected: number;
  confirmationDue: number;
  present: number;
  temporarilyOut: number;
  complete: number;
  excused: number;
  needsReview: number;
  late: number;
};

async function permissionIds(
  ctx: QueryCtx,
  args: {
    eventId: Id<"events">;
    subjectId: Id<"eventAccessSubjects">;
    permissionKey:
      | "configuration.manage"
      | "attendance.plan.publish"
      | "attendance.venue_check_in.read"
      | "attendance.session.manage"
      | "attendance.history.read"
      | "attendance.presence.reconcile"
      | "attendance.remedy.read"
      | "attendance.remedy.open"
      | "attendance.remedy.decide"
      | "attendance.roll_call.read"
      | "attendance.roll_call.start"
      | "attendance.roll_call.close"
      | "attendance.export.identifiable"
      | "attendance.manual_sheet.read"
      | "attendance.manual_sheet.enter"
      | "attendance.manual_sheet.verify"
      | "attendance.manual_sheet.source.read"
      | "attendance.station.manage"
      | "attendance.station.read";
    scope:
      | { type: "event" }
      | { type: "attendance_session"; id: Id<"attendanceSessions"> }
      | { type: "station"; id: Id<"attendanceStations"> };
  },
) {
  if (args.scope.type === "event") {
    return matchingPermissionGrantIds(ctx, {
      eventId: args.eventId,
      eventAccessSubjectId: args.subjectId,
      permissionKey: args.permissionKey,
      scopeType: "event",
    });
  }
  if (args.scope.type === "attendance_session") {
    return matchingPermissionGrantIds(ctx, {
      eventId: args.eventId,
      eventAccessSubjectId: args.subjectId,
      permissionKey: args.permissionKey,
      scopeType: "attendance_session",
      scopeId: args.scope.id,
    });
  }
  return matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.subjectId,
    permissionKey: args.permissionKey,
    scopeType: "station",
    scopeId: args.scope.id,
  });
}

function sumCounters(
  shards: Array<{
    expected: number;
    confirmationDue: number;
    present: number;
    temporarilyOut: number;
    complete: number;
    excused: number;
    needsReview: number;
    late: number;
  }>,
): CounterSummary {
  return shards.reduce<CounterSummary>(
    (total, shard) => ({
      expected: total.expected + shard.expected,
      confirmationDue: total.confirmationDue + shard.confirmationDue,
      present: total.present + shard.present,
      temporarilyOut: total.temporarilyOut + shard.temporarilyOut,
      complete: total.complete + shard.complete,
      excused: total.excused + shard.excused,
      needsReview: total.needsReview + shard.needsReview,
      late: total.late + shard.late,
    }),
    {
      expected: 0,
      confirmationDue: 0,
      present: 0,
      temporarilyOut: 0,
      complete: 0,
      excused: 0,
      needsReview: 0,
      late: 0,
    },
  );
}

function canVoidLastTransition(
  participant: Doc<"attendanceSessionParticipants">,
  presenceEvent: Doc<"attendancePresenceEvents"> | null,
) {
  if (
    !presenceEvent ||
    presenceEvent._id !== participant.lastEventId ||
    presenceEvent.sourceKind !== "scanner" ||
    presenceEvent.outcome !== "accepted"
  ) {
    return false;
  }
  const reversesEntry =
    (presenceEvent.transition === "session_confirm" ||
      presenceEvent.transition === "zone_entry") &&
    presenceEvent.nextState === "present" &&
    (presenceEvent.previousState === "confirmation_due" ||
      presenceEvent.previousState === "temporarily_out") &&
    participant.state === "present";
  const reversesExit =
    presenceEvent.transition === "zone_exit" &&
    presenceEvent.previousState === "present" &&
    presenceEvent.nextState === "temporarily_out" &&
    participant.state === "temporarily_out";
  return reversesEntry || reversesExit;
}

export const overview = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    timezone: v.string(),
    canConfigure: v.boolean(),
    canPublish: v.boolean(),
    venueCheckIns: v.union(
      v.null(),
      v.object({
        checkedIn: v.number(),
        updatedAt: v.optional(v.number()),
      }),
    ),
    publishedPlan: v.union(
      v.null(),
      v.object({
        id: v.id("attendancePlanVersions"),
        name: v.string(),
        version: v.number(),
        barcodeSymbologies: v.array(barcodeSymbology),
        publishedAt: v.optional(v.number()),
      }),
    ),
    stations: v.array(stationView),
    sessions: v.array(sessionView),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const [configurationGrants, publishGrants, venueCheckInReadGrants] = await Promise.all([
      permissionIds(ctx, {
        eventId: event._id,
        subjectId: subject._id,
        permissionKey: "configuration.manage",
        scope: { type: "event" },
      }),
      permissionIds(ctx, {
        eventId: event._id,
        subjectId: subject._id,
        permissionKey: "attendance.plan.publish",
        scope: { type: "event" },
      }),
      permissionIds(ctx, {
        eventId: event._id,
        subjectId: subject._id,
        permissionKey: "attendance.venue_check_in.read",
        scope: { type: "event" },
      }),
    ]);
    const venueCounterShards = venueCheckInReadGrants.length > 0
      ? await ctx.db
          .query("venueCheckInCounterShards")
          .withIndex("by_event_shard", (index) => index.eq("eventId", event._id))
          .collect()
      : [];
    const venueCheckIns = venueCheckInReadGrants.length > 0
      ? {
          checkedIn: venueCounterShards.reduce(
            (total, shard) => total + shard.checkedIn,
            0,
          ),
          ...(venueCounterShards.length > 0
            ? {
                updatedAt: Math.max(
                  ...venueCounterShards.map((shard) => shard.updatedAt),
                ),
              }
            : {}),
        }
      : null;
    const planId = event.publishedAttendancePlanVersionId;
    const plan = planId ? await ctx.db.get(planId) : null;
    if (!plan || plan.eventId !== event._id || plan.status !== "published") {
      return {
        timezone: event.timezone,
        canConfigure: configurationGrants.length > 0,
        canPublish: publishGrants.length > 0,
        venueCheckIns,
        publishedPlan: null,
        stations: [],
        sessions: [],
      };
    }
    const [allSessions, allStations] = await Promise.all([
      ctx.db
        .query("attendanceSessions")
        .withIndex("by_plan_key", (index) => index.eq("planVersionId", plan._id))
        .collect(),
      ctx.db
        .query("attendanceStations")
        .withIndex("by_plan_key", (index) => index.eq("planVersionId", plan._id))
        .collect(),
    ]);
    const visibleStations = [];
    for (const station of allStations) {
      const [readStationGrants, manageStationGrants] = await Promise.all([
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.station.read",
          scope: { type: "station", id: station._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.station.manage",
          scope: { type: "station", id: station._id },
        }),
      ]);
      if (readStationGrants.length === 0 && manageStationGrants.length === 0) continue;
      const [zone, session, device] = await Promise.all([
        ctx.db.get(station.zoneId),
        station.sessionId ? ctx.db.get(station.sessionId) : Promise.resolve(null),
        station.deviceInstallationId
          ? ctx.db.get(station.deviceInstallationId)
          : Promise.resolve(null),
      ]);
      if (!zone || zone.eventId !== event._id) {
        throw new Error("An attendance station must belong to one event zone.");
      }
      if (station.sessionId !== undefined && (!session || session.eventId !== event._id)) {
        throw new Error("A session-bound attendance station must belong to one event session.");
      }
      if ((station.status === "active") !== (station.deviceInstallationId !== undefined)) {
        throw new Error("Only an active attendance station can own a device assignment.");
      }
      if (station.deviceInstallationId !== undefined && !device) {
        throw new Error("An active attendance station must resolve its assigned device.");
      }
      if (device && (device.eventId !== event._id || device.status !== "active")) {
        throw new Error("An assigned scanner device must be active in the station event.");
      }
      visibleStations.push({
        id: station._id,
        name: station.name,
        mode: station.mode,
        status: station.status,
        configurationVersion: station.configurationVersion,
        allowedCredentialKinds: station.allowedCredentialKinds,
        zoneName: zone.name,
        ...(session ? { sessionName: session.name } : {}),
        canManage: manageStationGrants.length > 0,
        device: device
          ? {
              name: device.name,
              platform: device.platform,
              ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
              pendingReplayCount: device.pendingReplayCount,
              ...(device.oldestPendingCapturedAt !== undefined
                ? { oldestPendingCapturedAt: device.oldestPendingCapturedAt }
                : {}),
            }
          : null,
      });
    }
    visibleStations.sort((left, right) => left.name.localeCompare(right.name));
    const sessions = [];
    for (const session of allSessions.sort((left, right) => left.startsAt - right.startsAt)) {
      const [
        readGrants,
        manageGrants,
        reconciliationGrants,
        remedyReadGrants,
        remedyOpenGrants,
        remedyDecisionGrants,
        rollCallReadGrants,
        rollCallStartGrants,
        rollCallCloseGrants,
        exportGrants,
        manualSheetReadGrants,
        manualSheetEnterGrants,
        manualSheetVerifyGrants,
        manualSourceReadGrants,
      ] = await Promise.all([
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.history.read",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.session.manage",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.presence.reconcile",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.remedy.read",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.remedy.open",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.remedy.decide",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.roll_call.read",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.roll_call.start",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.roll_call.close",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.export.identifiable",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.manual_sheet.read",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.manual_sheet.enter",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.manual_sheet.verify",
          scope: { type: "attendance_session", id: session._id },
        }),
        permissionIds(ctx, {
          eventId: event._id,
          subjectId: subject._id,
          permissionKey: "attendance.manual_sheet.source.read",
          scope: { type: "attendance_session", id: session._id },
        }),
      ]);
      if (
        readGrants.length === 0 &&
        manageGrants.length === 0 &&
        reconciliationGrants.length === 0 &&
        remedyReadGrants.length === 0 &&
        rollCallReadGrants.length === 0 &&
        exportGrants.length === 0 &&
        manualSheetReadGrants.length === 0
      ) continue;
      const [zone, counterShards, expectationJob, finalizationJob] = await Promise.all([
        ctx.db.get(session.zoneId),
        ctx.db
          .query("attendanceSessionCounterShards")
          .withIndex("by_session_shard", (index) => index.eq("sessionId", session._id))
          .collect(),
        session.expectationJobId
          ? ctx.db.get(session.expectationJobId)
          : Promise.resolve(null),
        session.finalizationJobId
          ? ctx.db.get(session.finalizationJobId)
          : Promise.resolve(null),
      ]);
      if (!zone || zone.eventId !== event._id) continue;
      const job = finalizationJob ?? expectationJob;
      sessions.push({
        id: session._id,
        name: session.name,
        kind: session.kind,
        requirement: session.requirement,
        zoneName: zone.name,
        status: session.status,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        checkInOpensAt: session.checkInOpensAt,
        checkInClosesAt: session.checkInClosesAt,
        ...(session.awayAlertAfterMinutes !== undefined
          ? { awayAlertAfterMinutes: session.awayAlertAfterMinutes }
          : {}),
        expectationBuildState: session.expectationBuildState,
        expectationCount: session.expectationCount,
        version: session.version,
        ...(session.openedAt !== undefined ? { openedAt: session.openedAt } : {}),
        ...(session.closingCutoffAt !== undefined
          ? { closingCutoffAt: session.closingCutoffAt }
          : {}),
        ...(session.closedAt !== undefined ? { closedAt: session.closedAt } : {}),
        job: job
          ? {
              kind: job.kind,
              status: job.status,
              scannedCount: job.scannedCount,
              affectedCount: job.affectedCount,
              ...(job.failureCode !== undefined ? { failureCode: job.failureCode } : {}),
            }
          : null,
        counters: sumCounters(counterShards),
        canReadRoster:
          readGrants.length > 0 ||
          manageGrants.length > 0 ||
          reconciliationGrants.length > 0 ||
          remedyReadGrants.length > 0,
        canManage: manageGrants.length > 0,
        canReconcile: reconciliationGrants.length > 0,
        canReadRemedies: remedyReadGrants.length > 0,
        canOpenRemedy: remedyOpenGrants.length > 0,
        canDecideRemedy: remedyDecisionGrants.length > 0,
        canReadRollCalls: rollCallReadGrants.length > 0,
        canStartRollCall: rollCallStartGrants.length > 0,
        canCloseRollCall: rollCallCloseGrants.length > 0,
        canExport: exportGrants.length > 0,
        canReadManualSheets: manualSheetReadGrants.length > 0,
        canEnterManualSheets: manualSheetEnterGrants.length > 0,
        canVerifyManualSheets: manualSheetVerifyGrants.length > 0,
        canReadManualSources: manualSourceReadGrants.length > 0,
      });
    }
    const canSeePlan =
      configurationGrants.length > 0 ||
      publishGrants.length > 0 ||
      venueCheckIns !== null ||
      visibleStations.length > 0 ||
      sessions.length > 0;
    return {
      timezone: event.timezone,
      canConfigure: configurationGrants.length > 0,
      canPublish: publishGrants.length > 0,
      venueCheckIns,
      publishedPlan: canSeePlan
        ? {
            id: plan._id,
            name: plan.name,
            version: plan.version,
            barcodeSymbologies: plan.vitBarcodeSymbologies,
            ...(plan.publishedAt !== undefined ? { publishedAt: plan.publishedAt } : {}),
          }
        : null,
      stations: visibleStations,
      sessions,
    };
  },
});

const rosterItem = v.object({
  membershipId: v.id("eventMemberships"),
  displayName: v.string(),
  teamName: v.optional(v.string()),
  expectation: v.string(),
  state: sessionPresenceState,
  result: v.optional(v.string()),
  late: v.boolean(),
  confirmedAt: v.optional(v.number()),
  presentDurationMs: v.optional(v.number()),
  version: v.number(),
  lastEventId: v.optional(v.id("attendancePresenceEvents")),
  canVoidLastTransition: v.boolean(),
  updatedAt: v.number(),
});

export const sessionRoster = query({
  args: {
    eventSlug: v.string(),
    sessionId: v.string(),
    state: v.optional(sessionPresenceState),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(rosterItem),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const sessionId = ctx.db.normalizeId("attendanceSessions", args.sessionId);
    const session = sessionId ? await ctx.db.get(sessionId) : null;
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "SESSION_NOT_FOUND", message: "Attendance session not found." });
    }
    const [readGrants, manageGrants, reconciliationGrants, remedyReadGrants] = await Promise.all([
      permissionIds(ctx, {
        eventId: event._id,
        subjectId: subject._id,
        permissionKey: "attendance.history.read",
        scope: { type: "attendance_session", id: session._id },
      }),
      permissionIds(ctx, {
        eventId: event._id,
        subjectId: subject._id,
        permissionKey: "attendance.session.manage",
        scope: { type: "attendance_session", id: session._id },
      }),
      permissionIds(ctx, {
        eventId: event._id,
        subjectId: subject._id,
        permissionKey: "attendance.presence.reconcile",
        scope: { type: "attendance_session", id: session._id },
      }),
      permissionIds(ctx, {
        eventId: event._id,
        subjectId: subject._id,
        permissionKey: "attendance.remedy.read",
        scope: { type: "attendance_session", id: session._id },
      }),
    ]);
    if (
      readGrants.length === 0 &&
      manageGrants.length === 0 &&
      reconciliationGrants.length === 0 &&
      remedyReadGrants.length === 0
    ) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot read that attendance session.",
      });
    }
    const requestedState = args.state;
    const page = requestedState
      ? await ctx.db
          .query("attendanceSessionParticipants")
          .withIndex("by_session_state", (index) =>
            index.eq("sessionId", session._id).eq("state", requestedState),
          )
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("attendanceSessionParticipants")
          .withIndex("by_session_membership", (index) => index.eq("sessionId", session._id))
          .paginate(args.paginationOpts);
    const visible = [];
    for (const participant of page.page) {
      const membership = await ctx.db.get(participant.membershipId);
      if (!membership || membership.eventId !== event._id) continue;
      const [profile, participantPerson, teamMember, lastEvent] = await Promise.all([
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
        participant.lastEventId
          ? ctx.db.get(participant.lastEventId)
          : Promise.resolve(null),
      ]);
      if (!participantPerson) continue;
      const team = teamMember ? await ctx.db.get(teamMember.teamId) : null;
      visible.push({
        membershipId: membership._id,
        displayName:
          profile?.preferredName ?? profile?.fullName ?? participantPerson.displayName,
        ...(team ? { teamName: team.name } : {}),
        expectation: participant.expectation,
        state: participant.state,
        ...(participant.result !== undefined ? { result: participant.result } : {}),
        late: participant.late,
        ...(participant.confirmedAt !== undefined
          ? { confirmedAt: participant.confirmedAt }
          : {}),
        ...(participant.presentDurationMs !== undefined
          ? { presentDurationMs: participant.presentDurationMs }
          : {}),
        version: participant.version,
        ...(participant.lastEventId !== undefined
          ? { lastEventId: participant.lastEventId }
          : {}),
        canVoidLastTransition: canVoidLastTransition(participant, lastEvent),
        updatedAt: participant.updatedAt,
      });
    }
    return { ...page, page: visible };
  },
});

const reconciliationEvent = v.object({
  id: v.id("attendancePresenceEvents"),
  sourceKind: v.union(
    v.literal("scanner"),
    v.literal("staff_reconciliation"),
    v.literal("manual_import"),
  ),
  transition: v.string(),
  outcome: v.string(),
  reasonCode: v.string(),
  previousState: v.optional(v.string()),
  nextState: v.optional(v.string()),
  correctionKind: v.optional(v.string()),
  linkedEventId: v.optional(v.id("attendancePresenceEvents")),
  effectiveAt: v.number(),
  recordedAt: v.number(),
});

export const reconciliationPreview = query({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    membershipId: v.id("eventMemberships"),
  },
  returns: v.object({
    serverTime: v.number(),
    participantVersion: v.number(),
    state: sessionPresenceState,
    currentInterval: v.union(
      v.null(),
      v.object({
        id: v.id("attendancePresenceIntervals"),
        openedAt: v.number(),
      }),
    ),
    recentEvents: v.array(reconciliationEvent),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const [session, membership] = await Promise.all([
      ctx.db.get(args.sessionId),
      ctx.db.get(args.membershipId),
    ]);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({
        code: "SESSION_NOT_FOUND",
        message: "Attendance session not found.",
      });
    }
    if (!membership || membership.eventId !== event._id) {
      throw new ConvexError({
        code: "PARTICIPANT_NOT_FOUND",
        message: "The participant is not part of this event.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.presence.reconcile",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    const participant = await ctx.db
      .query("attendanceSessionParticipants")
      .withIndex("by_session_membership", (index) =>
        index.eq("sessionId", session._id).eq("membershipId", membership._id),
      )
      .unique();
    if (!participant || participant.eventId !== event._id) {
      throw new ConvexError({
        code: "SESSION_PARTICIPANT_NOT_FOUND",
        message: "The participant is not in this session's frozen cohort.",
      });
    }
    const [currentInterval, recentEvents] = await Promise.all([
      participant.currentIntervalId
        ? ctx.db.get(participant.currentIntervalId)
        : Promise.resolve(null),
      ctx.db
        .query("attendancePresenceEvents")
        .withIndex("by_session_membership_time", (index) =>
          index
            .eq("sessionId", session._id)
            .eq("membershipId", membership._id),
        )
        .order("desc")
        .take(6),
    ]);
    if (
      currentInterval &&
      (currentInterval.eventId !== event._id ||
        currentInterval.sessionId !== session._id ||
        currentInterval.membershipId !== membership._id ||
        currentInterval.status !== "open")
    ) {
      throw new ConvexError({
        code: "SESSION_INTERVAL_CONFLICT",
        message: "The current interval needs review before correction.",
      });
    }
    return {
      serverTime: Date.now(),
      participantVersion: participant.version,
      state: participant.state,
      currentInterval: currentInterval
        ? { id: currentInterval._id, openedAt: currentInterval.openedAt }
        : null,
      recentEvents: recentEvents.map((presenceEvent) => ({
        id: presenceEvent._id,
        sourceKind: presenceEvent.sourceKind,
        transition: presenceEvent.transition,
        outcome: presenceEvent.outcome,
        reasonCode: presenceEvent.reasonCode,
        ...(presenceEvent.previousState !== undefined
          ? { previousState: presenceEvent.previousState }
          : {}),
        ...(presenceEvent.nextState !== undefined
          ? { nextState: presenceEvent.nextState }
          : {}),
        ...(presenceEvent.correctionKind !== undefined
          ? { correctionKind: presenceEvent.correctionKind }
          : {}),
        ...(presenceEvent.linkedEventId !== undefined
          ? { linkedEventId: presenceEvent.linkedEventId }
          : {}),
        effectiveAt: presenceEvent.capturedAt,
        recordedAt: presenceEvent.receivedAt,
      })),
    };
  },
});
