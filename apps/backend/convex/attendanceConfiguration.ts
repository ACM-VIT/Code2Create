import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import {
  configurationPublicationResultJson,
  storedConfigurationPublicationResult,
} from "./lib/configurationOperationResult";
import { attendancePlanChecksum } from "./lib/attendancePlan";
import {
  maximumAttendanceSessionsPerPlan,
  maximumAttendanceStationsPerPlan,
  maximumAttendanceZonesPerPlan,
  maximumSimultaneousAttendanceSessionsPerParticipant,
  requireAttendancePlanLimits,
} from "./lib/attendancePlanLimits";
import {
  requireReplaceableAttendancePlan,
  retireAttendancePlanStations,
} from "./lib/attendanceStations";
import { requireConfiguredAttendanceStation } from "./lib/attendance";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { normalizedText } from "./lib/strings";
import { appendAttendanceStationReadFactById } from "./lib/operationsAutonomyReadFacts/attendanceOperations";
import {
  attendanceScannerCredentialKind,
  type AttendanceStationMode,
  attendanceStationMode,
  barcodeSymbology,
  participantClass,
} from "./values";

const cohort = v.union(
  v.object({ kind: v.literal("all_admitted") }),
  v.object({
    kind: v.literal("participant_classes"),
    participantClasses: v.array(participantClass),
  }),
  v.object({
    kind: v.literal("explicit"),
    membershipIds: v.array(v.id("eventMemberships")),
  }),
);

const zoneInput = v.object({
  stableKey: v.string(),
  name: v.string(),
  safeCapacity: v.optional(v.number()),
});

const sessionInput = v.object({
  stableKey: v.string(),
  name: v.string(),
  kind: v.union(
    v.literal("hacking"),
    v.literal("briefing"),
    v.literal("review_preparation"),
    v.literal("overnight_access"),
    v.literal("workshop"),
    v.literal("other"),
  ),
  requirement: v.union(
    v.literal("required"),
    v.literal("optional"),
    v.literal("information_only"),
  ),
  expectedCohort: cohort,
  zoneKey: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  checkInOpensAt: v.number(),
  checkInClosesAt: v.number(),
  awayAlertAfterMinutes: v.optional(v.number()),
});

const stationInput = v.object({
  stableKey: v.string(),
  name: v.string(),
  zoneKey: v.string(),
  mode: attendanceStationMode,
  sessionKey: v.optional(v.string()),
  allowedCredentialKinds: v.array(attendanceScannerCredentialKind),
});

const stationEditorSource = v.object({
  stableKey: v.string(),
  name: v.string(),
  zoneKey: v.string(),
  mode: v.optional(attendanceStationMode),
  sessionKey: v.optional(v.string()),
  allowedCredentialKinds: v.optional(v.array(attendanceScannerCredentialKind)),
});

function stableKey(value: string, label: string) {
  const key = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(key)) {
    throw new ConvexError({
      code: "INVALID_STABLE_KEY",
      message: `${label} must use lowercase letters, numbers, and underscores.`,
    });
  }
  return key;
}

function requireUnique(values: string[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new ConvexError({ code: "DUPLICATE_CONFIGURATION", message: `${label} must be unique.` });
  }
}

function requireVersion(actual: number, expected: number) {
  if (actual !== expected) {
    throw new ConvexError({
      code: "CONFIGURATION_CHANGED",
      message: "Attendance configuration changed. Refresh before continuing.",
    });
  }
}

