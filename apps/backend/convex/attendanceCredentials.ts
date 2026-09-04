import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireAssignedDevice, requireStationPermission } from "./lib/attendance";
import {
  attendanceCredentialVerificationLifetimeMs,
  completeExternalBadgeIssue,
  completeExternalBadgeReplacement,
  completeVitBarcodeReplacement,
  expirePendingAttendanceCredential,
  isCurrentPendingAttendanceCredential,
  revokeActiveExternalBadge,
  suspendActiveVitBarcode,
} from "./lib/attendanceCredentialLifecycle";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson } from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import {
  claimStaffedCredentialResolution,
  createStaffedParticipantResolution,
  requireAvailableStaffedCredentialResolution,
  requireClaimedStaffedCredentialResolution,
} from "./lib/staffedParticipantResolution";
import { normalizeEmail, normalizedText } from "./lib/strings";
import { currentTeamForMembership } from "./lib/teamMembership";
import { parseVitRegistrationNumber, vitIdentityReferenceYear } from "./lib/vitStudentIdentity";
import { latestVenueCheckIn } from "./lib/venueCheckInLifecycle";
import { barcodeSymbology } from "./values";

type BeginResult = {
  credentialId: Id<"attendanceCredentials">;
  verificationRequired: true;
};

type VerifyResult = {
  credentialId: Id<"attendanceCredentials">;
  verified: true;
};

type VerifyReplacementResult = VerifyResult & {
  replacedCredentialId: Id<"attendanceCredentials">;
};

type BeginBadgeResult = BeginResult & {
  badgeReference: string;
};

type VerifyBadgeResult = VerifyResult & {
  badgeReference: string;
};

type VerifyBadgeReplacementResult = VerifyReplacementResult & {
  badgeReference: string;
};

type RevokeBadgeResult = {
  credentialId: Id<"attendanceCredentials">;
  revoked: true;
};

type SuspendVitResult = {
  credentialId: Id<"attendanceCredentials">;
  suspended: true;
};

type ExternalIdentityLinkResult = {
  bindingId: Id<"attendanceExternalIdentityBindings">;
  verified: true;
};

type CurrentVitCredential = Doc<"attendanceCredentials"> & {
  kind: "vit_id_barcode";
  state: "active" | "suspended";
};

type StaffedParticipantResult = {
  resolutionId: Id<"staffedParticipantResolutions">;
  membershipId: Id<"eventMemberships">;
  participantClass: "vit_student" | "external_participant";
  displayName: string;
  institution: string;
  teamName: string;
  vitRegistrationNumber?: string;
  vitScanRelationship?: "unbound" | "current_active" | "current_suspended" | "replacement";
  credential:
    | {
        kind: "vit_id_barcode";
        state: "not_enrolled";
        canEnrol: boolean;
      }
    | {
        kind: "vit_id_barcode";
        state: "active" | "suspended";
        credentialId: Id<"attendanceCredentials">;
        expectedCredentialVersion: number;
        canRebind: boolean;
        canSuspend: boolean;
      }
    | {
        kind: "external_pass";
        state: "active";
      }
    | {
        kind: "badge_qr";
        state: "not_issued";
        canIssue: boolean;
      }
    | {
        kind: "badge_qr";
        state: "active";
        credentialId: Id<"attendanceCredentials">;
        expectedCredentialVersion: number;
        badgeReference: string;
        canReplace: boolean;
        canRevoke: boolean;
      };
  venueCheckIn: null | {
    id: Id<"venueCheckIns">;
    status: "checked_in" | "reversed";
    version: number;
    checkedInAt: number;
    stationName: string;
    reversedAt?: number;
  };
  canRecordVenueCheckIn: boolean;
  canOverrideVenueIdentity: boolean;
  canReverseVenueCheckIn: boolean;
};

const beginResult = v.object({
  credentialId: v.id("attendanceCredentials"),
  verificationRequired: v.literal(true),
});

const verifyResult = v.object({
  credentialId: v.id("attendanceCredentials"),
  verified: v.literal(true),
});

const verifyReplacementResult = v.object({
  credentialId: v.id("attendanceCredentials"),
  replacedCredentialId: v.id("attendanceCredentials"),
  verified: v.literal(true),
});

const beginBadgeResult = v.object({
  credentialId: v.id("attendanceCredentials"),
  badgeReference: v.string(),
  verificationRequired: v.literal(true),
});

const verifyBadgeResult = v.object({
  credentialId: v.id("attendanceCredentials"),
  badgeReference: v.string(),
  verified: v.literal(true),
});

const verifyBadgeReplacementResult = v.object({
  credentialId: v.id("attendanceCredentials"),
  replacedCredentialId: v.id("attendanceCredentials"),
  badgeReference: v.string(),
  verified: v.literal(true),
});

const revokeBadgeResult = v.object({
  credentialId: v.id("attendanceCredentials"),
  revoked: v.literal(true),
});

const suspendVitResult = v.object({
  credentialId: v.id("attendanceCredentials"),
  suspended: v.literal(true),
});

const credentialParticipantResult = v.object({
  resolutionId: v.id("staffedParticipantResolutions"),
  membershipId: v.id("eventMemberships"),
  participantClass: v.union(v.literal("vit_student"), v.literal("external_participant")),
  displayName: v.string(),
  institution: v.string(),
  teamName: v.string(),
  vitRegistrationNumber: v.optional(v.string()),
  vitScanRelationship: v.optional(
    v.union(
      v.literal("unbound"),
      v.literal("current_active"),
      v.literal("current_suspended"),
      v.literal("replacement"),
    ),
  ),
  credential: v.union(
    v.object({
      kind: v.literal("vit_id_barcode"),
      state: v.literal("not_enrolled"),
      canEnrol: v.boolean(),
    }),
    v.object({
      kind: v.literal("vit_id_barcode"),
      state: v.union(v.literal("active"), v.literal("suspended")),
      credentialId: v.id("attendanceCredentials"),
      expectedCredentialVersion: v.number(),
      canRebind: v.boolean(),
      canSuspend: v.boolean(),
    }),
    v.object({
      kind: v.literal("external_pass"),
      state: v.literal("active"),
    }),
    v.object({
      kind: v.literal("badge_qr"),
      state: v.literal("not_issued"),
      canIssue: v.boolean(),
    }),
    v.object({
      kind: v.literal("badge_qr"),
      state: v.literal("active"),
      credentialId: v.id("attendanceCredentials"),
      expectedCredentialVersion: v.number(),
      badgeReference: v.string(),
      canReplace: v.boolean(),
      canRevoke: v.boolean(),
    }),
  ),
  venueCheckIn: v.union(
    v.null(),
    v.object({
      id: v.id("venueCheckIns"),
      status: v.union(v.literal("checked_in"), v.literal("reversed")),
      version: v.number(),
      checkedInAt: v.number(),
      stationName: v.string(),
      reversedAt: v.optional(v.number()),
    }),
  ),
  canRecordVenueCheckIn: v.boolean(),
  canOverrideVenueIdentity: v.boolean(),
  canReverseVenueCheckIn: v.boolean(),
});

async function resolveVitCredential(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    personId: Id<"people">;
    stationId: Id<"attendanceStations">;
    currentCredential: CurrentVitCredential | undefined;
  },
): Promise<StaffedParticipantResult["credential"]> {
  if (args.currentCredential) {
    const [rebindGrantIds, suspendGrantIds] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: args.eventId,
        eventAccessSubjectId: args.eventAccessSubjectId,
        permissionKey: "attendance.credential.rebind",
        scopeType: "person",
        scopeId: args.personId,
      }),
      args.currentCredential.state === "active"
        ? matchingPermissionGrantIds(ctx, {
            eventId: args.eventId,
            eventAccessSubjectId: args.eventAccessSubjectId,
            permissionKey: "attendance.credential.suspend",
            scopeType: "person",
            scopeId: args.personId,
          })
        : Promise.resolve([]),
    ]);
    return {
      kind: "vit_id_barcode",
      state: args.currentCredential.state,
      credentialId: args.currentCredential._id,
      expectedCredentialVersion: args.currentCredential.version,
      canRebind: rebindGrantIds.length > 0,
      canSuspend: args.currentCredential.state === "active" && suspendGrantIds.length > 0,
    };
  }
  const grantIds = await matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: "attendance.credential.enrol",
    scopeType: "station",
    scopeId: args.stationId,
  });
  return {
    kind: "vit_id_barcode",
    state: "not_enrolled",
    canEnrol: grantIds.length > 0,
  };
}

type ExternalBadgePermission =
  | "attendance.badge.issue"
  | "attendance.badge.replace"
  | "attendance.badge.revoke";

