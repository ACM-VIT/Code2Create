import { ConvexError, v } from "convex/values";

import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { advanceAccessVersion } from "./lib/accessVersion";
import { writeAuditEvent } from "./lib/audit";
import { requireAssignedDevice, requireStationPermission } from "./lib/attendance";
import {
  disableAssignedAttendanceStation,
  enableDisabledAttendanceStation,
  stationAssignmentSourceId,
} from "./lib/attendanceStations";
import {
  appendAttendanceDeviceReadFactById,
  appendAttendanceStationReadFactById,
} from "./lib/operationsAutonomyReadFacts/attendanceOperations";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject, requireMembership } from "./lib/identity";
import { insertPermissionGrant, requirePermission } from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { normalizedText } from "./lib/strings";
import { barcodeSymbology } from "./values";

const keySetResult = v.object({
  keySetId: v.id("attendanceBarcodeKeySets"),
  eventId: v.id("events"),
  eventSlug: v.string(),
  encryptedKey: v.string(),
  iv: v.string(),
  authTag: v.string(),
  wrappingKeyVersion: v.string(),
  barcodeSymbologies: v.array(barcodeSymbology),
  barcodeNormalizationVersion: v.string(),
});

const attendanceKeySetResult = v.object({
  keySetId: v.id("attendanceBarcodeKeySets"),
  eventId: v.id("events"),
  eventSlug: v.string(),
  encryptedKey: v.string(),
  iv: v.string(),
  authTag: v.string(),
  wrappingKeyVersion: v.string(),
});

const encryptedKeyFields = v.object({
  encryptedKey: v.string(),
  iv: v.string(),
  authTag: v.string(),
  wrappingKeyVersion: v.string(),
});

export const ensureExternalPassKeySet = internalMutation({
  args: {
    eventSlug: v.string(),
    candidate: v.object({
      encryptedKey: v.string(),
      iv: v.string(),
      authTag: v.string(),
      wrappingKeyVersion: v.string(),
    }),
  },
  returns: attendanceKeySetResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.external_pass.read",
      scopeType: "self",
      scopeId: membership._id,
    });
    if (membership.eligibilityStatus !== "eligible" || membership.onboardingStatus !== "accepted") {
      throw new ConvexError({
        code: "ATTENDANCE_NOT_AVAILABLE",
        message: "Attendance credentials are available to accepted participants.",
      });
    }
    const planId = event.publishedAttendancePlanVersionId;
    const plan = planId ? await ctx.db.get(planId) : null;
    if (!plan || plan.eventId !== event._id || plan.status !== "published") {
      throw new ConvexError({
        code: "PLAN_NOT_ACTIVE",
        message: "Attendance is not configured for this event.",
      });
    }
    const active = await ctx.db
      .query("attendanceBarcodeKeySets")
      .withIndex("by_event_status_version", (index) =>
        index.eq("eventId", event._id).eq("status", "active"),
      )
      .order("desc")
      .first();
    if (active) {
      return {
        keySetId: active._id,
        eventId: event._id,
        eventSlug: event.slug,
        encryptedKey: active.encryptedKey,
        iv: active.iv,
        authTag: active.authTag,
        wrappingKeyVersion: active.wrappingKeyVersion,
      };
    }
    const keySetId = await ctx.db.insert("attendanceBarcodeKeySets", {
      eventId: event._id,
      version: 1,
      encryptedKey: args.candidate.encryptedKey,
      iv: args.candidate.iv,
      authTag: args.candidate.authTag,
      wrappingKeyVersion: args.candidate.wrappingKeyVersion,
      status: "active",
      createdByPersonId: person._id,
      createdAt: Date.now(),
    });
    return {
      keySetId,
      eventId: event._id,
      eventSlug: event.slug,
      encryptedKey: args.candidate.encryptedKey,
      iv: args.candidate.iv,
      authTag: args.candidate.authTag,
      wrappingKeyVersion: args.candidate.wrappingKeyVersion,
    };
  },
});

