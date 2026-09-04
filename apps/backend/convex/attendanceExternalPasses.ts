import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireAssignedDevice, requireStationPermission } from "./lib/attendance";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject, requireMembership } from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { requireAvailableStaffedCredentialResolution } from "./lib/staffedParticipantResolution";
import { normalizedText } from "./lib/strings";

const externalPassResult = v.object({
  passId: v.id("attendanceExternalPasses"),
  encryptedBearer: v.string(),
  bearerIv: v.string(),
  bearerAuthTag: v.string(),
  version: v.number(),
});

type ExternalPassResult = {
  passId: Id<"attendanceExternalPasses">;
  encryptedBearer: string;
  bearerIv: string;
  bearerAuthTag: string;
  version: number;
};

const externalPassStateResult = v.object({
  passId: v.id("attendanceExternalPasses"),
  state: v.union(v.literal("active"), v.literal("suspended")),
  version: v.number(),
});

type ExternalPassStateResult = {
  passId: Id<"attendanceExternalPasses">;
  state: "active" | "suspended";
  version: number;
};

const externalPassCommandArgs = {
  eventSlug: v.string(),
  stationId: v.id("attendanceStations"),
  expectedConfigurationVersion: v.number(),
  deviceInstallationId: v.id("attendanceDeviceInstallations"),
  deviceSecretHash: v.string(),
  resolutionId: v.id("staffedParticipantResolutions"),
  membershipId: v.id("eventMemberships"),
  passId: v.id("attendanceExternalPasses"),
  expectedPassVersion: v.number(),
  visibleIdentityConfirmed: v.boolean(),
  reason: v.string(),
  clientOperationId: v.string(),
};

type ExternalPassCommand = {
  eventSlug: string;
  stationId: Id<"attendanceStations">;
  expectedConfigurationVersion: number;
  deviceInstallationId: Id<"attendanceDeviceInstallations">;
  deviceSecretHash: string;
  resolutionId: Id<"staffedParticipantResolutions">;
  membershipId: Id<"eventMemberships">;
  passId: Id<"attendanceExternalPasses">;
  expectedPassVersion: number;
  visibleIdentityConfirmed: boolean;
};

async function requireExternalPassCommand(
  ctx: MutationCtx,
  args: ExternalPassCommand & {
    eventId: Id<"events">;
    actorPersonId: Id<"people">;
    permissionKey: "attendance.credential.suspend" | "attendance.credential.rebind";
  },
) {
  const { subject, station } = await requireStationPermission(ctx, {
    eventSlug: args.eventSlug,
    stationId: args.stationId,
    expectedConfigurationVersion: args.expectedConfigurationVersion,
    permissionKey: "attendance.station.read",
  });
  await requireAssignedDevice(ctx, {
    eventId: args.eventId,
    stationId: station._id,
    deviceInstallationId: args.deviceInstallationId,
    deviceSecretHash: args.deviceSecretHash,
  });
  if (!args.visibleIdentityConfirmed) {
    throw new ConvexError({
      code: "IDENTITY_CHECK_REQUIRED",
      message: "Confirm the participant's visible photo ID before changing the event pass.",
    });
  }
  const [membership, pass] = await Promise.all([
    ctx.db.get(args.membershipId),
    ctx.db.get(args.passId),
  ]);
  if (
    !membership ||
    membership.eventId !== args.eventId ||
    membership.participantClass !== "external_participant" ||
    membership.eligibilityStatus !== "eligible" ||
    membership.onboardingStatus !== "accepted" ||
    !pass ||
    pass.eventId !== args.eventId ||
    pass.membershipId !== membership._id
  ) {
    throw new ConvexError({
      code: "EXTERNAL_PASS_NOT_AVAILABLE",
      message: "Choose an accepted external participant with an event pass.",
    });
  }
  if (pass.version !== args.expectedPassVersion) {
    throw new ConvexError({
      code: "EXTERNAL_PASS_CHANGED",
      message: "The external event pass changed. Resolve the participant again.",
    });
  }
  const grantIds = await requirePermission(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: subject._id,
    permissionKey: args.permissionKey,
    scopeType: "person",
    scopeId: membership.personId,
  });
  const now = Date.now();
  const resolution = await requireAvailableStaffedCredentialResolution(ctx, {
    resolutionId: args.resolutionId,
    eventId: args.eventId,
    membershipId: membership._id,
    stationId: station._id,
    deviceInstallationId: args.deviceInstallationId,
    actorPersonId: args.actorPersonId,
    now,
  });
  if (
    resolution.resolutionMethod !== "external_pass" &&
    resolution.resolutionMethod !== "manual_lookup"
  ) {
    throw new ConvexError({
      code: "EXTERNAL_PASS_RESOLUTION_REQUIRED",
      message: "Resolve this external participant before changing their event pass.",
    });
  }
  return { grantIds, membership, now, pass, resolution };
}