async function requireExternalBadgeCommand(
  ctx: MutationCtx,
  args: {
    eventSlug: string;
    stationId: Id<"attendanceStations">;
    expectedConfigurationVersion: number;
    deviceInstallationId: Id<"attendanceDeviceInstallations">;
    deviceSecretHash: string;
    membershipId: Id<"eventMemberships">;
    permissionKey: ExternalBadgePermission;
  },
) {
  const { event, person, subject, station } = await requireStationPermission(ctx, {
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
  const membership = await ctx.db.get(args.membershipId);
  if (
    !membership ||
    membership.eventId !== event._id ||
    membership.participantClass !== "external_participant" ||
    membership.eligibilityStatus !== "eligible" ||
    membership.onboardingStatus !== "accepted"
  ) {
    throw new ConvexError({
      code: "EXTERNAL_PARTICIPANT_REQUIRED",
      message: "Choose an accepted external participant.",
    });
  }
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: args.permissionKey,
    scopeType: "person",
    scopeId: membership.personId,
  });
  return { event, person, station, membership, grantIds };
}

type StaffedResolutionMethod =
  | { kind: "vit_id_barcode"; lookupHash: string; symbology: Doc<"attendanceCredentials">["barcodeSymbology"] }
  | { kind: "external_pass" }
  | { kind: "manual_lookup" };

export function classifyVitScan(args: {
  current: { lookupHash: string; state: "active" | "suspended" } | undefined;
  scannedLookupHash: string;
}): NonNullable<StaffedParticipantResult["vitScanRelationship"]> {
  if (!args.current) return "unbound";
  if (args.current.lookupHash !== args.scannedLookupHash) return "replacement";
  return args.current.state === "active" ? "current_active" : "current_suspended";
}

async function staffedParticipantForMembership(
  ctx: MutationCtx,
  args: {
    eventSlug: string;
    stationId: Id<"attendanceStations">;
    expectedConfigurationVersion: number;
    deviceInstallationId: Id<"attendanceDeviceInstallations">;
    deviceSecretHash: string;
    membership: Doc<"eventMemberships">;
    method: StaffedResolutionMethod;
  },
): Promise<StaffedParticipantResult> {
  const { event, person, subject, station, grantIds } = await requireStationPermission(ctx, {
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
  const membership = args.membership;
  if (
    membership.eventId !== event._id ||
    membership.eligibilityStatus !== "eligible" ||
    membership.onboardingStatus !== "accepted"
  ) {
    throw new ConvexError({
      code: "PARTICIPANT_NOT_ACCEPTED",
      message: "This person is not an accepted RSVP participant for this event.",
    });
  }
  if (
    (args.method.kind === "vit_id_barcode" && membership.participantClass !== "vit_student") ||
    (args.method.kind === "external_pass" &&
      membership.participantClass !== "external_participant")
  ) {
    throw new ConvexError({
      code: "PARTICIPANT_CLASS_MISMATCH",
      message: "This credential does not match the participant class.",
    });
  }
  const [
    participantPerson,
    profile,
    memberCredentials,
    teamContext,
    latestCheckIn,
    recordCheckInGrantIds,
    overrideIdentityGrantIds,
    reverseCheckInGrantIds,
  ] = await Promise.all([
    ctx.db.get(membership.personId),
    ctx.db
      .query("participantProfiles")
      .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
      .unique(),
    ctx.db
      .query("attendanceCredentials")
      .withIndex("by_membership_state", (index) => index.eq("membershipId", membership._id))
      .collect(),
    currentTeamForMembership(ctx, event._id, membership._id),
    latestVenueCheckIn(ctx, membership._id),
    matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.venue_check_in.record",
      scopeType: "person",
      scopeId: membership.personId,
    }),
    matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.venue_check_in.override_identity",
      scopeType: "person",
      scopeId: membership.personId,
    }),
    matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.venue_check_in.reverse",
      scopeType: "person",
      scopeId: membership.personId,
    }),
  ]);
  if (!participantPerson || !profile || !teamContext) {
    throw new ConvexError({
      code: "PARTICIPANT_INCOMPLETE",
      message: "This participant's profile or team is incomplete. Send them to the help desk.",
    });
  }
  const currentVitCredential = memberCredentials.find(
    (credential): credential is CurrentVitCredential =>
      credential.kind === "vit_id_barcode" &&
      (credential.state === "active" || credential.state === "suspended"),
  );
  const credential: StaffedParticipantResult["credential"] =
    membership.participantClass === "vit_student"
      ? await resolveVitCredential(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          personId: membership.personId,
          stationId: station._id,
          currentCredential: currentVitCredential,
        })
      : { kind: "external_pass", state: "active" };
  const vitScanRelationship: StaffedParticipantResult["vitScanRelationship"] =
    args.method.kind !== "vit_id_barcode"
      ? undefined
      : classifyVitScan({
          current: currentVitCredential,
          scannedLookupHash: args.method.lookupHash,
        });
  const checkInStation = latestCheckIn ? await ctx.db.get(latestCheckIn.stationId) : null;
  if (latestCheckIn && (!checkInStation || checkInStation.eventId !== event._id)) {
    throw new ConvexError({
      code: "CHECK_IN_STATION_MISSING",
      message: "The station that recorded this check-in no longer exists.",
    });
  }
  const now = Date.now();
  const resolutionId = await createStaffedParticipantResolution(ctx, {
    eventId: event._id,
    membershipId: membership._id,
    resolutionMethod: args.method.kind,
    ...(args.method.kind === "vit_id_barcode"
      ? {
          barcodeLookupHash: args.method.lookupHash,
          ...(args.method.symbology !== undefined
            ? { barcodeSymbology: args.method.symbology }
            : {}),
        }
      : {}),
    stationId: station._id,
    deviceInstallationId: args.deviceInstallationId,
    resolvedByPersonId: person._id,
    now,
  });
  await writeAuditEvent(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    permissionKey: "attendance.station.read",
    grantIds,
    scopeType: "station",
    scopeId: station._id,
    action: "attendance.staffed_participant_resolved",
    targetType: "event_membership",
    targetId: membership._id,
    nextSummary: JSON.stringify({
      source: args.method.kind,
      participantClass: membership.participantClass,
      credentialKind: credential.kind,
      credentialState: credential.state,
      venueCheckInStatus: latestCheckIn?.status ?? "not_checked_in",
    }),
    reason: `Participant resolved by ${args.method.kind.replaceAll("_", " ")}`,
  });
  return {
    resolutionId,
    membershipId: membership._id,
    participantClass: membership.participantClass,
    displayName: profile.fullName ?? participantPerson.displayName,
    institution: profile.institution,
    teamName: teamContext.team.name,
    ...(profile.vitRegistrationNumber !== undefined
      ? { vitRegistrationNumber: profile.vitRegistrationNumber }
      : {}),
    ...(vitScanRelationship !== undefined ? { vitScanRelationship } : {}),
    credential,
    venueCheckIn:
      latestCheckIn && checkInStation
        ? {
            id: latestCheckIn._id,
            status: latestCheckIn.status,
            version: latestCheckIn.version,
            checkedInAt: latestCheckIn.checkedInAt,
            stationName: checkInStation.name,
            ...(latestCheckIn.reversedAt !== undefined
              ? { reversedAt: latestCheckIn.reversedAt }
              : {}),
          }
        : null,
    canRecordVenueCheckIn: recordCheckInGrantIds.length > 0,
    canOverrideVenueIdentity: overrideIdentityGrantIds.length > 0,
    canReverseVenueCheckIn: reverseCheckInGrantIds.length > 0,
  };
}

const staffedResolutionArgs = {
  eventSlug: v.string(),
  stationId: v.id("attendanceStations"),
  expectedConfigurationVersion: v.number(),
  deviceInstallationId: v.id("attendanceDeviceInstallations"),
  deviceSecretHash: v.string(),
};

export const resolveExternalPass = internalMutation({
  args: { ...staffedResolutionArgs, lookupHash: v.string() },
  returns: credentialParticipantResult,
  handler: async (ctx, args): Promise<StaffedParticipantResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const pass = await ctx.db
      .query("attendanceExternalPasses")
      .withIndex("by_event_lookup", (index) =>
        index.eq("eventId", event._id).eq("lookupHash", args.lookupHash),
      )
      .unique();
    if (!pass || pass.state !== "active") {
      throw new ConvexError({
        code: "EXTERNAL_PASS_INVALID",
        message: "This external event pass is invalid or suspended.",
      });
    }
    const membership = await ctx.db.get(pass.membershipId);
    if (!membership) throw new Error("External pass membership is missing.");
    return staffedParticipantForMembership(ctx, {
      ...args,
      membership,
      method: { kind: "external_pass" },
    });
  },
});

