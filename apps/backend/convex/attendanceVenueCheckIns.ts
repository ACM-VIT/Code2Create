import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireAssignedDevice, requireStationPermission } from "./lib/attendance";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { requireAvailableStaffedVenueResolution } from "./lib/staffedParticipantResolution";
import { normalizedText } from "./lib/strings";
import { recordStaffedVenueCheckIn, reverseStaffedVenueCheckIn } from "./lib/venueCheckInLifecycle";
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

export async function requireStaffedVenueIdentityEvidence(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membership: Doc<"eventMemberships">;
    resolution: Doc<"staffedParticipantResolutions">;
    identityCheckKind: "class_id" | "approved_exception";
  },
) {
  if (args.identityCheckKind === "approved_exception" || args.resolution.resolutionMethod === "manual_lookup") {
    return;
  }
  if (args.membership.participantClass === "vit_student") {
    if (
      args.resolution.resolutionMethod !== "vit_id_barcode" ||
      args.resolution.barcodeLookupHash === undefined
    ) {
      throw new ConvexError({
        code: "VIT_ID_SCAN_REQUIRED",
        message: "Scan this participant's VIT ID before recording first check-in.",
      });
    }
    const lookupHash = args.resolution.barcodeLookupHash;
    const matchingCredentials = await ctx.db
      .query("attendanceCredentials")
      .withIndex("by_event_lookup", (index) =>
        index.eq("eventId", args.eventId).eq("lookupHash", lookupHash),
      )
      .collect();
    const activeMatch = matchingCredentials.find(
      (credential) =>
        credential.membershipId === args.membership._id &&
        credential.kind === "vit_id_barcode" &&
        credential.state === "active",
    );
    if (!activeMatch) {
      throw new ConvexError({
        code: "VIT_ID_NOT_READY",
        message: "Link or replace this VIT ID before recording first check-in.",
      });
    }
    return;
  }
  if (
    args.resolution.resolutionMethod !== "external_id_barcode" &&
    (args.resolution.resolutionMethod !== "external_pass" || args.resolution.credentialAction !== "link_external_id")
  ) {
    throw new ConvexError({
      code: "EXTERNAL_ID_LINK_REQUIRED",
      message: "Scan the external event pass, verify the photo ID, and link its barcode first.",
    });
  }
  const binding = await ctx.db
    .query("attendanceExternalIdentityBindings")
    .withIndex("by_membership", (index) => index.eq("membershipId", args.membership._id))
    .unique();
  if (!binding || binding.eventId !== args.eventId || binding.state !== "active") {
    throw new ConvexError({
      code: "EXTERNAL_ID_LINK_REQUIRED",
      message: "The external participant's physical ID is not actively linked.",
    });
  }
}

const storedRecordedResult = z.object({
  checkInId: z.string().min(1),
  checkedInAt: z.number(),
  version: z.number().int().positive(),
  identityCheckMethod: z.enum(["vit_id", "external_photo_id", "approved_exception"]),
  teamStatusChanged: z.boolean(),
});

const storedReversedResult = z.object({
  checkInId: z.string().min(1),
  reversedAt: z.number(),
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
    identityCheckKind: v.union(v.literal("class_id"), v.literal("approved_exception")),
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
    await requireStaffedVenueIdentityEvidence(ctx, {
      eventId: event._id,
      membership,
      resolution,
      identityCheckKind: args.identityCheckKind,
    });
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
    const auditReason =
      checkInReason ??
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
        message: "Resolve this participant again on this phone before continuing.",
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

function priorRecordedResult(ctx: MutationCtx, resultJson: string | undefined): RecordedResult {
  const stored = storedOperationResult(resultJson, "venue check-in", storedRecordedResult);
  const checkInId = ctx.db.normalizeId("venueCheckIns", stored.checkInId);
  if (!checkInId) throw new Error("Stored venue check-in ID is invalid.");
  return {
    checkInId,
    status: "checked_in",
    checkedInAt: stored.checkedInAt,
    version: stored.version,
    identityCheckMethod: stored.identityCheckMethod,
    teamStatusChanged: stored.teamStatusChanged,
  };
}

function priorReversedResult(ctx: MutationCtx, resultJson: string | undefined): ReversedResult {
  const stored = storedOperationResult(resultJson, "venue check-in reversal", storedReversedResult);
  const checkInId = ctx.db.normalizeId("venueCheckIns", stored.checkInId);
  if (!checkInId) throw new Error("Stored venue check-in reversal ID is invalid.");
  return {
    checkInId,
    status: "reversed",
    reversedAt: stored.reversedAt,
    version: stored.version,
    teamStatusChanged: stored.teamStatusChanged,
  };
}