function requireCandidate(args: {
  encryptedBearer: string;
  bearerIv: string;
  bearerAuthTag: string;
  lookupHash: string;
}) {
  if (
    !/^[A-Za-z0-9_-]+$/u.test(args.encryptedBearer) ||
    !/^[A-Za-z0-9_-]{16}$/u.test(args.bearerIv) ||
    !/^[A-Za-z0-9_-]{22}$/u.test(args.bearerAuthTag) ||
    !/^[a-f0-9]{64}$/u.test(args.lookupHash)
  ) {
    throw new Error("External event-pass candidate is invalid.");
  }
}

async function ensureExternalPass(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membership: Doc<"eventMemberships">;
    encryptedBearer: string;
    bearerIv: string;
    bearerAuthTag: string;
    lookupHash: string;
  },
): Promise<ExternalPassResult> {
  if (
    args.membership.eventId !== args.eventId ||
    args.membership.participantClass !== "external_participant" ||
    args.membership.eligibilityStatus !== "eligible" ||
    args.membership.onboardingStatus !== "accepted"
  ) {
    throw new ConvexError({
      code: "EXTERNAL_PASS_NOT_AVAILABLE",
      message: "Event passes are available only to accepted external participants.",
    });
  }
  const existing = await ctx.db
    .query("attendanceExternalPasses")
    .withIndex("by_membership", (index) => index.eq("membershipId", args.membership._id))
    .unique();
  if (existing?.state === "suspended") {
    throw new ConvexError({
      code: "EXTERNAL_PASS_SUSPENDED",
      message: "This external event pass is suspended. Ask event support for help.",
    });
  }
  if (existing) {
    return {
      passId: existing._id,
      encryptedBearer: existing.encryptedBearer,
      bearerIv: existing.bearerIv,
      bearerAuthTag: existing.bearerAuthTag,
      version: existing.version,
    };
  }
  requireCandidate(args);
  const collision = await ctx.db
    .query("attendanceExternalPasses")
    .withIndex("by_event_lookup", (index) =>
      index.eq("eventId", args.eventId).eq("lookupHash", args.lookupHash),
    )
    .unique();
  if (collision) throw new Error("External event-pass token collision.");
  const now = Date.now();
  const passId = await ctx.db.insert("attendanceExternalPasses", {
    eventId: args.eventId,
    membershipId: args.membership._id,
    encryptedBearer: args.encryptedBearer,
    bearerIv: args.bearerIv,
    bearerAuthTag: args.bearerAuthTag,
    lookupHash: args.lookupHash,
    version: 1,
    state: "active",
    issuedAt: now,
    updatedAt: now,
  });
  return {
    passId,
    encryptedBearer: args.encryptedBearer,
    bearerIv: args.bearerIv,
    bearerAuthTag: args.bearerAuthTag,
    version: 1,
  };
}

export const ensureMine = internalMutation({
  args: {
    eventSlug: v.string(),
    encryptedBearer: v.string(),
    bearerIv: v.string(),
    bearerAuthTag: v.string(),
    lookupHash: v.string(),
  },
  returns: externalPassResult,
  handler: async (ctx, args): Promise<ExternalPassResult> => {
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
    return ensureExternalPass(ctx, {
      eventId: event._id,
      membership,
      encryptedBearer: args.encryptedBearer,
      bearerIv: args.bearerIv,
      bearerAuthTag: args.bearerAuthTag,
      lookupHash: args.lookupHash,
    });
  },
});