export const resolveVitBarcode = internalMutation({
  args: {
    ...staffedResolutionArgs,
    rawRegistrationNumber: v.string(),
    lookupHash: v.string(),
    symbology: barcodeSymbology,
  },
  returns: credentialParticipantResult,
  handler: async (ctx, args): Promise<StaffedParticipantResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const parsed = parseVitRegistrationNumber(
      args.rawRegistrationNumber,
      vitIdentityReferenceYear(event),
    );
    if (!parsed) {
      throw new ConvexError({
        code: "VIT_ID_BARCODE_INVALID",
        message: "The VIT ID barcode does not contain a valid registration number.",
      });
    }
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_vit_registration", (index) =>
        index.eq("eventId", event._id).eq("vitStudentIdentity.registrationNumber", parsed.registrationNumber),
      )
      .unique();
    if (!membership) {
      throw new ConvexError({
        code: "VIT_PARTICIPANT_NOT_FOUND",
        message: "No accepted RSVP participant matches this VIT registration number.",
      });
    }
    return staffedParticipantForMembership(ctx, {
      ...args,
      membership,
      method: { kind: "vit_id_barcode", lookupHash: args.lookupHash, symbology: args.symbology },
    });
  },
});

export const resolveManualParticipant = internalMutation({
  args: {
    ...staffedResolutionArgs,
    lookup: v.union(
      v.object({ kind: v.literal("vit_registration"), value: v.string() }),
      v.object({ kind: v.literal("external_email"), value: v.string() }),
    ),
  },
  returns: credentialParticipantResult,
  handler: async (ctx, args): Promise<StaffedParticipantResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    let membership: Doc<"eventMemberships"> | null = null;
    if (args.lookup.kind === "vit_registration") {
      const parsed = parseVitRegistrationNumber(args.lookup.value, vitIdentityReferenceYear(event));
      if (parsed) {
        membership = await ctx.db
          .query("eventMemberships")
          .withIndex("by_event_vit_registration", (index) =>
            index.eq("eventId", event._id).eq("vitStudentIdentity.registrationNumber", parsed.registrationNumber),
          )
          .unique();
      }
    } else {
      const subject = await ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_email", (index) =>
          index.eq("eventId", event._id).eq("emailNormalized", normalizeEmail(args.lookup.value)),
        )
        .unique();
      membership = subject
        ? await ctx.db
            .query("eventMemberships")
            .withIndex("by_event_person", (index) =>
              index.eq("eventId", event._id).eq("personId", subject.personId),
            )
            .unique()
        : null;
    }
    const expectedClass =
      args.lookup.kind === "vit_registration" ? "vit_student" : "external_participant";
    if (!membership || membership.participantClass !== expectedClass) {
      throw new ConvexError({
        code: "PARTICIPANT_NOT_FOUND",
        message:
          args.lookup.kind === "vit_registration"
            ? "No VIT participant matches that registration number."
            : "No external participant matches that email address.",
      });
    }
    return staffedParticipantForMembership(ctx, {
      ...args,
      membership,
      method: { kind: "manual_lookup" },
    });
  },
});

export const enrolResolvedVitBarcode = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    visibleIdentityConfirmed: v.boolean(),
    clientOperationId: v.string(),
  },
  returns: verifyResult,
  handler: async (ctx, args): Promise<VerifyResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.visibleIdentityConfirmed,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.credential.enrol_resolved_vit_barcode",
      requestFingerprint,
    });
    if (prior) {
      const credentialId = ctx.db.normalizeId("attendanceCredentials", prior.targetId);
      if (!credentialId) throw new Error("Stored VIT barcode enrolment is invalid.");
      return { credentialId, verified: true };
    }
    if (!args.visibleIdentityConfirmed) {
      throw new ConvexError({
        code: "IDENTITY_CHECK_REQUIRED",
        message: "Confirm the visible VIT ID before linking its barcode.",
      });
    }
    const { station, grantIds } = await requireStationPermission(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      permissionKey: "attendance.credential.enrol",
    });
    await requireAssignedDevice(ctx, {
      eventId: event._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
    });
    const resolutionCandidate = await ctx.db.get(args.resolutionId);
    if (!resolutionCandidate) {
      throw new ConvexError({
        code: "STAFFED_RESOLUTION_REQUIRED",
        message: "Scan the participant's VIT ID barcode before linking it.",
      });
    }
    const resolution = await requireAvailableStaffedCredentialResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      membershipId: resolutionCandidate.membershipId,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      now: Date.now(),
    });
    if (
      resolution.resolutionMethod !== "vit_id_barcode" ||
      resolution.barcodeLookupHash === undefined ||
      resolution.barcodeSymbology === undefined
    ) {
      throw new ConvexError({
        code: "VIT_BARCODE_RESOLUTION_REQUIRED",
        message: "Scan the participant's VIT ID barcode before linking it.",
      });
    }
    const barcodeLookupHash = resolution.barcodeLookupHash;
    const barcodeSymbology = resolution.barcodeSymbology;
    const membership = await ctx.db.get(resolution.membershipId);
    if (
      !membership ||
      membership.eventId !== event._id ||
      membership.participantClass !== "vit_student" ||
      membership.eligibilityStatus !== "eligible" ||
      membership.onboardingStatus !== "accepted"
    ) {
      throw new ConvexError({
        code: "VIT_PARTICIPANT_REQUIRED",
        message: "Choose an accepted VIT participant.",
      });
    }
    const existingForMember = await ctx.db
      .query("attendanceCredentials")
      .withIndex("by_membership_state", (index) => index.eq("membershipId", membership._id))
      .collect();
    if (
      existingForMember.some(
        (credential) =>
          credential.kind === "vit_id_barcode" &&
          (credential.state === "active" || credential.state === "suspended"),
      )
    ) {
      throw new ConvexError({
        code: "REBIND_REQUIRED",
        message: "This participant already has a VIT ID binding. Use the replacement workflow.",
      });
    }
    const hashMatches = await ctx.db
      .query("attendanceCredentials")
      .withIndex("by_event_lookup", (index) =>
        index.eq("eventId", event._id).eq("lookupHash", barcodeLookupHash),
      )
      .collect();
    if (
      hashMatches.some(
        (credential) =>
          credential.membershipId !== membership._id &&
          (credential.state === "active" || credential.state === "suspended"),
      )
    ) {
      throw new ConvexError({
        code: "BARCODE_ALREADY_BOUND",
        message: "This VIT ID barcode is already bound to another participant.",
      });
    }
    const now = Date.now();
    const credentialId = await ctx.db.insert("attendanceCredentials", {
      eventId: event._id,
      membershipId: membership._id,
      kind: "vit_id_barcode",
      lookupHash: barcodeLookupHash,
      barcodeSymbology,
      normalizationVersion: "trim-v1",
      version: 1,
      state: "active",
      enrolledByPersonId: person._id,
      enrolledAt: now,
      verifiedAt: now,
    });
    await claimStaffedCredentialResolution(ctx, {
      resolutionId: resolution._id,
      credentialAction: "begin_vit_enrolment",
      attendanceCredentialId: credentialId,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.credential.enrol_resolved_vit_barcode",
      requestFingerprint,
      targetType: "attendance_credential",
      targetId: credentialId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.credential.enrol",
      grantIds,
      scopeType: "station",
      scopeId: station._id,
      action: "attendance.vit_barcode_enrolled",
      targetType: "attendance_credential",
      targetId: credentialId,
      nextSummary: JSON.stringify({ membershipId: membership._id, state: "active" }),
      reason: "The scanned VIT registration number and visible ID matched the accepted participant",
    });
    return { credentialId, verified: true };
  },
});