export const ensureExternalPassDeliveryKeySet = internalMutation({
  args: {
    eventSlug: v.string(),
    membershipId: v.id("eventMemberships"),
    candidate: v.object({
      encryptedKey: v.string(),
      iv: v.string(),
      authTag: v.string(),
      wrappingKeyVersion: v.string(),
    }),
  },
  returns: attendanceKeySetResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const membership = await ctx.db.get(args.membershipId);
    if (
      !membership ||
      membership.eventId !== event._id ||
      membership.participantClass !== "external_participant" ||
      membership.eligibilityStatus !== "eligible" ||
      membership.onboardingStatus !== "accepted"
    ) {
      throw new ConvexError({
        code: "EXTERNAL_PASS_NOT_AVAILABLE",
        message: "Event passes are available only to accepted external participants.",
      });
    }
    const active = await ctx.db
      .query("attendanceBarcodeKeySets")
      .withIndex("by_event_status_version", (index) =>
        index.eq("eventId", event._id).eq("status", "active"),
      )
      .order("desc")
      .first();
    if (active) {
      return {
        keySetId: active._id,
        eventId: event._id,
        eventSlug: event.slug,
        encryptedKey: active.encryptedKey,
        iv: active.iv,
        authTag: active.authTag,
        wrappingKeyVersion: active.wrappingKeyVersion,
      };
    }
    const keySetId = await ctx.db.insert("attendanceBarcodeKeySets", {
      eventId: event._id,
      version: 1,
      encryptedKey: args.candidate.encryptedKey,
      iv: args.candidate.iv,
      authTag: args.candidate.authTag,
      wrappingKeyVersion: args.candidate.wrappingKeyVersion,
      status: "active",
      createdByPersonId: membership.personId,
      createdAt: Date.now(),
    });
    return {
      keySetId,
      eventId: event._id,
      eventSlug: event.slug,
      encryptedKey: args.candidate.encryptedKey,
      iv: args.candidate.iv,
      authTag: args.candidate.authTag,
      wrappingKeyVersion: args.candidate.wrappingKeyVersion,
    };
  },
});

export const ensureBarcodeKeySet = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    purpose: v.union(v.literal("setup"), v.literal("scan")),
    candidate: v.object({
      encryptedKey: v.string(),
      iv: v.string(),
      authTag: v.string(),
      wrappingKeyVersion: v.string(),
    }),
  },
  returns: keySetResult,
  handler: async (ctx, args) => {
    const permissionKey =
      args.purpose === "setup" ? "attendance.station.read" : "attendance.scan.execute";
    const { event, person, station } = await requireStationPermission(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      permissionKey,
    });
    await requireAssignedDevice(ctx, {
      eventId: event._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
    });
    const plan = await ctx.db.get(station.planVersionId);
    if (!plan || plan.eventId !== event._id || plan.status !== "published") {
      throw new ConvexError({
        code: "PLAN_NOT_ACTIVE",
        message: "The station's attendance plan is not published.",
      });
    }
    const active = await ctx.db
      .query("attendanceBarcodeKeySets")
      .withIndex("by_event_status_version", (index) =>
        index.eq("eventId", event._id).eq("status", "active"),
      )
      .order("desc")
      .first();
    if (active) {
      return {
        keySetId: active._id,
        eventId: event._id,
        eventSlug: event.slug,
        encryptedKey: active.encryptedKey,
        iv: active.iv,
        authTag: active.authTag,
        wrappingKeyVersion: active.wrappingKeyVersion,
        barcodeSymbologies: plan.vitBarcodeSymbologies,
        barcodeNormalizationVersion: plan.vitBarcodeNormalizationVersion,
      };
    }
    const keySetId = await ctx.db.insert("attendanceBarcodeKeySets", {
      eventId: event._id,
      version: 1,
      encryptedKey: args.candidate.encryptedKey,
      iv: args.candidate.iv,
      authTag: args.candidate.authTag,
      wrappingKeyVersion: args.candidate.wrappingKeyVersion,
      status: "active",
      createdByPersonId: person._id,
      createdAt: Date.now(),
    });
    return {
      keySetId,
      eventId: event._id,
      eventSlug: event.slug,
      encryptedKey: args.candidate.encryptedKey,
      iv: args.candidate.iv,
      authTag: args.candidate.authTag,
      wrappingKeyVersion: args.candidate.wrappingKeyVersion,
      barcodeSymbologies: plan.vitBarcodeSymbologies,
      barcodeNormalizationVersion: plan.vitBarcodeNormalizationVersion,
    };
  },
});

