import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireAssignedDevice, requireStationPermission } from "./lib/attendance";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { requireAvailableStaffedVenueResolution } from "./lib/staffedParticipantResolution";
import { normalizedText } from "./lib/strings";
import {
  recordStaffedVenueCheckIn,
  reverseStaffedVenueCheckIn,
} from "./lib/venueCheckInLifecycle";
import { venueIdentityCheckMethod } from "./values";

const recordedResult = v.object({
  checkInId: v.id("venueCheckIns"),
  status: v.literal("checked_in"),
  checkedInAt: v.number(),
  version: v.number(),
  identityCheckMethod: venueIdentityCheckMethod,
  teamStatusChanged: v.boolean(),
});

const reversedResult = v.object({
  checkInId: v.id("venueCheckIns"),
  status: v.literal("reversed"),
  reversedAt: v.number(),
  version: v.number(),
  teamStatusChanged: v.boolean(),
});

type RecordedResult = {
  checkInId: Id<"venueCheckIns">;
  status: "checked_in";
  checkedInAt: number;
  version: number;
  identityCheckMethod: "vit_id" | "external_photo_id" | "approved_exception";
  teamStatusChanged: boolean;
};

type ReversedResult = {
  checkInId: Id<"venueCheckIns">;
  status: "reversed";
  reversedAt: number;
  version: number;
  teamStatusChanged: boolean;
};

const storedRecordedResult = z.object({
  checkInId: z.string().min(1),
  checkedInAt: z.number().finite(),
  version: z.number().int().positive(),
  identityCheckMethod: z.enum(["vit_id", "external_photo_id", "approved_exception"]),
  teamStatusChanged: z.boolean(),
});

const storedReversedResult = z.object({
  checkInId: z.string().min(1),
  reversedAt: z.number().finite(),
  version: z.number().int().positive(),
  teamStatusChanged: z.boolean(),
});

export const record = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    identityCheckKind: v.union(
      v.literal("class_id"),
      v.literal("approved_exception"),
    ),
    visibleIdentityConfirmed: v.boolean(),
    reason: v.optional(v.string()),
    clientOperationId: v.string(),
  },
  returns: recordedResult,
  handler: async (ctx, args): Promise<RecordedResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.identityCheckKind,
      args.visibleIdentityConfirmed,
      args.reason ?? null,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.venue_check_in.record",
      requestFingerprint,
    });
    if (prior) return priorRecordedResult(ctx, prior.resultJson);
    const { subject, station } = await requireStationPermission(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      permissionKey: "attendance.station.read",
    });
    await requireAssignedDevice(ctx, {
      eventId: event._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
    });
    if (station.mode !== "venue_entry") {
      throw new ConvexError({
        code: "VENUE_ENTRY_STATION_REQUIRED",
        message: "Use an active venue-entry station for staffed arrival check-in.",
      });
    }
    if (!args.visibleIdentityConfirmed) {
      throw new ConvexError({
        code: "IDENTITY_CONFIRMATION_REQUIRED",
        message: "Confirm the participant against the displayed identity before check-in.",
      });
    }
    const now = Date.now();
    const resolution = await requireAvailableStaffedVenueResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      now,
    });
    const membership = await ctx.db.get(resolution.membershipId);
    if (!membership || membership.eventId !== event._id) {
      throw new ConvexError({
        code: "PARTICIPANT_NOT_FOUND",
        message: "Participant not found for this event.",
      });
    }
    const permissionKey:
      | "attendance.venue_check_in.record"
      | "attendance.venue_check_in.override_identity" =
      args.identityCheckKind === "approved_exception"
        ? "attendance.venue_check_in.override_identity"
        : "attendance.venue_check_in.record";
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey,
      scopeType: "person",
      scopeId: membership.personId,
    });
    const checkInReason =
      args.identityCheckKind === "approved_exception"
        ? normalizedText(args.reason ?? "", "Identity exception reason", 5, 300)
        : undefined;
    if (args.identityCheckKind === "approved_exception") {
      await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    }
    const identityCheckMethod: RecordedResult["identityCheckMethod"] =
      args.identityCheckKind === "approved_exception"
        ? "approved_exception"
        : membership.participantClass === "vit_student"
          ? "vit_id"
          : "external_photo_id";
    const saved = await recordStaffedVenueCheckIn(ctx, {
      eventId: event._id,
      membershipId: membership._id,
      stationId: station._id,
      identityCheckMethod,
      ...(checkInReason !== undefined ? { checkInReason } : {}),
      actorPersonId: person._id,
      now,
    });
    await ctx.db.patch(resolution._id, {
      venueAction: "record_check_in",
      venueActionAt: saved.checkedInAt,
      venueCheckInId: saved.checkInId,
    });
    const result: RecordedResult = {
      checkInId: saved.checkInId,
      status: "checked_in",
      checkedInAt: saved.checkedInAt,
      version: saved.version,
      identityCheckMethod: saved.identityCheckMethod,
      teamStatusChanged: saved.teamStatusChanged,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.venue_check_in.record",
      requestFingerprint,
      targetType: "venue_check_in",
      targetId: saved.checkInId,
      resultJson: JSON.stringify(result),
      createdAt: saved.checkedInAt,
    });
    const auditReason = checkInReason ??
      (identityCheckMethod === "vit_id"
        ? "Visible VIT ID matched the participant profile"
        : "Visible external participant photo ID matched the participant profile");
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey,
      grantIds,
      scopeType: "person",
      scopeId: membership.personId,
      action: "attendance.venue_checked_in",
      targetType: "venue_check_in",
      targetId: saved.checkInId,
      nextSummary: JSON.stringify({
        membershipId: membership._id,
        stationId: station._id,
        identityCheckMethod,
        teamStatusChanged: saved.teamStatusChanged,
      }),
      reason: auditReason,
    });
    return result;
  },
});

