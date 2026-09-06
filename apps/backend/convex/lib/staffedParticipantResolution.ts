import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { BarcodeSymbology } from "@code2create/domain";

export const staffedParticipantResolutionLifetimeMs = 2 * 60_000;

type StaffedResolutionContext = {
  resolutionId: Id<"staffedParticipantResolutions">;
  eventId: Id<"events">;
  stationId: Id<"attendanceStations">;
  deviceInstallationId: Id<"attendanceDeviceInstallations">;
  actorPersonId: Id<"people">;
};

type StaffedCredentialAction = NonNullable<
  Doc<"staffedParticipantResolutions">["credentialAction"]
>;

export async function createStaffedParticipantResolution(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membershipId: Id<"eventMemberships">;
    resolutionMethod: "vit_id_barcode" | "external_pass" | "external_id_barcode" | "manual_lookup";
    barcodeLookupHash?: string;
    barcodeSymbology?: BarcodeSymbology;
    stationId: Id<"attendanceStations">;
    deviceInstallationId: Id<"attendanceDeviceInstallations">;
    resolvedByPersonId: Id<"people">;
    now: number;
  },
) {
  return ctx.db.insert("staffedParticipantResolutions", {
    eventId: args.eventId,
    membershipId: args.membershipId,
    resolutionMethod: args.resolutionMethod,
    ...(args.barcodeLookupHash !== undefined
      ? { barcodeLookupHash: args.barcodeLookupHash }
      : {}),
    ...(args.barcodeSymbology !== undefined ? { barcodeSymbology: args.barcodeSymbology } : {}),
    stationId: args.stationId,
    deviceInstallationId: args.deviceInstallationId,
    resolvedByPersonId: args.resolvedByPersonId,
    resolvedAt: args.now,
    expiresAt: args.now + staffedParticipantResolutionLifetimeMs,
  });
}

export async function requireAvailableStaffedVenueResolution(
  ctx: MutationCtx,
  args: StaffedResolutionContext & { now: number },
) {
  const resolution = await requireStaffedResolutionContext(ctx, args);
  if (resolution.expiresAt <= args.now) {
    throw new ConvexError({
      code: "STAFFED_RESOLUTION_EXPIRED",
      message: "This participant check expired. Resolve the participant again.",
    });
  }
  if (resolution.venueAction !== undefined) {
    throw new ConvexError({
      code: "STAFFED_RESOLUTION_USED",
      message: "Resolve the participant again before another venue check-in action.",
    });
  }
  return resolution;
}

export async function requireAvailableStaffedCredentialResolution(
  ctx: MutationCtx,
  args: StaffedResolutionContext & {
    membershipId: Id<"eventMemberships">;
    now: number;
  },
) {
  const resolution = await requireStaffedResolutionContext(ctx, args);
  requireResolutionMembership(resolution, args.membershipId);
  if (resolution.expiresAt <= args.now) {
    throw new ConvexError({
      code: "STAFFED_RESOLUTION_EXPIRED",
      message: "This participant check expired. Resolve the participant again.",
    });
  }
  if (resolution.credentialAction !== undefined) {
    throw new ConvexError({
      code: "STAFFED_CREDENTIAL_RESOLUTION_USED",
      message: "Resolve the participant again before another credential action.",
    });
  }
  return resolution;
}

export async function requireClaimedStaffedCredentialResolution(
  ctx: MutationCtx,
  args: StaffedResolutionContext & {
    membershipId: Id<"eventMemberships">;
    credentialAction: StaffedCredentialAction;
    attendanceCredentialId: Id<"attendanceCredentials">;
  },
) {
  const resolution = await requireStaffedResolutionContext(ctx, args);
  requireResolutionMembership(resolution, args.membershipId);
  if (
    resolution.credentialAction !== args.credentialAction ||
    resolution.attendanceCredentialId !== args.attendanceCredentialId
  ) {
    throw new ConvexError({
      code: "STAFFED_CREDENTIAL_RESOLUTION_REQUIRED",
      message: "Resolve this participant again before restarting credential setup.",
    });
  }
  return resolution;
}

export async function claimStaffedCredentialResolution(
  ctx: MutationCtx,
  args: {
    resolutionId: Id<"staffedParticipantResolutions">;
    credentialAction: StaffedCredentialAction;
    attendanceCredentialId: Id<"attendanceCredentials">;
    now: number;
  },
) {
  await ctx.db.patch(args.resolutionId, {
    credentialAction: args.credentialAction,
    credentialActionAt: args.now,
    attendanceCredentialId: args.attendanceCredentialId,
  });
}

async function requireStaffedResolutionContext(ctx: MutationCtx, args: StaffedResolutionContext) {
  const resolution = await ctx.db.get(args.resolutionId);
  if (
    !resolution ||
    resolution.eventId !== args.eventId ||
    resolution.stationId !== args.stationId ||
    resolution.deviceInstallationId !== args.deviceInstallationId ||
    resolution.resolvedByPersonId !== args.actorPersonId
  ) {
    throw new ConvexError({
      code: "STAFFED_RESOLUTION_REQUIRED",
      message: "Resolve this participant on this phone before continuing.",
    });
  }
  return resolution;
}

function requireResolutionMembership(
  resolution: Doc<"staffedParticipantResolutions">,
  membershipId: Id<"eventMemberships">,
) {
  if (resolution.membershipId !== membershipId) {
    throw new ConvexError({
      code: "STAFFED_RESOLUTION_REQUIRED",
      message: "Resolve this participant before continuing.",
    });
  }
}