export const keySetForRotation = internalQuery({
  args: { eventSlug: v.string() },
  returns: attendanceKeySetResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const active = await ctx.db
      .query("attendanceBarcodeKeySets")
      .withIndex("by_event_status_version", (index) =>
        index.eq("eventId", event._id).eq("status", "active"),
      )
      .order("desc")
      .first();
    if (!active) {
      throw new ConvexError({
        code: "ATTENDANCE_KEY_SET_MISSING",
        message: "This event has no active attendance key set.",
      });
    }
    return {
      keySetId: active._id,
      eventId: event._id,
      eventSlug: event.slug,
      encryptedKey: active.encryptedKey,
      iv: active.iv,
      authTag: active.authTag,
      wrappingKeyVersion: active.wrappingKeyVersion,
    };
  },
});

export const commitKeySetRewrap = internalMutation({
  args: {
    keySetId: v.id("attendanceBarcodeKeySets"),
    eventId: v.id("events"),
    expected: encryptedKeyFields,
    rewrapped: encryptedKeyFields,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const active = await ctx.db.get(args.keySetId);
    if (
      !active ||
      active.eventId !== args.eventId ||
      active.status !== "active" ||
      active.encryptedKey !== args.expected.encryptedKey ||
      active.iv !== args.expected.iv ||
      active.authTag !== args.expected.authTag ||
      active.wrappingKeyVersion !== args.expected.wrappingKeyVersion
    ) {
      return false;
    }
    await ctx.db.patch(active._id, {
      encryptedKey: args.rewrapped.encryptedKey,
      iv: args.rewrapped.iv,
      authTag: args.rewrapped.authTag,
      wrappingKeyVersion: args.rewrapped.wrappingKeyVersion,
      rewrappedAt: Date.now(),
    });
    return true;
  },
});

export const registerDevice = internalMutation({
  args: {
    eventSlug: v.string(),
    installationId: v.string(),
    deviceSecretHash: v.string(),
    name: v.string(),
    platform: v.union(v.literal("android"), v.literal("ios")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    stationId: v.id("attendanceStations"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.scan.execute",
      scopeType: "event",
    });
    const planId = event.publishedAttendancePlanVersionId;
    const plan = planId ? await ctx.db.get(planId) : null;
    if (!plan || plan.eventId !== event._id || plan.status !== "published") {
      throw new ConvexError({
        code: "SCANNER_NOT_CONFIGURED",
        message: "Scanning is not configured for this event.",
      });
    }
    const configured = await ctx.db
      .query("attendanceStations")
      .withIndex("by_plan_key", (index) => index.eq("planVersionId", plan._id))
      .collect();
    const station =
      configured.find(
        (candidate) =>
          candidate.mode === "roving" &&
          candidate.sessionId === undefined &&
          candidate.allowedCredentialKinds !== undefined &&
          candidate.allowedCredentialKinds.length > 0,
      ) ??
      configured.find(
        (candidate) =>
          candidate.mode !== undefined &&
          candidate.allowedCredentialKinds !== undefined &&
          candidate.allowedCredentialKinds.length > 0,
      );
    if (!station) {
      throw new ConvexError({
        code: "SCANNER_NOT_CONFIGURED",
        message: "Scanning is not configured for this event.",
      });
    }
    const requestFingerprint = operationFingerprint([
      station._id,
      station.configurationVersion,
      args.installationId,
      args.deviceSecretHash,
      args.name,
      args.platform,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.device.register",
      requestFingerprint,
    });
    if (prior) {
      const deviceInstallationId = ctx.db.normalizeId(
        "attendanceDeviceInstallations",
        prior.targetId,
      );
      if (!deviceInstallationId) {
        throw new Error("The stored attendance-device result is invalid.");
      }
      return { deviceInstallationId, stationId: station._id };
    }
    const installationId = normalizedText(args.installationId, "Installation ID", 16, 100);
    const existing = await ctx.db
      .query("attendanceDeviceInstallations")
      .withIndex("by_event_installation", (index) =>
        index.eq("eventId", event._id).eq("installationId", installationId),
      )
      .unique();
    if (existing) {
      throw new ConvexError({
        code: "DEVICE_ALREADY_REGISTERED",
        message: "This installation is already registered.",
      });
    }
    const now = Date.now();
    const deviceInstallationId = await ctx.db.insert("attendanceDeviceInstallations", {
      eventId: event._id,
      stationId: station._id,
      installationId,
      secretHash: args.deviceSecretHash,
      name: normalizedText(args.name, "Device name", 2, 80),
      platform: args.platform,
      status: "active",
      registeredByPersonId: person._id,
      registeredAt: now,
      lastSeenAt: now,
      pendingReplayCount: 0,
    });
    await appendAttendanceDeviceReadFactById(ctx, deviceInstallationId, now);
    const sourceId = stationAssignmentSourceId({
      stationId: station._id,
      deviceInstallationId,
      operatorPersonId: person._id,
    });
    const stationGrant = await insertPermissionGrant(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.station.read",
      scopeType: "station",
      scopeId: station._id,
      sourceType: "station_assignment",
      sourceId,
      grantedByPersonId: person._id,
      reason: "Enabled scanner operator",
    });
    if (stationGrant.created) {
      await advanceAccessVersion(ctx, subject._id, now);
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.device.register",
      requestFingerprint,
      targetType: "attendance_device",
      targetId: deviceInstallationId,
      createdAt: now,
    });
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.scan.execute",
      grantIds,
      scopeType: "event",
      action: "attendance.device_registered",
      targetType: "attendance_device",
      targetId: deviceInstallationId,
      nextSummary: JSON.stringify({ stationId: station._id, platform: args.platform }),
      reason,
    });
    return { deviceInstallationId, stationId: station._id };
  },
});