export const linkResolvedExternalIdBarcode = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    lookupHash: v.string(),
    symbology: barcodeSymbology,
    visibleIdentityConfirmed: v.boolean(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    bindingId: v.id("attendanceExternalIdentityBindings"),
    verified: v.literal(true),
  }),
  handler: async (ctx, args): Promise<ExternalIdentityLinkResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.lookupHash,
      args.symbology,
      args.visibleIdentityConfirmed,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.external_identity.link",
      requestFingerprint,
    });
    if (prior) {
      const bindingId = ctx.db.normalizeId("attendanceExternalIdentityBindings", prior.targetId);
      if (!bindingId) throw new Error("Stored external identity binding is invalid.");
      return { bindingId, verified: true };
    }
    if (!args.visibleIdentityConfirmed) {
      throw new ConvexError({
        code: "IDENTITY_CHECK_REQUIRED",
        message: "Confirm the visible external photo ID before linking its barcode.",
      });
    }
    const { station, grantIds } = await requireStationPermission(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      permissionKey: "attendance.credential.enrol",
    });
    await requireAssignedDevice(ctx, {
      eventId: event._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
    });
    const resolutionCandidate = await ctx.db.get(args.resolutionId);
    if (!resolutionCandidate) {
      throw new ConvexError({
        code: "STAFFED_RESOLUTION_REQUIRED",
        message: "Scan the participant's external event pass before their physical ID.",
      });
    }
    const now = Date.now();
    const resolution = await requireAvailableStaffedCredentialResolution(ctx, {
      resolutionId: resolutionCandidate._id,
      eventId: event._id,
      membershipId: resolutionCandidate.membershipId,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      now,
    });
    if (
      resolution.resolutionMethod !== "external_pass" &&
      resolution.resolutionMethod !== "manual_lookup"
    ) {
      throw new ConvexError({
        code: "EXTERNAL_PASS_RESOLUTION_REQUIRED",
        message: "Scan the participant's external event pass before their physical ID.",
      });
    }
    const membership = await ctx.db.get(resolution.membershipId);
    if (
      !membership ||
      membership.eventId !== event._id ||
      membership.participantClass !== "external_participant" ||
      membership.eligibilityStatus !== "eligible" ||
      membership.onboardingStatus !== "accepted"
    ) {
      throw new ConvexError({
        code: "EXTERNAL_PARTICIPANT_REQUIRED",
        message: "Choose an accepted external participant.",
      });
    }
    const existing = await ctx.db
      .query("attendanceExternalIdentityBindings")
      .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
      .unique();
    if (existing && (existing.state !== "active" || existing.lookupHash !== args.lookupHash)) {
      throw new ConvexError({
        code: "EXTERNAL_ID_CHANGED",
        message: "This participant already has a different external ID. Ask a coordinator for help.",
      });
    }
    const collision = await ctx.db
      .query("attendanceExternalIdentityBindings")
      .withIndex("by_event_lookup", (index) =>
        index.eq("eventId", event._id).eq("lookupHash", args.lookupHash),
      )
      .unique();
    if (collision && collision.membershipId !== membership._id) {
      throw new ConvexError({
        code: "EXTERNAL_ID_ALREADY_BOUND",
        message: "This external ID is already linked to another participant.",
      });
    }
    const bindingId =
      existing?._id ??
      (await ctx.db.insert("attendanceExternalIdentityBindings", {
        eventId: event._id,
        membershipId: membership._id,
        lookupHash: args.lookupHash,
        barcodeSymbology: args.symbology,
        version: 1,
        state: "active",
        linkedByPersonId: person._id,
        linkedAt: now,
        updatedAt: now,
      }));
    await ctx.db.patch(resolution._id, {
      credentialAction: "link_external_id",
      credentialActionAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.external_identity.link",
      requestFingerprint,
      targetType: "attendance_external_identity_binding",
      targetId: bindingId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.credential.enrol",
      grantIds,
      scopeType: "station",
      scopeId: station._id,
      action: "attendance.external_identity_linked",
      targetType: "attendance_external_identity_binding",
      targetId: bindingId,
      nextSummary: JSON.stringify({
        membershipId: membership._id,
        barcodeSymbology: args.symbology,
        state: "active",
      }),
      reason: "The external event pass and visible physical ID matched the accepted participant",
    });
    return { bindingId, verified: true };
  },
});

export const beginVitBarcodeEnrollment = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    lookupHash: v.string(),
    symbology: barcodeSymbology,
    normalizationVersion: v.string(),
    visibleIdentityConfirmed: v.boolean(),
    clientOperationId: v.string(),
  },
  returns: beginResult,
  handler: async (ctx, args): Promise<BeginResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.membershipId,
      args.lookupHash,
      args.symbology,
      args.normalizationVersion,
      args.visibleIdentityConfirmed,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.credential.begin_vit_barcode",
      requestFingerprint,
    });
    if (prior) {
      const credentialId = ctx.db.normalizeId("attendanceCredentials", prior.targetId);
      if (!credentialId) {
        throw new Error("The stored VIT barcode enrolment result is invalid.");
      }
      return { credentialId, verificationRequired: true };
    }
    if (!args.visibleIdentityConfirmed) {
      throw new ConvexError({
        code: "IDENTITY_CHECK_REQUIRED",
        message: "Confirm the visible VIT ID matches the participant before enrolment.",
      });
    }
    const { station, grantIds } = await requireStationPermission(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      permissionKey: "attendance.credential.enrol",
    });
    await requireAssignedDevice(ctx, {
      eventId: event._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
    });
    const plan = await ctx.db.get(station.planVersionId);
    if (
      !plan ||
      plan.eventId !== event._id ||
      plan.status !== "published" ||
      plan.vitBarcodeNormalizationVersion !== args.normalizationVersion ||
      !plan.vitBarcodeSymbologies.some((symbology) => symbology === args.symbology)
    ) {
      throw new ConvexError({
        code: "BARCODE_NOT_ALLOWED",
        message: "This barcode format is not enabled for the station.",
      });
    }
    const membership = await ctx.db.get(args.membershipId);
    if (
      !membership ||
      membership.eventId !== event._id ||
      membership.participantClass !== "vit_student" ||
      membership.onboardingStatus !== "accepted"
    ) {
      throw new ConvexError({
        code: "VIT_PARTICIPANT_REQUIRED",
        message: "Choose an accepted VIT participant.",
      });
    }
    const now = Date.now();
    const resolution = await requireAvailableStaffedCredentialResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      membershipId: membership._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      now,
    });
    const memberCredentials = await ctx.db
      .query("attendanceCredentials")
      .withIndex("by_membership_state", (index) => index.eq("membershipId", membership._id))
      .collect();
    for (const credential of memberCredentials) {
      if (
        credential.state === "pending_verification" &&
        !isCurrentPendingAttendanceCredential(credential, now)
      ) {
        await expirePendingAttendanceCredential(ctx, {
          credentialId: credential._id,
          expectedVersion: credential.version,
          now,
        });
      }
    }
    const matchingCredentials = await ctx.db
      .query("attendanceCredentials")
      .withIndex("by_event_lookup", (index) =>
        index.eq("eventId", event._id).eq("lookupHash", args.lookupHash),
      )
      .collect();
    const liveMatch = matchingCredentials.find(
      (credential) =>
        credential.state === "active" ||
        credential.state === "suspended" ||
        isCurrentPendingAttendanceCredential(credential, now),
    );
    if (liveMatch && liveMatch.membershipId !== membership._id) {
      throw new ConvexError({
        code: "BARCODE_ALREADY_BOUND",
        message: "This VIT ID barcode is already bound to another participant.",
      });
    }
    const otherLiveCredential = memberCredentials.find(
      (credential) =>
        credential.kind === "vit_id_barcode" &&
        credential.lookupHash !== args.lookupHash &&
        (credential.state === "active" ||
          credential.state === "suspended" ||
          isCurrentPendingAttendanceCredential(credential, now)),
    );
    if (otherLiveCredential) {
      throw new ConvexError({
        code: "REBIND_REQUIRED",
        message: "This participant already has a VIT ID binding. Use the rebind workflow.",
      });
    }
    if (liveMatch?.state === "active") {
      throw new ConvexError({
        code: "ALREADY_ENROLLED",
        message: "This VIT ID is already enrolled.",
      });
    }
    if (liveMatch?.state === "suspended") {
      throw new ConvexError({
        code: "REBIND_REQUIRED",
        message: "This VIT ID binding is suspended. Use the exact-person rebind workflow.",
      });
    }
    if (liveMatch?.supersedesCredentialId !== undefined) {
      throw new ConvexError({
        code: "REBIND_IN_PROGRESS",
        message: "A VIT ID replacement is already waiting for its second scan.",
      });
    }
    if (liveMatch?.state === "pending_verification") {
      throw new ConvexError({
        code: "ENROLMENT_IN_PROGRESS",
        message: "This VIT ID is already waiting for its second scan.",
      });
    }
    const pendingExpiresAt = now + attendanceCredentialVerificationLifetimeMs;
    const credentialId = await ctx.db.insert("attendanceCredentials", {
      eventId: event._id,
      membershipId: membership._id,
      kind: "vit_id_barcode",
      lookupHash: args.lookupHash,
      barcodeSymbology: args.symbology,
      normalizationVersion: args.normalizationVersion,
      version: 1,
      state: "pending_verification",
      pendingExpiresAt,
      enrolledByPersonId: person._id,
      enrolledAt: now,
    });
    await ctx.scheduler.runAt(pendingExpiresAt, internal.attendanceCredentials.expirePending, {
      credentialId,
      expectedVersion: 1,
    });
    await claimStaffedCredentialResolution(ctx, {
      resolutionId: resolution._id,
      credentialAction: "begin_vit_enrolment",
      attendanceCredentialId: credentialId,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.credential.begin_vit_barcode",
      requestFingerprint,
      targetType: "attendance_credential",
      targetId: credentialId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.credential.enrol",
      grantIds,
      scopeType: "station",
      scopeId: station._id,
      action: "attendance.vit_barcode_enrolment_started",
      targetType: "attendance_credential",
      targetId: credentialId,
      nextSummary: JSON.stringify({ membershipId: membership._id, state: "pending_verification" }),
      reason: "Staff confirmed the visible VIT ID against the participant profile",
    });
    return { credentialId, verificationRequired: true };
  },
});