export function validateAttendanceStationBinding(args: {
  mode: AttendanceStationMode;
  stationZoneKey: string;
  sessionKey?: string;
  sessions: readonly { stableKey: string; zoneKey: string }[];
}) {
  const sessionScoped =
    args.mode === "session_confirm" ||
    args.mode === "zone_entry" ||
    args.mode === "zone_exit";
  if (sessionScoped && args.sessionKey === undefined) {
    throw new ConvexError({
      code: "STATION_SESSION_REQUIRED",
      message: "A session-scoped station must select a session.",
    });
  }
  if (
    (args.mode === "venue_entry" || args.mode === "venue_exit") &&
    args.sessionKey !== undefined
  ) {
    throw new ConvexError({
      code: "STATION_SESSION_NOT_ALLOWED",
      message: "A venue station cannot select a session.",
    });
  }
  if (args.sessionKey === undefined) return;
  const session = args.sessions.find((candidate) => candidate.stableKey === args.sessionKey);
  if (!session) {
    throw new ConvexError({
      code: "UNKNOWN_SESSION",
      message: "A station references an unknown session.",
    });
  }
  if (session.zoneKey !== args.stationZoneKey) {
    throw new ConvexError({
      code: "STATION_SESSION_ZONE_MISMATCH",
      message: "A station session must use the station's zone.",
    });
  }
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventVersion: v.number(),
    canConfigure: v.boolean(),
    canPublish: v.boolean(),
    limits: v.object({
      maximumZones: v.number(),
      maximumSessions: v.number(),
      maximumStations: v.number(),
      maximumSimultaneousSessionsPerParticipant: v.number(),
    }),
    publishedPlan: v.union(
      v.null(),
      v.object({
        id: v.id("attendancePlanVersions"),
        version: v.number(),
        name: v.string(),
        publishedAt: v.optional(v.number()),
      }),
    ),
    draftPlan: v.union(
      v.null(),
      v.object({
        id: v.id("attendancePlanVersions"),
        version: v.number(),
        name: v.string(),
        zoneCount: v.number(),
        sessionCount: v.number(),
        stationCount: v.number(),
      }),
    ),
    editorSource: v.union(
      v.null(),
      v.object({
        planVersionId: v.id("attendancePlanVersions"),
        version: v.number(),
        source: v.union(v.literal("draft"), v.literal("published")),
        name: v.string(),
        vitBarcodeSymbologies: v.array(barcodeSymbology),
        offlineQueueMaxScans: v.number(),
        offlineQueueMaxAgeSeconds: v.number(),
        zones: v.array(zoneInput),
        sessions: v.array(sessionInput),
        stations: v.array(stationEditorSource),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const draftPlan = await ctx.db
      .query("attendancePlanVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "draft"),
      )
      .unique();
    const [configurationGrants, publishGrants] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.manage",
        scopeType: "event",
      }),
      draftPlan
        ? matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "attendance.plan.publish",
            scopeType: "attendance_plan",
            scopeId: draftPlan._id,
          })
        : matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "attendance.plan.publish",
            scopeType: "event",
          }),
    ]);
    if (configurationGrants.length === 0 && publishGrants.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot configure or publish attendance plans.",
      });
    }
    const publishedPlan = event.publishedAttendancePlanVersionId
      ? await ctx.db.get(event.publishedAttendancePlanVersionId)
      : null;
    const editorPlan = draftPlan ?? publishedPlan;
    const editorSourceKind: "draft" | "published" = draftPlan ? "draft" : "published";
    const [zones, sessions, stations] = editorPlan
      ? await Promise.all([
          ctx.db
            .query("attendanceZones")
            .withIndex("by_plan_key", (index) => index.eq("planVersionId", editorPlan._id))
            .take(maximumAttendanceZonesPerPlan + 1),
          ctx.db
            .query("attendanceSessions")
            .withIndex("by_plan_key", (index) => index.eq("planVersionId", editorPlan._id))
            .take(maximumAttendanceSessionsPerPlan + 1),
          ctx.db
            .query("attendanceStations")
            .withIndex("by_plan_key", (index) => index.eq("planVersionId", editorPlan._id))
            .take(maximumAttendanceStationsPerPlan + 1),
        ])
      : [[], [], []];
    requireAttendancePlanLimits({ zones, sessions, stations });
    const zoneKeyById = new Map(zones.map((zone) => [zone._id, zone.stableKey]));
    const sessionKeyById = new Map(sessions.map((session) => [session._id, session.stableKey]));
    return {
      eventVersion: event.version,
      canConfigure: configurationGrants.length > 0,
      canPublish: publishGrants.length > 0,
      limits: {
        maximumZones: maximumAttendanceZonesPerPlan,
        maximumSessions: maximumAttendanceSessionsPerPlan,
        maximumStations: maximumAttendanceStationsPerPlan,
        maximumSimultaneousSessionsPerParticipant:
          maximumSimultaneousAttendanceSessionsPerParticipant,
      },
      publishedPlan: publishedPlan
        ? {
            id: publishedPlan._id,
            version: publishedPlan.version,
            name: publishedPlan.name,
            ...(publishedPlan.publishedAt !== undefined
              ? { publishedAt: publishedPlan.publishedAt }
              : {}),
          }
        : null,
      draftPlan: draftPlan
        ? {
            id: draftPlan._id,
            version: draftPlan.version,
            name: draftPlan.name,
            zoneCount: zones.length,
            sessionCount: sessions.length,
            stationCount: stations.length,
          }
        : null,
      editorSource: editorPlan
        ? {
            planVersionId: editorPlan._id,
            version: editorPlan.version,
            source: editorSourceKind,
            name: editorPlan.name,
            vitBarcodeSymbologies: editorPlan.vitBarcodeSymbologies,
            offlineQueueMaxScans: editorPlan.offlineQueueMaxScans,
            offlineQueueMaxAgeSeconds: editorPlan.offlineQueueMaxAgeSeconds,
            zones: zones
              .map((zone) => ({
                stableKey: zone.stableKey,
                name: zone.name,
                ...(zone.safeCapacity !== undefined
                  ? { safeCapacity: zone.safeCapacity }
                  : {}),
              }))
              .sort((left, right) => left.stableKey.localeCompare(right.stableKey)),
            sessions: sessions
              .map((session) => {
                const zoneKey = zoneKeyById.get(session.zoneId);
                if (!zoneKey) throw new Error("Attendance session zone no longer resolves.");
                return {
                  stableKey: session.stableKey,
                  name: session.name,
                  kind: session.kind,
                  requirement: session.requirement,
                  expectedCohort: session.expectedCohort,
                  zoneKey,
                  startsAt: session.startsAt,
                  endsAt: session.endsAt,
                  checkInOpensAt: session.checkInOpensAt,
                  checkInClosesAt: session.checkInClosesAt,
                  ...(session.awayAlertAfterMinutes !== undefined
                    ? { awayAlertAfterMinutes: session.awayAlertAfterMinutes }
                    : {}),
                };
              })
              .sort((left, right) => left.startsAt - right.startsAt),
            stations: stations
              .map((station) => {
                const zoneKey = zoneKeyById.get(station.zoneId);
                if (!zoneKey) throw new Error("Attendance station zone no longer resolves.");
                const sessionKey = station.sessionId === undefined
                  ? undefined
                  : sessionKeyById.get(station.sessionId);
                if (station.sessionId !== undefined && sessionKey === undefined) {
                  throw new Error("Attendance station session no longer resolves.");
                }
                return {
                  stableKey: station.stableKey,
                  name: station.name,
                  zoneKey,
                  ...(station.mode !== undefined ? { mode: station.mode } : {}),
                  ...(sessionKey !== undefined ? { sessionKey } : {}),
                  ...(station.allowedCredentialKinds !== undefined
                    ? { allowedCredentialKinds: station.allowedCredentialKinds }
                    : {}),
                };
              })
              .sort((left, right) => left.stableKey.localeCompare(right.stableKey)),
          }
        : null,
    };
  },
});

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    name: v.string(),
    vitBarcodeSymbologies: v.array(barcodeSymbology),
    vitBarcodeNormalizationVersion: v.string(),
    offlineQueueMaxScans: v.number(),
    offlineQueueMaxAgeSeconds: v.number(),
    zones: v.array(zoneInput),
    sessions: v.array(sessionInput),
    stations: v.array(stationInput),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    planVersionId: v.id("attendancePlanVersions"),
    version: v.number(),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const requestFingerprint = operationFingerprint([
      args.expectedEventVersion,
      args.reason,
      JSON.stringify({
        name: args.name,
        vitBarcodeSymbologies: args.vitBarcodeSymbologies,
        vitBarcodeNormalizationVersion: args.vitBarcodeNormalizationVersion,
        offlineQueueMaxScans: args.offlineQueueMaxScans,
        offlineQueueMaxAgeSeconds: args.offlineQueueMaxAgeSeconds,
        zones: args.zones,
        sessions: args.sessions,
        stations: args.stations,
      }),
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.plan.create_draft",
      requestFingerprint,
    });
    if (prior) {
      const planVersionId = ctx.db.normalizeId("attendancePlanVersions", prior.targetId);
      if (!planVersionId) throw new Error("Prior attendance-plan result is invalid.");
      const stored = storedConfigurationPublicationResult(
        prior.resultJson,
        "attendance-plan draft",
      );
      return {
        planVersionId,
        version: stored.version,
        eventVersion: stored.eventVersion,
      };
    }
    requireVersion(event.version, args.expectedEventVersion);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.manage",
      scopeType: "event",
    });
    if (args.zones.length === 0 || args.sessions.length === 0 || args.stations.length === 0) {
      throw new ConvexError({
        code: "INCOMPLETE_ATTENDANCE_PLAN",
        message: "A plan needs at least one zone, session, and station.",
      });
    }
    requireAttendancePlanLimits({
      zones: args.zones,
      sessions: args.sessions,
      stations: args.stations,
    });

    const zones = args.zones.map((zone) => ({
      stableKey: stableKey(zone.stableKey, "Zone key"),
      name: normalizedText(zone.name, "Zone name", 2, 80),
      ...(zone.safeCapacity !== undefined ? { safeCapacity: zone.safeCapacity } : {}),
    }));
    const sessions = args.sessions.map((session) => ({
      ...session,
      stableKey: stableKey(session.stableKey, "Session key"),
      name: normalizedText(session.name, "Session name", 2, 100),
      zoneKey: stableKey(session.zoneKey, "Session zone key"),
    }));
    const stations = args.stations.map((station) => ({
      stableKey: stableKey(station.stableKey, "Station key"),
      name: normalizedText(station.name, "Station name", 2, 80),
      zoneKey: stableKey(station.zoneKey, "Station zone key"),
      mode: station.mode,
      ...(station.sessionKey !== undefined
        ? { sessionKey: stableKey(station.sessionKey, "Station session key") }
        : {}),
      allowedCredentialKinds: station.allowedCredentialKinds,
    }));
    requireUnique(zones.map((zone) => zone.stableKey), "Zone keys");
    requireUnique(sessions.map((session) => session.stableKey), "Session keys");
    requireUnique(stations.map((station) => station.stableKey), "Station keys");
    requireUnique(args.vitBarcodeSymbologies, "VIT barcode symbologies");
    const vitBarcodeNormalizationVersion = normalizedText(
      args.vitBarcodeNormalizationVersion,
      "Barcode normalization version",
      1,
      40,
    );
    if (vitBarcodeNormalizationVersion !== "trim-v1") {
      throw new ConvexError({
        code: "UNSUPPORTED_BARCODE_NORMALIZATION",
        message: "This build supports the trim-v1 VIT barcode normalization profile.",
      });
    }
    if (
      !Number.isInteger(args.offlineQueueMaxScans) ||
      args.offlineQueueMaxScans < 1 ||
      args.offlineQueueMaxScans > 25
    ) {
      throw new ConvexError({
        code: "INVALID_OFFLINE_QUEUE_LIMIT",
        message: "Offline scanner queues must allow between 1 and 25 pending scans.",
      });
    }
    if (
      !Number.isInteger(args.offlineQueueMaxAgeSeconds) ||
      args.offlineQueueMaxAgeSeconds < 30 ||
      args.offlineQueueMaxAgeSeconds > 600
    ) {
      throw new ConvexError({
        code: "INVALID_OFFLINE_QUEUE_AGE",
        message: "Offline scans must expire between 30 seconds and 10 minutes after capture.",
      });
    }
    if (args.vitBarcodeSymbologies.length === 0) {
      throw new ConvexError({
        code: "BARCODE_PROFILE_REQUIRED",
        message: "Choose the tested VIT ID barcode symbology before publishing scanner stations.",
      });
    }

    const zoneKeys = new Set(zones.map((zone) => zone.stableKey));
    for (const zone of zones) {
      if (
        zone.safeCapacity !== undefined &&
        (!Number.isInteger(zone.safeCapacity) || zone.safeCapacity < 1)
      ) {
        throw new ConvexError({ code: "INVALID_CAPACITY", message: "Zone capacity must be a positive integer." });
      }
    }
    for (const session of sessions) {
      if (!zoneKeys.has(session.zoneKey)) {
        throw new ConvexError({ code: "UNKNOWN_ZONE", message: "A session references an unknown zone." });
      }
      if (
        session.checkInOpensAt > session.startsAt ||
        session.startsAt >= session.endsAt ||
        session.checkInClosesAt < session.startsAt ||
        session.checkInClosesAt > session.endsAt
      ) {
        throw new ConvexError({ code: "INVALID_SESSION_TIME", message: "A session has an impossible time window." });
      }
      if (
        session.awayAlertAfterMinutes !== undefined &&
        (!Number.isInteger(session.awayAlertAfterMinutes) || session.awayAlertAfterMinutes < 1)
      ) {
        throw new ConvexError({ code: "INVALID_AWAY_ALERT", message: "Away alert must be a positive minute count." });
      }
      if (
        session.expectedCohort.kind === "participant_classes" &&
        session.expectedCohort.participantClasses.length === 0
      ) {
        throw new ConvexError({ code: "EMPTY_COHORT", message: "Participant-class cohort cannot be empty." });
      }
      if (
        session.expectedCohort.kind === "explicit" &&
        session.expectedCohort.membershipIds.length === 0
      ) {
        throw new ConvexError({ code: "EMPTY_COHORT", message: "Explicit cohort cannot be empty." });
      }
    }
    for (const station of stations) {
      if (!zoneKeys.has(station.zoneKey)) {
        throw new ConvexError({ code: "UNKNOWN_ZONE", message: "A station references an unknown zone." });
      }
      if (station.allowedCredentialKinds.length === 0) {
        throw new ConvexError({
          code: "STATION_CREDENTIAL_REQUIRED",
          message: "A station must allow at least one credential method.",
        });
      }
      requireUnique(
        station.allowedCredentialKinds,
        `Credential methods for station ${station.stableKey}`,
      );
      validateAttendanceStationBinding({
        mode: station.mode,
        stationZoneKey: station.zoneKey,
        ...(station.sessionKey !== undefined ? { sessionKey: station.sessionKey } : {}),
        sessions,
      });
    }

    for (const session of sessions) {
      if (session.expectedCohort.kind === "explicit") {
        for (const membershipId of session.expectedCohort.membershipIds) {
          const membership = await ctx.db.get(membershipId);
          if (!membership || membership.eventId !== event._id) {
            throw new ConvexError({ code: "FOREIGN_COHORT", message: "A cohort member is outside this event." });
          }
        }
      }
    }

    const priorDraft = await ctx.db
      .query("attendancePlanVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "draft"),
      )
      .unique();
    const latestPlan = await ctx.db
      .query("attendancePlanVersions")
      .withIndex("by_event_version", (index) => index.eq("eventId", event._id))
      .order("desc")
      .first();
    const version = (latestPlan?.version ?? 0) + 1;
    const now = Date.now();
    if (priorDraft) await ctx.db.patch(priorDraft._id, { status: "retired" });
    const planVersionId = await ctx.db.insert("attendancePlanVersions", {
      eventId: event._id,
      version,
      name: normalizedText(args.name, "Plan name", 2, 100),
      vitBarcodeSymbologies: args.vitBarcodeSymbologies,
      vitBarcodeNormalizationVersion,
      offlineQueueMaxScans: args.offlineQueueMaxScans,
      offlineQueueMaxAgeSeconds: args.offlineQueueMaxAgeSeconds,
      status: "draft",
      checksum: attendancePlanChecksum({
        name: args.name,
        vitBarcodeSymbologies: args.vitBarcodeSymbologies,
        vitBarcodeNormalizationVersion,
        offlineQueueMaxScans: args.offlineQueueMaxScans,
        offlineQueueMaxAgeSeconds: args.offlineQueueMaxAgeSeconds,
        zones,
        sessions,
        stations,
      }),
      createdByPersonId: person._id,
      createdAt: now,
    });
    const zoneIds = new Map<string, Id<"attendanceZones">>();
    for (const zone of zones) {
      const zoneId = await ctx.db.insert("attendanceZones", {
        eventId: event._id,
        planVersionId,
        stableKey: zone.stableKey,
        name: zone.name,
        ...(zone.safeCapacity !== undefined ? { safeCapacity: zone.safeCapacity } : {}),
        createdAt: now,
      });
      zoneIds.set(zone.stableKey, zoneId);
    }
    const sessionIds = new Map<string, Id<"attendanceSessions">>();
    for (const session of sessions) {
      const zoneId = zoneIds.get(session.zoneKey);
      if (!zoneId) throw new Error("Validated session zone is missing.");
      const sessionId = await ctx.db.insert("attendanceSessions", {
        eventId: event._id,
        planVersionId,
        stableKey: session.stableKey,
        name: session.name,
        kind: session.kind,
        requirement: session.requirement,
        expectedCohort: session.expectedCohort,
        zoneId,
        status: "scheduled",
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        checkInOpensAt: session.checkInOpensAt,
        checkInClosesAt: session.checkInClosesAt,
        ...(session.awayAlertAfterMinutes !== undefined
          ? { awayAlertAfterMinutes: session.awayAlertAfterMinutes }
          : {}),
        expectationBuildState: "not_started",
        expectationCount: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      sessionIds.set(session.stableKey, sessionId);
    }
    for (const station of stations) {
      const zoneId = zoneIds.get(station.zoneKey);
      if (!zoneId) throw new Error("Validated station zone is missing.");
      const sessionId = station.sessionKey === undefined
        ? undefined
        : sessionIds.get(station.sessionKey);
      if (station.sessionKey !== undefined && sessionId === undefined) {
        throw new Error("Validated station session is missing.");
      }
      const stationId = await ctx.db.insert("attendanceStations", {
        eventId: event._id,
        planVersionId,
        zoneId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        stableKey: station.stableKey,
        name: station.name,
        mode: station.mode,
        allowedCredentialKinds: station.allowedCredentialKinds,
        status: "inactive",
        configurationVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      await appendAttendanceStationReadFactById(ctx, stationId, now);
    }
    const eventVersion = event.version + 1;
    await ctx.db.patch(event._id, { version: eventVersion, updatedAt: now });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.plan.create_draft",
      requestFingerprint,
      targetType: "attendance_plan",
      targetId: planVersionId,
      resultJson: configurationPublicationResultJson({ version, eventVersion }),
      createdAt: now,
    });
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.manage",
      grantIds,
      scopeType: "event",
      action: "attendance.plan_draft_created",
      targetType: "attendance_plan",
      targetId: planVersionId,
      nextSummary: JSON.stringify({ version, zones: zones.length, sessions: sessions.length, stations: stations.length }),
      reason,
    });
    return { planVersionId, version, eventVersion };
  },
});