export const disableStation = mutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    stationId: v.id("attendanceStations"),
    status: v.literal("disabled"),
    configurationVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.station.disable",
      requestFingerprint,
    });
    if (prior) {
      const configurationVersion = Number(prior.resultJson);
      if (!Number.isSafeInteger(configurationVersion) || configurationVersion < 1) {
        throw new ConvexError({
          code: "REPLAY_STATE_MISSING",
          message:
            "An earlier attempt of this action can no longer be verified. Start the step again from the beginning.",
        });
      }
      return { stationId: args.stationId, status: "disabled" as const, configurationVersion };
    }
    const { station, grantIds } = await requireStationPermission(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      permissionKey: "attendance.station.manage",
    });
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const now = Date.now();
    const result = await disableAssignedAttendanceStation(ctx, {
      eventId: event._id,
      station,
      disabledByPersonId: person._id,
      reason,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.station.disable",
      requestFingerprint,
      targetType: "attendance_station",
      targetId: station._id,
      resultJson: String(result.configurationVersion),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.station.manage",
      grantIds,
      scopeType: "station",
      scopeId: station._id,
      action: "attendance.station_disabled",
      targetType: "attendance_station",
      targetId: station._id,
      previousSummary: JSON.stringify({
        status: station.status,
        deviceInstallationId: result.deviceInstallationId,
        configurationVersion: station.configurationVersion,
      }),
      nextSummary: JSON.stringify({
        status: "disabled",
        configurationVersion: result.configurationVersion,
      }),
      reason,
    });
    return {
      stationId: station._id,
      status: "disabled" as const,
      configurationVersion: result.configurationVersion,
    };
  },
});

export const enableStation = mutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    stationId: v.id("attendanceStations"),
    status: v.literal("inactive"),
    configurationVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.station.enable",
      requestFingerprint,
    });
    if (prior) {
      const configurationVersion = Number(prior.resultJson);
      if (!Number.isSafeInteger(configurationVersion) || configurationVersion < 1) {
        throw new ConvexError({
          code: "REPLAY_STATE_MISSING",
          message:
            "An earlier attempt of this action can no longer be verified. Start the step again from the beginning.",
        });
      }
      return { stationId: args.stationId, status: "inactive" as const, configurationVersion };
    }
    const { station, grantIds } = await requireStationPermission(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      permissionKey: "attendance.station.manage",
    });
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const now = Date.now();
    const result = await enableDisabledAttendanceStation(ctx, { station, now });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.station.enable",
      requestFingerprint,
      targetType: "attendance_station",
      targetId: station._id,
      resultJson: String(result.configurationVersion),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.station.manage",
      grantIds,
      scopeType: "station",
      scopeId: station._id,
      action: "attendance.station_enabled",
      targetType: "attendance_station",
      targetId: station._id,
      previousSummary: JSON.stringify({
        status: station.status,
        configurationVersion: station.configurationVersion,
      }),
      nextSummary: JSON.stringify({
        status: "inactive",
        configurationVersion: result.configurationVersion,
      }),
      reason,
    });
    return {
      stationId: station._id,
      status: "inactive" as const,
      configurationVersion: result.configurationVersion,
    };
  },
});