export const reverse = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    checkInId: v.id("venueCheckIns"),
    expectedCheckInVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: reversedResult,
  handler: async (ctx, args): Promise<ReversedResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.checkInId,
      args.expectedCheckInVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.venue_check_in.reverse",
      requestFingerprint,
    });
    if (prior) return priorReversedResult(ctx, prior.resultJson);
    const { subject, station } = await requireStationPermission(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      permissionKey: "attendance.station.read",
    });
    await requireAssignedDevice(ctx, {
      eventId: event._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
    });
    if (station.mode !== "venue_entry") {
      throw new ConvexError({
        code: "VENUE_ENTRY_STATION_REQUIRED",
        message: "Use an active venue-entry station for a venue check-in reversal.",
      });
    }
    const checkIn = await ctx.db.get(args.checkInId);
    if (!checkIn || checkIn.eventId !== event._id) {
      throw new ConvexError({
        code: "VENUE_CHECK_IN_NOT_FOUND",
        message: "Venue check-in not found.",
      });
    }
    const membership = await ctx.db.get(checkIn.membershipId);
    if (!membership || membership.eventId !== event._id) {
      throw new Error("A venue check-in must resolve its event membership.");
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.venue_check_in.reverse",
      scopeType: "person",
      scopeId: membership.personId,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const reason = normalizedText(args.reason, "Reversal reason", 5, 300);
    const now = Date.now();
    const resolution = await requireAvailableStaffedVenueResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      now,
    });
    if (resolution.membershipId !== membership._id) {
      throw new ConvexError({
        code: "STAFFED_RESOLUTION_REQUIRED",
        message: "Scan this participant's fresh portal QR before continuing.",
      });
    }
    const reversed = await reverseStaffedVenueCheckIn(ctx, {
      eventId: event._id,
      checkInId: checkIn._id,
      expectedVersion: args.expectedCheckInVersion,
      actorPersonId: person._id,
      reason,
      now,
    });
    await ctx.db.patch(resolution._id, {
      venueAction: "reverse_check_in",
      venueActionAt: reversed.reversedAt,
      venueCheckInId: reversed.checkInId,
    });
    const result: ReversedResult = {
      checkInId: reversed.checkInId,
      status: "reversed",
      reversedAt: reversed.reversedAt,
      version: reversed.version,
      teamStatusChanged: reversed.teamStatusChanged,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.venue_check_in.reverse",
      requestFingerprint,
      targetType: "venue_check_in",
      targetId: reversed.checkInId,
      resultJson: JSON.stringify(result),
      createdAt: reversed.reversedAt,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.venue_check_in.reverse",
      grantIds,
      scopeType: "person",
      scopeId: membership.personId,
      action: "attendance.venue_check_in_reversed",
      targetType: "venue_check_in",
      targetId: reversed.checkInId,
      previousSummary: JSON.stringify({
        status: "checked_in",
        version: args.expectedCheckInVersion,
      }),
      nextSummary: JSON.stringify({
        status: "reversed",
        version: reversed.version,
        teamStatusChanged: reversed.teamStatusChanged,
      }),
      reason,
    });
    return result;
  },
});

function priorRecordedResult(
  ctx: MutationCtx,
  resultJson: string | undefined,
): RecordedResult {
  const parsed = resultJson
    ? storedRecordedResult.safeParse(JSON.parse(resultJson))
    : null;
  if (!parsed?.success) throw new Error("Stored venue check-in result is invalid.");
  const checkInId = ctx.db.normalizeId("venueCheckIns", parsed.data.checkInId);
  if (!checkInId) throw new Error("Stored venue check-in ID is invalid.");
  return {
    checkInId,
    status: "checked_in",
    checkedInAt: parsed.data.checkedInAt,
    version: parsed.data.version,
    identityCheckMethod: parsed.data.identityCheckMethod,
    teamStatusChanged: parsed.data.teamStatusChanged,
  };
}

function priorReversedResult(
  ctx: MutationCtx,
  resultJson: string | undefined,
): ReversedResult {
  const parsed = resultJson
    ? storedReversedResult.safeParse(JSON.parse(resultJson))
    : null;
  if (!parsed?.success) throw new Error("Stored venue check-in reversal result is invalid.");
  const checkInId = ctx.db.normalizeId("venueCheckIns", parsed.data.checkInId);
  if (!checkInId) throw new Error("Stored venue check-in reversal ID is invalid.");
  return {
    checkInId,
    status: "reversed",
    reversedAt: parsed.data.reversedAt,
    version: parsed.data.version,
    teamStatusChanged: parsed.data.teamStatusChanged,
  };
}