export const publish = mutation({
  args: {
    eventSlug: v.string(),
    planVersionId: v.id("attendancePlanVersions"),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    planVersionId: v.id("attendancePlanVersions"),
    version: v.number(),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const requestFingerprint = operationFingerprint([
      args.planVersionId,
      args.expectedEventVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.plan.publish",
      requestFingerprint,
    });
    if (prior) {
      const planVersionId = ctx.db.normalizeId("attendancePlanVersions", prior.targetId);
      if (!planVersionId) throw new Error("Prior attendance-plan result is invalid.");
      const stored = storedConfigurationPublicationResult(
        prior.resultJson,
        "attendance-plan publication",
      );
      return {
        planVersionId,
        version: stored.version,
        eventVersion: stored.eventVersion,
      };
    }
    requireVersion(event.version, args.expectedEventVersion);
    const plan = await ctx.db.get(args.planVersionId);
    if (!plan || plan.eventId !== event._id || plan.status !== "draft") {
      throw new ConvexError({ code: "PLAN_NOT_DRAFT", message: "Only this event's current draft can be published." });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.plan.publish",
      scopeType: "attendance_plan",
      scopeId: plan._id,
    });
    const [zones, sessions, stations] = await Promise.all([
      ctx.db
        .query("attendanceZones")
        .withIndex("by_plan_key", (index) => index.eq("planVersionId", plan._id))
        .take(maximumAttendanceZonesPerPlan + 1),
      ctx.db
        .query("attendanceSessions")
        .withIndex("by_plan_key", (index) => index.eq("planVersionId", plan._id))
        .take(maximumAttendanceSessionsPerPlan + 1),
      ctx.db
        .query("attendanceStations")
        .withIndex("by_plan_key", (index) => index.eq("planVersionId", plan._id))
        .take(maximumAttendanceStationsPerPlan + 1),
    ]);
    if (zones.length === 0 || sessions.length === 0 || stations.length === 0) {
      throw new ConvexError({ code: "PLAN_INCOMPLETE", message: "The attendance plan is incomplete." });
    }
    requireAttendancePlanLimits({ zones, sessions, stations });
    for (const station of stations) requireConfiguredAttendanceStation(station);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const priorPublished = event.publishedAttendancePlanVersionId
      ? await ctx.db.get(event.publishedAttendancePlanVersionId)
      : null;
    const now = Date.now();
    let retiredStationCount = 0;
    let revokedDeviceCount = 0;
    if (priorPublished && priorPublished.status === "published") {
      const [priorZones, priorSessions, priorStations] = await Promise.all([
        ctx.db
          .query("attendanceZones")
          .withIndex("by_plan_key", (index) => index.eq("planVersionId", priorPublished._id))
          .take(maximumAttendanceZonesPerPlan + 1),
        ctx.db
          .query("attendanceSessions")
          .withIndex("by_plan_key", (index) => index.eq("planVersionId", priorPublished._id))
          .take(maximumAttendanceSessionsPerPlan + 1),
        ctx.db
          .query("attendanceStations")
          .withIndex("by_plan_key", (index) => index.eq("planVersionId", priorPublished._id))
          .take(maximumAttendanceStationsPerPlan + 1),
      ]);
      requireAttendancePlanLimits({
        zones: priorZones,
        sessions: priorSessions,
        stations: priorStations,
      });
      requireReplaceableAttendancePlan(priorSessions);
      const retired = await retireAttendancePlanStations(ctx, {
        eventId: event._id,
        stations: priorStations,
        retiredByPersonId: person._id,
        reason: `Attendance plan replaced: ${reason}`,
        now,
      });
      retiredStationCount = retired.retiredStationCount;
      revokedDeviceCount = retired.revokedDeviceCount;
      await ctx.db.patch(priorPublished._id, { status: "superseded" });
    }
    await ctx.db.patch(plan._id, { status: "published", publishedAt: now });
    const eventVersion = event.version + 1;
    await ctx.db.patch(event._id, {
      publishedAttendancePlanVersionId: plan._id,
      version: eventVersion,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.plan.publish",
      requestFingerprint,
      targetType: "attendance_plan",
      targetId: plan._id,
      resultJson: configurationPublicationResultJson({
        version: plan.version,
        eventVersion,
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.plan.publish",
      grantIds,
      scopeType: "attendance_plan",
      scopeId: plan._id,
      action: "attendance.plan_published",
      targetType: "attendance_plan",
      targetId: plan._id,
      ...(priorPublished ? { previousSummary: JSON.stringify({ planVersionId: priorPublished._id, version: priorPublished.version }) } : {}),
      nextSummary: JSON.stringify({
        planVersionId: plan._id,
        version: plan.version,
        retiredStationCount,
        revokedDeviceCount,
      }),
      reason,
    });
    return { planVersionId: plan._id, version: plan.version, eventVersion };
  },
});