export const scannerHeartbeat = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    pendingReplayCount: v.number(),
    oldestPendingCapturedAt: v.optional(v.number()),
  },
  returns: v.object({ serverNow: v.number() }),
  handler: async (ctx, args) => {
    const { event, station } = await requireStationPermission(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      permissionKey: "attendance.scan.execute",
    });
    const device = await requireAssignedDevice(ctx, {
      eventId: event._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
    });
    const serverNow = Date.now();
    const plan = await ctx.db.get(station.planVersionId);
    if (!plan || plan.eventId !== event._id || plan.status !== "published") {
      throw new ConvexError({
        code: "PLAN_NOT_ACTIVE",
        message: "The station's attendance plan is not published.",
      });
    }
    if (
      !Number.isSafeInteger(args.pendingReplayCount) ||
      args.pendingReplayCount < 0 ||
      args.pendingReplayCount > plan.offlineQueueMaxScans ||
      (args.pendingReplayCount === 0) !== (args.oldestPendingCapturedAt === undefined)
    ) {
      throw new ConvexError({
        code: "PENDING_REPLAY_STATUS_INVALID",
        message: "The scanner's pending replay status is invalid.",
      });
    }
    if (
      args.oldestPendingCapturedAt !== undefined &&
      (!Number.isSafeInteger(args.oldestPendingCapturedAt) ||
        args.oldestPendingCapturedAt > serverNow + 30_000 ||
        serverNow - args.oldestPendingCapturedAt > plan.offlineQueueMaxAgeSeconds * 1_000 + 30_000)
    ) {
      throw new ConvexError({
        code: "PENDING_REPLAY_STATUS_INVALID",
        message: "The scanner's oldest pending capture is outside the active queue policy.",
      });
    }
    if (
      device.lastSeenAt === undefined ||
      serverNow - device.lastSeenAt >= 30_000 ||
      device.pendingReplayCount !== args.pendingReplayCount ||
      device.oldestPendingCapturedAt !== args.oldestPendingCapturedAt
    ) {
      await ctx.db.patch(device._id, {
        lastSeenAt: serverNow,
        pendingReplayCount: args.pendingReplayCount,
        ...(args.oldestPendingCapturedAt !== undefined
          ? { oldestPendingCapturedAt: args.oldestPendingCapturedAt }
          : { oldestPendingCapturedAt: undefined }),
      });
      await appendAttendanceDeviceReadFactById(ctx, device._id, serverNow);
    }
    return { serverNow };
  },
});

/** Change an unused door without retiring phones already scanning on the published plan. */
export const configurePresenceStation = mutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    name: v.string(),
    mode: v.union(
      v.literal("venue_entry"),
      v.literal("venue_exit"),
      v.literal("roving"),
    ),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    stationId: v.id("attendanceStations"),
    configurationVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const name = normalizedText(args.name, "Station name", 2, 80);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const clientOperationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      10,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      name,
      args.mode,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.station.configure_presence",
      requestFingerprint,
    });
    if (prior)
      return {
        stationId: args.stationId,
        configurationVersion: args.expectedConfigurationVersion + 1,
      };
    const { station, grantIds } = await requireStationPermission(ctx, {
      ...args,
      permissionKey: "attendance.station.manage",
    });
    if (
      station.planVersionId !== event.publishedAttendancePlanVersionId ||
      station.status !== "inactive" ||
      station.deviceInstallationId !== undefined ||
      station.sessionId !== undefined
    ) {
      throw new ConvexError({
        code: "STATION_IN_USE",
        message:
          "Choose an unused, unassigned presence station from the current plan.",
      });
    }
    const configurationVersion = station.configurationVersion + 1;
    const now = Date.now();
    await ctx.db.patch(station._id, {
      name,
      mode: args.mode,
      configurationVersion,
      updatedAt: now,
    });
    await appendAttendanceStationReadFactById(ctx, station._id, now);
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.station.manage",
      grantIds,
      scopeType: "station",
      scopeId: station._id,
      action: "attendance.station_configured",
      targetType: "attendance_station",
      targetId: station._id,
      previousSummary: JSON.stringify({
        name: station.name,
        mode: station.mode,
        configurationVersion: station.configurationVersion,
      }),
      nextSummary: JSON.stringify({
        name,
        mode: args.mode,
        configurationVersion,
      }),
      reason,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.station.configure_presence",
      requestFingerprint,
      targetType: "attendance_station",
      targetId: station._id,
      resultJson: String(configurationVersion),
      createdAt: now,
    });
    return { stationId: station._id, configurationVersion };
  },
});