export const verifyVitBarcodeEnrollment = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    credentialId: v.id("attendanceCredentials"),
    lookupHash: v.string(),
    symbology: barcodeSymbology,
    clientOperationId: v.string(),
  },
  returns: verifyResult,
  handler: async (ctx, args): Promise<VerifyResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.credentialId,
      args.lookupHash,
      args.symbology,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.credential.verify_vit_barcode",
      requestFingerprint,
    });
    if (prior) return { credentialId: args.credentialId, verified: true };
    const { station, grantIds } = await requireStationPermission(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      permissionKey: "attendance.credential.enrol",
    });
    await requireAssignedDevice(ctx, {
      eventId: event._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
    });
    const credential = await ctx.db.get(args.credentialId);
    const now = Date.now();
    if (!credential || credential.eventId !== event._id || credential.kind !== "vit_id_barcode") {
      throw new ConvexError({
        code: "VERIFICATION_MISMATCH",
        message: "The second scan did not match the pending VIT ID enrolment.",
      });
    }
    await requireClaimedStaffedCredentialResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      membershipId: credential.membershipId,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      credentialAction: "begin_vit_enrolment",
      attendanceCredentialId: credential._id,
    });
    if (
      credential.state !== "pending_verification" ||
      credential.supersedesCredentialId !== undefined ||
      credential.lookupHash !== args.lookupHash ||
      credential.barcodeSymbology !== args.symbology
    ) {
      throw new ConvexError({
        code: "VERIFICATION_MISMATCH",
        message: "The second scan did not match the pending VIT ID enrolment.",
      });
    }
    if (!isCurrentPendingAttendanceCredential(credential, now)) {
      throw new ConvexError({
        code: "VERIFICATION_EXPIRED",
        message: "The VIT ID enrolment expired. Start again with the participant.",
      });
    }
    await ctx.db.patch(credential._id, {
      state: "active",
      version: credential.version + 1,
      pendingExpiresAt: undefined,
      verifiedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.credential.verify_vit_barcode",
      requestFingerprint,
      targetType: "attendance_credential",
      targetId: credential._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.credential.enrol",
      grantIds,
      scopeType: "station",
      scopeId: station._id,
      action: "attendance.vit_barcode_enrolled",
      targetType: "attendance_credential",
      targetId: credential._id,
      previousSummary: JSON.stringify({ state: "pending_verification" }),
      nextSummary: JSON.stringify({ membershipId: credential.membershipId, state: "active" }),
      reason: "The provisioned scanner read the same VIT ID barcode twice",
    });
    return { credentialId: credential._id, verified: true };
  },
});

export const beginVitBarcodeRebind = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    priorCredentialId: v.id("attendanceCredentials"),
    expectedPriorCredentialVersion: v.number(),
    lookupHash: v.string(),
    symbology: barcodeSymbology,
    normalizationVersion: v.string(),
    visibleIdentityConfirmed: v.boolean(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: beginResult,
  handler: async (ctx, args): Promise<BeginResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
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
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.membershipId,
      args.priorCredentialId,
      args.expectedPriorCredentialVersion,
      args.lookupHash,
      args.symbology,
      args.normalizationVersion,
      args.visibleIdentityConfirmed,
      reason,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.credential.begin_vit_barcode_rebind",
      requestFingerprint,
    });
    if (priorOperation) {
      const credentialId = ctx.db.normalizeId("attendanceCredentials", priorOperation.targetId);
      if (!credentialId) {
        throw new Error("The stored VIT barcode replacement result is invalid.");
      }
      return { credentialId, verificationRequired: true };
    }
    if (!args.visibleIdentityConfirmed) {
      throw new ConvexError({
        code: "IDENTITY_CHECK_REQUIRED",
        message: "Confirm the visible VIT ID matches the participant before replacement.",
      });
    }
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
    const [plan, membership, priorCredential] = await Promise.all([
      ctx.db.get(station.planVersionId),
      ctx.db.get(args.membershipId),
      ctx.db.get(args.priorCredentialId),
    ]);
    if (
      !plan ||
      plan.eventId !== event._id ||
      plan.status !== "published" ||
      plan.vitBarcodeNormalizationVersion !== args.normalizationVersion ||
      !plan.vitBarcodeSymbologies.some((symbology) => symbology === args.symbology)
    ) {
      throw new ConvexError({
        code: "BARCODE_NOT_ALLOWED",
        message: "This barcode format is not enabled for the station.",
      });
    }
    if (
      !membership ||
      membership.eventId !== event._id ||
      membership.participantClass !== "vit_student" ||
      membership.eligibilityStatus !== "eligible" ||
      membership.onboardingStatus !== "accepted"
    ) {
      throw new ConvexError({
        code: "VIT_PARTICIPANT_REQUIRED",
        message: "Choose an accepted VIT participant.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.credential.rebind",
      scopeType: "person",
      scopeId: membership.personId,
    });
    if (
      !priorCredential ||
      priorCredential.eventId !== event._id ||
      priorCredential.membershipId !== membership._id ||
      priorCredential.kind !== "vit_id_barcode" ||
      (priorCredential.state !== "active" && priorCredential.state !== "suspended") ||
      priorCredential.version !== args.expectedPriorCredentialVersion
    ) {
      throw new ConvexError({
        code: "PRIOR_CREDENTIAL_CHANGED",
        message: "The current VIT ID binding changed. Start the replacement again.",
      });
    }
    if (priorCredential.lookupHash === args.lookupHash) {
      throw new ConvexError({
        code: "SAME_BARCODE",
        message: "Choose a different VIT ID. The scanned barcode is the current binding.",
      });
    }
    const now = Date.now();
    const resolution = await requireAvailableStaffedCredentialResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      membershipId: membership._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      now,
    });
    const memberCredentials = await ctx.db
      .query("attendanceCredentials")
      .withIndex("by_membership_state", (index) => index.eq("membershipId", membership._id))
      .collect();
    for (const credential of memberCredentials) {
      if (
        credential.state === "pending_verification" &&
        !isCurrentPendingAttendanceCredential(credential, now)
      ) {
        await expirePendingAttendanceCredential(ctx, {
          credentialId: credential._id,
          expectedVersion: credential.version,
          now,
        });
      }
    }
    const currentPending = memberCredentials.find(
      (credential) =>
        credential.kind === "vit_id_barcode" &&
        isCurrentPendingAttendanceCredential(credential, now),
    );
    if (currentPending) {
      throw new ConvexError({
        code: "REBIND_IN_PROGRESS",
        message: "Another VIT ID replacement is waiting for its second scan.",
      });
    }
    const matchingCredentials = await ctx.db
      .query("attendanceCredentials")
      .withIndex("by_event_lookup", (index) =>
        index.eq("eventId", event._id).eq("lookupHash", args.lookupHash),
      )
      .collect();
    const conflictingCredential = matchingCredentials.find(
      (credential) =>
        credential.state === "active" || isCurrentPendingAttendanceCredential(credential, now),
    );
    if (conflictingCredential) {
      throw new ConvexError({
        code: "BARCODE_ALREADY_BOUND",
        message: "This VIT ID barcode is already bound to another active credential.",
      });
    }
    const pendingExpiresAt = now + attendanceCredentialVerificationLifetimeMs;
    const credentialId = await ctx.db.insert("attendanceCredentials", {
      eventId: event._id,
      membershipId: membership._id,
      kind: "vit_id_barcode",
      lookupHash: args.lookupHash,
      barcodeSymbology: args.symbology,
      normalizationVersion: args.normalizationVersion,
      version: 1,
      state: "pending_verification",
      supersedesCredentialId: priorCredential._id,
      replacementReason: reason,
      pendingExpiresAt,
      enrolledByPersonId: person._id,
      enrolledAt: now,
    });
    await ctx.scheduler.runAt(pendingExpiresAt, internal.attendanceCredentials.expirePending, {
      credentialId,
      expectedVersion: 1,
    });
    await claimStaffedCredentialResolution(ctx, {
      resolutionId: resolution._id,
      credentialAction: "begin_vit_rebind",
      attendanceCredentialId: credentialId,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.credential.begin_vit_barcode_rebind",
      requestFingerprint,
      targetType: "attendance_credential",
      targetId: credentialId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.credential.rebind",
      grantIds,
      scopeType: "person",
      scopeId: membership.personId,
      action: "attendance.vit_barcode_rebind_started",
      targetType: "attendance_credential",
      targetId: credentialId,
      previousSummary: JSON.stringify({
        credentialId: priorCredential._id,
        state: priorCredential.state,
        version: priorCredential.version,
      }),
      nextSummary: JSON.stringify({
        credentialId,
        state: "pending_verification",
        expiresAt: pendingExpiresAt,
      }),
      reason,
    });
    return { credentialId, verificationRequired: true };
  },
});