export const ensureForDelivery = internalMutation({
  args: {
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    encryptedBearer: v.string(),
    bearerIv: v.string(),
    bearerAuthTag: v.string(),
    lookupHash: v.string(),
  },
  returns: externalPassResult,
  handler: async (ctx, args): Promise<ExternalPassResult> => {
    const membership = await ctx.db.get(args.membershipId);
    if (!membership) {
      throw new ConvexError({
        code: "PARTICIPANT_NOT_FOUND",
        message: "The external participant no longer exists.",
      });
    }
    return ensureExternalPass(ctx, {
      eventId: args.eventId,
      membership,
      encryptedBearer: args.encryptedBearer,
      bearerIv: args.bearerIv,
      bearerAuthTag: args.bearerAuthTag,
      lookupHash: args.lookupHash,
    });
  },
});

export const suspend = internalMutation({
  args: externalPassCommandArgs,
  returns: externalPassStateResult,
  handler: async (ctx, args): Promise<ExternalPassStateResult> => {
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
      args.passId,
      args.expectedPassVersion,
      args.visibleIdentityConfirmed,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.external_pass.suspend",
      requestFingerprint,
    });
    if (prior) {
      return { passId: args.passId, state: "suspended", version: args.expectedPassVersion + 1 };
    }
    const command = await requireExternalPassCommand(ctx, {
      ...args,
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.credential.suspend",
    });
    if (command.pass.state !== "active") {
      throw new ConvexError({
        code: "EXTERNAL_PASS_CHANGED",
        message: "The external event pass changed. Resolve the participant again.",
      });
    }
    const version = command.pass.version + 1;
    await ctx.db.patch(command.pass._id, {
      state: "suspended",
      version,
      updatedAt: command.now,
    });
    await ctx.db.patch(command.resolution._id, {
      credentialAction: "suspend_external_pass",
      credentialActionAt: command.now,
      attendanceExternalPassId: command.pass._id,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.external_pass.suspend",
      requestFingerprint,
      targetType: "attendance_external_pass",
      targetId: command.pass._id,
      resultJson: String(version),
      createdAt: command.now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.credential.suspend",
      grantIds: command.grantIds,
      scopeType: "person",
      scopeId: command.membership.personId,
      action: "attendance.external_pass_suspended",
      targetType: "attendance_external_pass",
      targetId: command.pass._id,
      previousSummary: JSON.stringify({
        state: command.pass.state,
        version: command.pass.version,
      }),
      nextSummary: JSON.stringify({ state: "suspended", version }),
      reason,
    });
    return { passId: command.pass._id, state: "suspended", version };
  },
});

export const reissue = internalMutation({
  args: {
    ...externalPassCommandArgs,
    encryptedBearer: v.string(),
    bearerIv: v.string(),
    bearerAuthTag: v.string(),
    lookupHash: v.string(),
  },
  returns: externalPassStateResult,
  handler: async (ctx, args): Promise<ExternalPassStateResult> => {
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
      args.passId,
      args.expectedPassVersion,
      args.visibleIdentityConfirmed,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.external_pass.reissue",
      requestFingerprint,
    });
    if (prior) {
      return { passId: args.passId, state: "active", version: args.expectedPassVersion + 1 };
    }
    requireCandidate(args);
    const command = await requireExternalPassCommand(ctx, {
      ...args,
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.credential.rebind",
    });
    const collision = await ctx.db
      .query("attendanceExternalPasses")
      .withIndex("by_event_lookup", (index) =>
        index.eq("eventId", event._id).eq("lookupHash", args.lookupHash),
      )
      .unique();
    if (collision && collision._id !== command.pass._id) {
      throw new Error("External event-pass token collision.");
    }
    const version = command.pass.version + 1;
    await ctx.db.patch(command.pass._id, {
      encryptedBearer: args.encryptedBearer,
      bearerIv: args.bearerIv,
      bearerAuthTag: args.bearerAuthTag,
      lookupHash: args.lookupHash,
      state: "active",
      issuedAt: command.now,
      version,
      updatedAt: command.now,
    });
    await ctx.db.patch(command.resolution._id, {
      credentialAction: "reissue_external_pass",
      credentialActionAt: command.now,
      attendanceExternalPassId: command.pass._id,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "attendance.external_pass.reissue",
      requestFingerprint,
      targetType: "attendance_external_pass",
      targetId: command.pass._id,
      resultJson: String(version),
      createdAt: command.now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.credential.rebind",
      grantIds: command.grantIds,
      scopeType: "person",
      scopeId: command.membership.personId,
      action: "attendance.external_pass_reissued",
      targetType: "attendance_external_pass",
      targetId: command.pass._id,
      previousSummary: JSON.stringify({
        state: command.pass.state,
        version: command.pass.version,
      }),
      nextSummary: JSON.stringify({ state: "active", version }),
      reason,
    });
    return { passId: command.pass._id, state: "active", version };
  },
});