export const verifyVitBarcodeRebind = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    priorCredentialId: v.id("attendanceCredentials"),
    expectedPriorCredentialVersion: v.number(),
    replacementCredentialId: v.id("attendanceCredentials"),
    lookupHash: v.string(),
    symbology: barcodeSymbology,
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: verifyReplacementResult,
  handler: async (ctx, args): Promise<VerifyReplacementResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
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
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.membershipId,
      args.priorCredentialId,
      args.expectedPriorCredentialVersion,
      args.replacementCredentialId,
      args.lookupHash,
      args.symbology,
      reason,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.credential.verify_vit_barcode_rebind",
      requestFingerprint,
    });
    if (priorOperation) {
      return {
        credentialId: args.replacementCredentialId,
        replacedCredentialId: args.priorCredentialId,
        verified: true,
      };
    }
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
    const [plan, membership] = await Promise.all([
      ctx.db.get(station.planVersionId),
      ctx.db.get(args.membershipId),
    ]);
    if (
      !plan ||
      plan.eventId !== event._id ||
      plan.status !== "published" ||
      !plan.vitBarcodeSymbologies.some((symbology) => symbology === args.symbology)
    ) {
      throw new ConvexError({
        code: "BARCODE_NOT_ALLOWED",
        message: "This barcode format is not enabled for the station.",
      });
    }
    if (
      !membership ||
      membership.eventId !== event._id ||
      membership.participantClass !== "vit_student" ||
      membership.eligibilityStatus !== "eligible" ||
      membership.onboardingStatus !== "accepted"
    ) {
      throw new ConvexError({
        code: "VIT_PARTICIPANT_REQUIRED",
        message: "Choose an accepted VIT participant.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.credential.rebind",
      scopeType: "person",
      scopeId: membership.personId,
    });
    const [priorCredential, replacementCredential] = await Promise.all([
      ctx.db.get(args.priorCredentialId),
      ctx.db.get(args.replacementCredentialId),
    ]);
    if (!priorCredential || !replacementCredential) {
      throw new ConvexError({
        code: "VERIFICATION_MISMATCH",
        message: "The VIT ID replacement no longer matches this setup.",
      });
    }
    await requireClaimedStaffedCredentialResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      membershipId: membership._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      credentialAction: "begin_vit_rebind",
      attendanceCredentialId: replacementCredential._id,
    });
    const now = Date.now();
    const versions = await completeVitBarcodeReplacement(ctx, {
      eventId: event._id,
      membershipId: membership._id,
      priorCredentialId: args.priorCredentialId,
      expectedPriorCredentialVersion: args.expectedPriorCredentialVersion,
      replacementCredentialId: args.replacementCredentialId,
      lookupHash: args.lookupHash,
      symbology: args.symbology,
      actorPersonId: person._id,
      reason,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.credential.verify_vit_barcode_rebind",
      requestFingerprint,
      targetType: "attendance_credential",
      targetId: args.replacementCredentialId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.credential.rebind",
      grantIds,
      scopeType: "person",
      scopeId: membership.personId,
      action: "attendance.vit_barcode_rebound",
      targetType: "attendance_credential",
      targetId: args.replacementCredentialId,
      previousSummary: JSON.stringify({
        credentialId: args.priorCredentialId,
        state: versions.priorCredentialState,
        version: args.expectedPriorCredentialVersion,
      }),
      nextSummary: JSON.stringify({
        credentialId: args.replacementCredentialId,
        state: "active",
        version: versions.replacementCredentialVersion,
        replacedCredentialId: args.priorCredentialId,
        replacedCredentialVersion: versions.priorCredentialVersion,
      }),
      reason,
    });
    return {
      credentialId: args.replacementCredentialId,
      replacedCredentialId: args.priorCredentialId,
      verified: true,
    };
  },
});

export const suspendVitBarcode = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    credentialId: v.id("attendanceCredentials"),
    expectedCredentialVersion: v.number(),
    visibleIdentityConfirmed: v.boolean(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: suspendVitResult,
  handler: async (ctx, args): Promise<SuspendVitResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
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
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.membershipId,
      args.credentialId,
      args.expectedCredentialVersion,
      args.visibleIdentityConfirmed,
      reason,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.credential.suspend_vit_barcode",
      requestFingerprint,
    });
    if (priorOperation) return { credentialId: args.credentialId, suspended: true };
    if (!args.visibleIdentityConfirmed) {
      throw new ConvexError({
        code: "IDENTITY_CHECK_REQUIRED",
        message: "Confirm the participant's visible identity before suspending the VIT ID.",
      });
    }
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
    const membership = await ctx.db.get(args.membershipId);
    if (
      !membership ||
      membership.eventId !== event._id ||
      membership.participantClass !== "vit_student" ||
      membership.eligibilityStatus !== "eligible" ||
      membership.onboardingStatus !== "accepted"
    ) {
      throw new ConvexError({
        code: "VIT_PARTICIPANT_REQUIRED",
        message: "Choose an accepted VIT participant.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.credential.suspend",
      scopeType: "person",
      scopeId: membership.personId,
    });
    const now = Date.now();
    const resolution = await requireAvailableStaffedCredentialResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      membershipId: membership._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      now,
    });
    const result = await suspendActiveVitBarcode(ctx, {
      eventId: event._id,
      membershipId: membership._id,
      credentialId: args.credentialId,
      expectedCredentialVersion: args.expectedCredentialVersion,
      actorPersonId: person._id,
      reason,
      now,
    });
    await claimStaffedCredentialResolution(ctx, {
      resolutionId: resolution._id,
      credentialAction: "suspend_vit",
      attendanceCredentialId: args.credentialId,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.credential.suspend_vit_barcode",
      requestFingerprint,
      targetType: "attendance_credential",
      targetId: args.credentialId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.credential.suspend",
      grantIds,
      scopeType: "person",
      scopeId: membership.personId,
      action: "attendance.vit_barcode_suspended",
      targetType: "attendance_credential",
      targetId: args.credentialId,
      previousSummary: JSON.stringify({
        state: "active",
        version: args.expectedCredentialVersion,
      }),
      nextSummary: JSON.stringify({
        state: "suspended",
        version: result.credentialVersion,
        cancelledPendingReplacementCount: result.cancelledPendingCredentialIds.length,
      }),
      reason,
    });
    return { credentialId: args.credentialId, suspended: true };
  },
});

export const beginExternalBadgeIssue = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    lookupHash: v.string(),
    badgeReference: v.string(),
    visibleIdentityConfirmed: v.boolean(),
    clientOperationId: v.string(),
  },
  returns: beginBadgeResult,
  handler: async (ctx, args): Promise<BeginBadgeResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const clientOperationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      10,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.membershipId,
      args.lookupHash,
      args.badgeReference,
      args.visibleIdentityConfirmed,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.badge.begin_issue",
      requestFingerprint,
    });
    if (priorOperation) {
      const credentialId = ctx.db.normalizeId("attendanceCredentials", priorOperation.targetId);
      if (!credentialId) {
        throw new Error("The stored external badge issue result is invalid.");
      }
      return {
        credentialId,
        badgeReference: args.badgeReference,
        verificationRequired: true,
      };
    }
    if (!args.visibleIdentityConfirmed) {
      throw new ConvexError({
        code: "IDENTITY_CHECK_REQUIRED",
        message: "Confirm the participant's visible identity before issuing a badge.",
      });
    }
    const context = await requireExternalBadgeCommand(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
      membershipId: args.membershipId,
      permissionKey: "attendance.badge.issue",
    });
    const now = Date.now();
    const resolution = await requireAvailableStaffedCredentialResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      membershipId: context.membership._id,
      stationId: context.station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      now,
    });
    const memberCredentials = await ctx.db
      .query("attendanceCredentials")
      .withIndex("by_membership_state", (index) => index.eq("membershipId", context.membership._id))
      .collect();
    for (const credential of memberCredentials) {
      if (
        credential.kind === "badge_qr" &&
        credential.state === "pending_verification" &&
        !isCurrentPendingAttendanceCredential(credential, now)
      ) {
        await expirePendingAttendanceCredential(ctx, {
          credentialId: credential._id,
          expectedVersion: credential.version,
          now,
        });
      }
    }
    if (
      memberCredentials.some(
        (credential) => credential.kind === "badge_qr" && credential.state === "active",
      )
    ) {
      throw new ConvexError({
        code: "REPLACEMENT_REQUIRED",
        message: "This participant already has an active event badge. Use replacement instead.",
      });
    }
    const currentPending = memberCredentials.find(
      (credential) =>
        credential.kind === "badge_qr" && isCurrentPendingAttendanceCredential(credential, now),
    );
    if (currentPending) {
      throw new ConvexError({
        code: "BADGE_SETUP_IN_PROGRESS",
        message: "Another event badge is waiting for its second scan.",
      });
    }
    const [lookupMatches, referenceMatches] = await Promise.all([
      ctx.db
        .query("attendanceCredentials")
        .withIndex("by_event_lookup", (index) =>
          index.eq("eventId", event._id).eq("lookupHash", args.lookupHash),
        )
        .collect(),
      ctx.db
        .query("attendanceCredentials")
        .withIndex("by_event_badge_reference", (index) =>
          index.eq("eventId", event._id).eq("badgeReference", args.badgeReference),
        )
        .collect(),
    ]);
    if (lookupMatches.length > 0 || referenceMatches.length > 0) {
      throw new ConvexError({
        code: "BADGE_ALREADY_USED",
        message: "This event badge was already used. Choose a different printed badge.",
      });
    }
    const pendingExpiresAt = now + attendanceCredentialVerificationLifetimeMs;
    const credentialId = await ctx.db.insert("attendanceCredentials", {
      eventId: event._id,
      membershipId: context.membership._id,
      kind: "badge_qr",
      lookupHash: args.lookupHash,
      badgeReference: args.badgeReference,
      version: 1,
      state: "pending_verification",
      pendingExpiresAt,
      enrolledByPersonId: person._id,
      enrolledAt: now,
    });
    await ctx.scheduler.runAt(pendingExpiresAt, internal.attendanceCredentials.expirePending, {
      credentialId,
      expectedVersion: 1,
    });
    await claimStaffedCredentialResolution(ctx, {
      resolutionId: resolution._id,
      credentialAction: "begin_badge_issue",
      attendanceCredentialId: credentialId,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.badge.begin_issue",
      requestFingerprint,
      targetType: "attendance_credential",
      targetId: credentialId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.badge.issue",
      grantIds: context.grantIds,
      scopeType: "person",
      scopeId: context.membership.personId,
      action: "attendance.external_badge_issue_started",
      targetType: "attendance_credential",
      targetId: credentialId,
      nextSummary: JSON.stringify({
        membershipId: context.membership._id,
        badgeReference: args.badgeReference,
        state: "pending_verification",
        expiresAt: pendingExpiresAt,
      }),
      reason: "Staff confirmed the participant's visible identity before badge issue",
    });
    return {
      credentialId,
      badgeReference: args.badgeReference,
      verificationRequired: true,
    };
  },
});

export const verifyExternalBadgeIssue = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    credentialId: v.id("attendanceCredentials"),
    lookupHash: v.string(),
    badgeReference: v.string(),
    clientOperationId: v.string(),
  },
  returns: verifyBadgeResult,
  handler: async (ctx, args): Promise<VerifyBadgeResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const clientOperationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      10,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.membershipId,
      args.credentialId,
      args.lookupHash,
      args.badgeReference,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.badge.verify_issue",
      requestFingerprint,
    });
    if (priorOperation) {
      return {
        credentialId: args.credentialId,
        badgeReference: args.badgeReference,
        verified: true,
      };
    }
    const context = await requireExternalBadgeCommand(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
      membershipId: args.membershipId,
      permissionKey: "attendance.badge.issue",
    });
    const now = Date.now();
    const credential = await ctx.db.get(args.credentialId);
    if (
      !credential ||
      credential.eventId !== event._id ||
      credential.membershipId !== context.membership._id ||
      credential.kind !== "badge_qr"
    ) {
      throw new ConvexError({
        code: "VERIFICATION_MISMATCH",
        message: "The event badge no longer matches this setup.",
      });
    }
    await requireClaimedStaffedCredentialResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      membershipId: context.membership._id,
      stationId: context.station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      credentialAction: "begin_badge_issue",
      attendanceCredentialId: credential._id,
    });
    const versions = await completeExternalBadgeIssue(ctx, {
      eventId: event._id,
      membershipId: context.membership._id,
      credentialId: args.credentialId,
      lookupHash: args.lookupHash,
      badgeReference: args.badgeReference,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.badge.verify_issue",
      requestFingerprint,
      targetType: "attendance_credential",
      targetId: args.credentialId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.badge.issue",
      grantIds: context.grantIds,
      scopeType: "person",
      scopeId: context.membership.personId,
      action: "attendance.external_badge_issued",
      targetType: "attendance_credential",
      targetId: args.credentialId,
      previousSummary: JSON.stringify({ state: "pending_verification" }),
      nextSummary: JSON.stringify({
        membershipId: context.membership._id,
        badgeReference: args.badgeReference,
        state: "active",
        version: versions.credentialVersion,
      }),
      reason: "The provisioned scanner read the same printed event badge twice",
    });
    return {
      credentialId: args.credentialId,
      badgeReference: args.badgeReference,
      verified: true,
    };
  },
});

export const beginExternalBadgeReplacement = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    priorCredentialId: v.id("attendanceCredentials"),
    expectedPriorCredentialVersion: v.number(),
    lookupHash: v.string(),
    badgeReference: v.string(),
    visibleIdentityConfirmed: v.boolean(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: beginBadgeResult,
  handler: async (ctx, args): Promise<BeginBadgeResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
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
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.membershipId,
      args.priorCredentialId,
      args.expectedPriorCredentialVersion,
      args.lookupHash,
      args.badgeReference,
      args.visibleIdentityConfirmed,
      reason,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.badge.begin_replace",
      requestFingerprint,
    });
    if (priorOperation) {
      const credentialId = ctx.db.normalizeId("attendanceCredentials", priorOperation.targetId);
      if (!credentialId) {
        throw new Error("The stored external badge replacement result is invalid.");
      }
      return {
        credentialId,
        badgeReference: args.badgeReference,
        verificationRequired: true,
      };
    }
    if (!args.visibleIdentityConfirmed) {
      throw new ConvexError({
        code: "IDENTITY_CHECK_REQUIRED",
        message: "Confirm the participant's visible identity before replacing a badge.",
      });
    }
    const context = await requireExternalBadgeCommand(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
      membershipId: args.membershipId,
      permissionKey: "attendance.badge.replace",
    });
    const priorCredential = await ctx.db.get(args.priorCredentialId);
    if (
      !priorCredential ||
      priorCredential.eventId !== event._id ||
      priorCredential.membershipId !== context.membership._id ||
      priorCredential.kind !== "badge_qr" ||
      priorCredential.state !== "active" ||
      priorCredential.version !== args.expectedPriorCredentialVersion
    ) {
      throw new ConvexError({
        code: "PRIOR_CREDENTIAL_CHANGED",
        message: "The active event badge changed. Start the replacement again.",
      });
    }
    if (
      priorCredential.lookupHash === args.lookupHash ||
      priorCredential.badgeReference === args.badgeReference
    ) {
      throw new ConvexError({
        code: "SAME_BADGE",
        message: "Scan a different printed badge for the replacement.",
      });
    }
    const now = Date.now();
    const resolution = await requireAvailableStaffedCredentialResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      membershipId: context.membership._id,
      stationId: context.station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      now,
    });
    const memberCredentials = await ctx.db
      .query("attendanceCredentials")
      .withIndex("by_membership_state", (index) => index.eq("membershipId", context.membership._id))
      .collect();
    for (const credential of memberCredentials) {
      if (
        credential.kind === "badge_qr" &&
        credential.state === "pending_verification" &&
        !isCurrentPendingAttendanceCredential(credential, now)
      ) {
        await expirePendingAttendanceCredential(ctx, {
          credentialId: credential._id,
          expectedVersion: credential.version,
          now,
        });
      }
    }
    const currentPending = memberCredentials.find(
      (credential) =>
        credential.kind === "badge_qr" && isCurrentPendingAttendanceCredential(credential, now),
    );
    if (currentPending) {
      throw new ConvexError({
        code: "BADGE_REPLACEMENT_IN_PROGRESS",
        message: "Another event-badge replacement is waiting for its second scan.",
      });
    }
    const [lookupMatches, referenceMatches] = await Promise.all([
      ctx.db
        .query("attendanceCredentials")
        .withIndex("by_event_lookup", (index) =>
          index.eq("eventId", event._id).eq("lookupHash", args.lookupHash),
        )
        .collect(),
      ctx.db
        .query("attendanceCredentials")
        .withIndex("by_event_badge_reference", (index) =>
          index.eq("eventId", event._id).eq("badgeReference", args.badgeReference),
        )
        .collect(),
    ]);
    if (lookupMatches.length > 0 || referenceMatches.length > 0) {
      throw new ConvexError({
        code: "BADGE_ALREADY_USED",
        message: "This event badge was already used. Choose a different printed badge.",
      });
    }
    const pendingExpiresAt = now + attendanceCredentialVerificationLifetimeMs;
    const credentialId = await ctx.db.insert("attendanceCredentials", {
      eventId: event._id,
      membershipId: context.membership._id,
      kind: "badge_qr",
      lookupHash: args.lookupHash,
      badgeReference: args.badgeReference,
      version: 1,
      state: "pending_verification",
      supersedesCredentialId: priorCredential._id,
      replacementReason: reason,
      pendingExpiresAt,
      enrolledByPersonId: person._id,
      enrolledAt: now,
    });
    await ctx.scheduler.runAt(pendingExpiresAt, internal.attendanceCredentials.expirePending, {
      credentialId,
      expectedVersion: 1,
    });
    await claimStaffedCredentialResolution(ctx, {
      resolutionId: resolution._id,
      credentialAction: "begin_badge_replacement",
      attendanceCredentialId: credentialId,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.badge.begin_replace",
      requestFingerprint,
      targetType: "attendance_credential",
      targetId: credentialId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.badge.replace",
      grantIds: context.grantIds,
      scopeType: "person",
      scopeId: context.membership.personId,
      action: "attendance.external_badge_replacement_started",
      targetType: "attendance_credential",
      targetId: credentialId,
      previousSummary: JSON.stringify({
        credentialId: priorCredential._id,
        badgeReference: priorCredential.badgeReference,
        state: "active",
        version: priorCredential.version,
      }),
      nextSummary: JSON.stringify({
        credentialId,
        badgeReference: args.badgeReference,
        state: "pending_verification",
        expiresAt: pendingExpiresAt,
      }),
      reason,
    });
    return {
      credentialId,
      badgeReference: args.badgeReference,
      verificationRequired: true,
    };
  },
});