export const detailsForWallet = internalQuery({
  args: { passId: v.string() },
  returns: v.object({
    passId: v.id("attendanceExternalPasses"),
    eventSlug: v.string(),
    eventName: v.string(),
    eventStartsAt: v.number(),
    eventEndsAt: v.number(),
    eventTimezone: v.string(),
    venueName: v.string(),
    participantName: v.string(),
    teamName: v.string(),
    encryptedBearer: v.string(),
    bearerIv: v.string(),
    bearerAuthTag: v.string(),
  }),
  handler: async (ctx, args) => {
    const passId = ctx.db.normalizeId("attendanceExternalPasses", args.passId);
    const pass = passId ? await ctx.db.get(passId) : null;
    if (!pass || pass.state !== "active") {
      throw new ConvexError({
        code: "EXTERNAL_PASS_NOT_AVAILABLE",
        message: "This external event pass is not active.",
      });
    }
    const [event, membership] = await Promise.all([
      ctx.db.get(pass.eventId),
      ctx.db.get(pass.membershipId),
    ]);
    if (
      !event ||
      !membership ||
      membership.eventId !== pass.eventId ||
      membership.participantClass !== "external_participant" ||
      membership.eligibilityStatus !== "eligible" ||
      membership.onboardingStatus !== "accepted"
    ) {
      throw new ConvexError({
        code: "EXTERNAL_PASS_NOT_AVAILABLE",
        message: "This external event pass no longer belongs to an accepted participant.",
      });
    }
    const [person, teamMember, communicationsPolicy] = await Promise.all([
      ctx.db.get(membership.personId),
      ctx.db
        .query("teamMembers")
        .withIndex("by_event_membership_status", (index) =>
          index.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
        )
        .unique(),
      event.publishedCommunicationsPolicyId
        ? ctx.db.get(event.publishedCommunicationsPolicyId)
        : null,
    ]);
    if (
      !person ||
      !teamMember ||
      !communicationsPolicy ||
      communicationsPolicy.eventId !== event._id ||
      communicationsPolicy.status !== "published"
    ) {
      throw new ConvexError({
        code: "EXTERNAL_PASS_NOT_AVAILABLE",
        message: "The event pass details are not currently available.",
      });
    }
    const team = await ctx.db.get(teamMember.teamId);
    if (!team || team.eventId !== event._id) {
      throw new Error("The external event pass team is missing.");
    }
    return {
      passId: pass._id,
      eventSlug: event.slug,
      eventName: event.name,
      eventStartsAt: communicationsPolicy.startsAt,
      eventEndsAt: communicationsPolicy.endsAt,
      eventTimezone: event.timezone,
      venueName: communicationsPolicy.venueName,
      participantName: person.displayName,
      teamName: team.name,
      encryptedBearer: pass.encryptedBearer,
      bearerIv: pass.bearerIv,
      bearerAuthTag: pass.bearerAuthTag,
    };
  },
});