export const verifyExternalBadgeReplacement = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    priorCredentialId: v.id("attendanceCredentials"),
    expectedPriorCredentialVersion: v.number(),
    replacementCredentialId: v.id("attendanceCredentials"),
    lookupHash: v.string(),
    badgeReference: v.string(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: verifyBadgeReplacementResult,
  handler: async (ctx, args): Promise<VerifyBadgeReplacementResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
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
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.membershipId,
      args.priorCredentialId,
      args.expectedPriorCredentialVersion,
      args.replacementCredentialId,
      args.lookupHash,
      args.badgeReference,
      reason,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.badge.verify_replace",
      requestFingerprint,
    });
    if (priorOperation) {
      return {
        credentialId: args.replacementCredentialId,
        replacedCredentialId: args.priorCredentialId,
        badgeReference: args.badgeReference,
        verified: true,
      };
    }
    const context = await requireExternalBadgeCommand(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
      membershipId: args.membershipId,
      permissionKey: "attendance.badge.replace",
    });
    const now = Date.now();
    const [priorCredential, replacementCredential] = await Promise.all([
      ctx.db.get(args.priorCredentialId),
      ctx.db.get(args.replacementCredentialId),
    ]);
    if (
      !priorCredential ||
      !replacementCredential ||
      replacementCredential.eventId !== event._id ||
      replacementCredential.membershipId !== context.membership._id ||
      replacementCredential.kind !== "badge_qr"
    ) {
      throw new ConvexError({
        code: "VERIFICATION_MISMATCH",
        message: "The event-badge replacement no longer matches this setup.",
      });
    }
    await requireClaimedStaffedCredentialResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      membershipId: context.membership._id,
      stationId: context.station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      credentialAction: "begin_badge_replacement",
      attendanceCredentialId: replacementCredential._id,
    });
    const versions = await completeExternalBadgeReplacement(ctx, {
      eventId: event._id,
      membershipId: context.membership._id,
      priorCredentialId: args.priorCredentialId,
      expectedPriorCredentialVersion: args.expectedPriorCredentialVersion,
      replacementCredentialId: args.replacementCredentialId,
      lookupHash: args.lookupHash,
      badgeReference: args.badgeReference,
      actorPersonId: person._id,
      reason,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.badge.verify_replace",
      requestFingerprint,
      targetType: "attendance_credential",
      targetId: args.replacementCredentialId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.badge.replace",
      grantIds: context.grantIds,
      scopeType: "person",
      scopeId: context.membership.personId,
      action: "attendance.external_badge_replaced",
      targetType: "attendance_credential",
      targetId: args.replacementCredentialId,
      previousSummary: JSON.stringify({
        credentialId: args.priorCredentialId,
        state: "active",
        version: args.expectedPriorCredentialVersion,
      }),
      nextSummary: JSON.stringify({
        credentialId: args.replacementCredentialId,
        badgeReference: args.badgeReference,
        state: "active",
        version: versions.replacementCredentialVersion,
        replacedCredentialId: args.priorCredentialId,
        replacedCredentialVersion: versions.priorCredentialVersion,
      }),
      reason,
    });
    return {
      credentialId: args.replacementCredentialId,
      replacedCredentialId: args.priorCredentialId,
      badgeReference: args.badgeReference,
      verified: true,
    };
  },
});

export const revokeExternalBadge = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    credentialId: v.id("attendanceCredentials"),
    expectedCredentialVersion: v.number(),
    visibleIdentityConfirmed: v.boolean(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: revokeBadgeResult,
  handler: async (ctx, args): Promise<RevokeBadgeResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
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
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.resolutionId,
      args.membershipId,
      args.credentialId,
      args.expectedCredentialVersion,
      args.visibleIdentityConfirmed,
      reason,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.badge.revoke",
      requestFingerprint,
    });
    if (priorOperation) return { credentialId: args.credentialId, revoked: true };
    if (!args.visibleIdentityConfirmed) {
      throw new ConvexError({
        code: "IDENTITY_CHECK_REQUIRED",
        message: "Confirm the participant's visible identity before revoking a badge.",
      });
    }
    const context = await requireExternalBadgeCommand(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
      membershipId: args.membershipId,
      permissionKey: "attendance.badge.revoke",
    });
    const now = Date.now();
    const resolution = await requireAvailableStaffedCredentialResolution(ctx, {
      resolutionId: args.resolutionId,
      eventId: event._id,
      membershipId: context.membership._id,
      stationId: context.station._id,
      deviceInstallationId: args.deviceInstallationId,
      actorPersonId: person._id,
      now,
    });
    const result = await revokeActiveExternalBadge(ctx, {
      eventId: event._id,
      membershipId: context.membership._id,
      credentialId: args.credentialId,
      expectedCredentialVersion: args.expectedCredentialVersion,
      actorPersonId: person._id,
      reason,
      now,
    });
    await claimStaffedCredentialResolution(ctx, {
      resolutionId: resolution._id,
      credentialAction: "revoke_badge",
      attendanceCredentialId: args.credentialId,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.badge.revoke",
      requestFingerprint,
      targetType: "attendance_credential",
      targetId: args.credentialId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.badge.revoke",
      grantIds: context.grantIds,
      scopeType: "person",
      scopeId: context.membership.personId,
      action: "attendance.external_badge_revoked",
      targetType: "attendance_credential",
      targetId: args.credentialId,
      previousSummary: JSON.stringify({
        state: "active",
        version: args.expectedCredentialVersion,
      }),
      nextSummary: JSON.stringify({
        state: "revoked",
        version: result.credentialVersion,
        cancelledPendingReplacementCount: result.cancelledPendingCredentialIds.length,
      }),
      reason,
    });
    return { credentialId: args.credentialId, revoked: true };
  },
});

export const expirePending = internalMutation({
  args: {
    credentialId: v.id("attendanceCredentials"),
    expectedVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await expirePendingAttendanceCredential(ctx, {
      credentialId: args.credentialId,
      expectedVersion: args.expectedVersion,
      now: Date.now(),
    });
    return null;
  },
});
