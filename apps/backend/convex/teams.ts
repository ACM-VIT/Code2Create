import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { advanceAccessVersion } from "./lib/accessVersion";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug, requireRegistrationOpen } from "./lib/events";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEligibleMembership,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { insertPermissionGrant, requirePermission, revokeSourceGrants } from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import {
  loadPublishedParticipantPolicy,
  participantClassesMeetPolicy,
} from "./lib/participantPolicy";
import { normalizeCode, normalizedText } from "./lib/strings";

const acceptedTransferState: "accepted" = "accepted";
const declinedTransferState: "declined" = "declined";
const teamMemberPermissionKeys = [
  "team.read",
  "team.leave",
  "team.project.write",
  "project.checkpoint.read",
  "team.lead.accept",
  "floor.team.read",
  "floor.team_qr.mint",
  "queue.participant.read",
  "review.team_qr.mint",
  "score.feedback.read",
] as const;
const teamLeadPermissionKeys = [
  "team.members.manage",
  "team.lead.transfer",
  "application.information.respond",
  "application.offer.respond",
  "integration.github.manage",
  "integration.figma.manage",
] as const;

const teamView = v.object({
  id: v.id("teams"),
  name: v.string(),
  publicCode: v.string(),
  status: v.string(),
  membershipLocked: v.boolean(),
  trackLocked: v.boolean(),
  teamMinimumSize: v.number(),
  teamMaximumSize: v.number(),
  mixedParticipantClassesAllowed: v.boolean(),
  version: v.number(),
  currentMembershipId: v.id("eventMemberships"),
  currentRole: v.union(v.literal("lead"), v.literal("member")),
  members: v.array(
    v.object({
      teamMemberId: v.id("teamMembers"),
      membershipId: v.id("eventMemberships"),
      role: v.union(v.literal("lead"), v.literal("member")),
      displayName: v.string(),
      institution: v.optional(v.string()),
      participantClass: v.string(),
    }),
  ),
  pendingLeadershipTransfer: v.union(
    v.null(),
    v.object({
      id: v.id("teamLeadershipTransfers"),
      fromMembershipId: v.id("eventMemberships"),
      toMembershipId: v.id("eventMemberships"),
      expiresAt: v.number(),
    }),
  ),
});

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.union(v.null(), teamView),
  handler: async (ctx, args) => {
    const person = await findCurrentPerson(ctx);
    if (!person) return null;
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!membership) return null;
    const currentMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (!currentMember) return null;
    const team = await ctx.db.get(currentMember.teamId);
    if (!team) return null;
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.read",
      scopeType: "team",
      scopeId: team._id,
    });
    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    const memberRows = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_status", (index) =>
        index.eq("teamId", team._id).eq("status", "active"),
      )
      .collect();
    const members = await Promise.all(
      memberRows.map(async (member) => {
        const eventMembership = await ctx.db.get(member.membershipId);
        if (!eventMembership) throw new Error("Team member references a missing membership.");
        const memberPerson = await ctx.db.get(eventMembership.personId);
        if (!memberPerson) throw new Error("Membership references a missing person.");
        const profile = await ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) => index.eq("membershipId", member.membershipId))
          .unique();
        return {
          teamMemberId: member._id,
          membershipId: member.membershipId,
          role: member.role,
          displayName: profile?.preferredName ?? profile?.fullName ?? memberPerson.displayName,
          ...(profile?.institution !== undefined
            ? { institution: profile.institution }
            : {}),
          participantClass: eventMembership.participantClass,
        };
      }),
    );
    const pendingTransfer = await ctx.db
      .query("teamLeadershipTransfers")
      .withIndex("by_team_state", (index) =>
        index.eq("teamId", team._id).eq("state", "pending"),
      )
      .first();
    const pendingLeadershipTransfer =
      pendingTransfer &&
      pendingTransfer.expiresAt > Date.now() &&
      pendingTransfer.expectedTeamVersion === team.version
        ? pendingTransfer
        : null;
    return {
      id: team._id,
      name: team.name,
      publicCode: team.publicCode,
      status: team.status,
      membershipLocked: team.membershipLocked,
      trackLocked: team.trackLocked,
      teamMinimumSize: participantPolicy.normalized.teamMinimumSize,
      teamMaximumSize: participantPolicy.normalized.teamMaximumSize,
      mixedParticipantClassesAllowed:
        participantPolicy.normalized.mixedParticipantClassesAllowed,
      version: team.version,
      currentMembershipId: membership._id,
      currentRole: currentMember.role,
      members,
      pendingLeadershipTransfer: pendingLeadershipTransfer
        ? {
            id: pendingLeadershipTransfer._id,
            fromMembershipId: pendingLeadershipTransfer.fromMembershipId,
            toMembershipId: pendingLeadershipTransfer.toMembershipId,
            expiresAt: pendingLeadershipTransfer.expiresAt,
          }
        : null,
    };
  },
});

function randomTeamCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return Array.from(bytes, (byte) => alphabet.charAt(byte % alphabet.length)).join("");
}

async function unusedTeamCode(ctx: MutationCtx, eventId: Id<"events">) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = randomTeamCode();
    const match = await ctx.db
      .query("teams")
      .withIndex("by_event_code", (index) => index.eq("eventId", eventId).eq("publicCode", code))
      .unique();
    if (!match) return code;
  }
  throw new Error("Could not allocate a unique team code.");
}

function requireCurrentPolicyAcceptance(
  membership: Doc<"eventMemberships">,
  participantPolicy: Doc<"participantPolicyVersions">,
) {
  if (!membership.acceptedParticipantPolicyVersionIds.includes(participantPolicy._id)) {
    throw new ConvexError({
      code: "POLICY_REQUIRED",
      message: "Accept the current participant policy before creating or joining a team.",
    });
  }
}

async function requireNoActiveTeam(
  ctx: MutationCtx,
  eventId: Id<"events">,
  membershipId: Id<"eventMemberships">,
) {
  const currentMember = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index.eq("eventId", eventId).eq("membershipId", membershipId).eq("status", "active"),
    )
    .unique();
  if (currentMember) {
    throw new ConvexError({
      code: "ALREADY_ON_TEAM",
      message: "A participant can be active on only one team in this event.",
    });
  }
}

export async function addTeamMemberGrants(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    membership: Doc<"eventMemberships">;
    teamId: Id<"teams">;
    teamMemberId: Id<"teamMembers">;
    actorPersonId: Id<"people">;
    lead: boolean;
  },
) {
  const subject = await ctx.db.get(args.membership.eventAccessSubjectId);
  if (!subject || subject.status !== "active") throw new Error("Team member subject is not active.");
  let createdCount = 0;
  for (const permissionKey of teamMemberPermissionKeys) {
    const result = await insertPermissionGrant(ctx, {
      eventId: args.event._id,
      personId: args.membership.personId,
      eventAccessSubjectId: subject._id,
      permissionKey,
      scopeType: "team",
      scopeId: args.teamId,
      sourceType: "team_membership",
      sourceId: args.teamMemberId,
      grantedByPersonId: args.actorPersonId,
      reason: "Active team membership",
    });
    if (result.created) createdCount += 1;
  }
  if (createdCount > 0) {
    await advanceAccessVersion(ctx, subject._id, Date.now());
  }
  if (!args.lead) return;
  await addTeamLeadGrants(ctx, args);
}

async function addTeamLeadGrants(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    membership: Doc<"eventMemberships">;
    teamId: Id<"teams">;
    actorPersonId: Id<"people">;
  },
) {
  const subject = await ctx.db.get(args.membership.eventAccessSubjectId);
  if (!subject || subject.status !== "active") throw new Error("Team lead subject is not active.");
  let createdCount = 0;
  for (const permissionKey of teamLeadPermissionKeys) {
    const result = await insertPermissionGrant(ctx, {
      eventId: args.event._id,
      personId: args.membership.personId,
      eventAccessSubjectId: subject._id,
      permissionKey,
      scopeType: "team",
      scopeId: args.teamId,
      sourceType: "team_lead",
      sourceId: `${args.teamId}:${args.membership._id}`,
      grantedByPersonId: args.actorPersonId,
      reason: "Current team lead",
    });
    if (result.created) createdCount += 1;
  }
  if (createdCount > 0) {
    await advanceAccessVersion(ctx, subject._id, Date.now());
  }
}

async function existingOperationTeam(
  ctx: MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  clientOperationId: string,
  commandName: string,
  requestFingerprint: string,
) {
  const operation = await findOperation(ctx, {
    eventId,
    actorPersonId: personId,
    clientOperationId,
    commandName,
    requestFingerprint,
  });
  if (!operation) return null;
  const teamId = ctx.db.normalizeId("teams", operation.targetId);
  if (!teamId) throw new Error("The prior team result is invalid.");
  return teamId;
}

async function existingOperationTransfer(
  ctx: MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  clientOperationId: string,
  commandName: string,
  requestFingerprint: string,
) {
  const operation = await findOperation(ctx, {
    eventId,
    actorPersonId: personId,
    clientOperationId,
    commandName,
    requestFingerprint,
  });
  if (!operation) return null;
  const transferId = ctx.db.normalizeId("teamLeadershipTransfers", operation.targetId);
  if (!transferId) throw new Error("The prior leadership-transfer result is invalid.");
  return transferId;
}

async function cancelPendingLeadershipTransfers(
  ctx: MutationCtx,
  args: {
    teamId: Id<"teams">;
    decidedByPersonId: Id<"people">;
    decidedAt: number;
  },
) {
  const pendingTransfers = await ctx.db
    .query("teamLeadershipTransfers")
    .withIndex("by_team_state", (index) =>
      index.eq("teamId", args.teamId).eq("state", "pending"),
    )
    .collect();
  for (const transfer of pendingTransfers) {
    await ctx.db.patch(transfer._id, {
      state: "cancelled",
      decidedByPersonId: args.decidedByPersonId,
      decidedAt: args.decidedAt,
    });
  }
}

export const create = mutation({
  args: { eventSlug: v.string(), name: v.string(), clientOperationId: v.string() },
  returns: v.object({ teamId: v.id("teams"), publicCode: v.string() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([args.name]);
    const replayTeamId = await existingOperationTeam(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "team.create",
      requestFingerprint,
    );
    if (replayTeamId) {
      const replayTeam = await ctx.db.get(replayTeamId);
      if (!replayTeam) throw new Error("The prior team operation no longer resolves.");
      return { teamId: replayTeam._id, publicCode: replayTeam.publicCode };
    }
    requireRegistrationOpen(event);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = requireEligibleMembership(
      await requireMembership(ctx, event._id, person._id),
    );
    requireCurrentPolicyAcceptance(membership, participantPolicy.policy);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.join",
      scopeType: "self",
      scopeId: membership._id,
    });
    await requireNoActiveTeam(ctx, event._id, membership._id);

    const now = Date.now();
    const publicCode = await unusedTeamCode(ctx, event._id);
    const teamId = await ctx.db.insert("teams", {
      eventId: event._id,
      name: normalizedText(args.name, "Team name", 2, 60),
      publicCode,
      leadMembershipId: membership._id,
      status: "forming",
      membershipLocked: false,
      trackLocked: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const teamMemberId = await ctx.db.insert("teamMembers", {
      eventId: event._id,
      teamId,
      membershipId: membership._id,
      role: "lead",
      status: "active",
      joinedAt: now,
      source: "created",
    });
    await addTeamMemberGrants(ctx, {
      event,
      membership,
      teamId,
      teamMemberId,
      actorPersonId: person._id,
      lead: true,
    });
    await ctx.db.patch(membership._id, {
      onboardingStatus:
        membership.onboardingStatus === "profile_required" ? "profile_required" : "project_required",
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "team.create",
      requestFingerprint,
      targetType: "team",
      targetId: teamId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.join",
      grantIds,
      scopeType: "self",
      scopeId: membership._id,
      action: "team.created",
      targetType: "team",
      targetId: teamId,
      nextSummary: JSON.stringify({ name: args.name.trim(), memberCount: 1 }),
      reason: "Participant created a team",
    });
    return { teamId, publicCode };
  },
});

export const join = mutation({
  args: { eventSlug: v.string(), code: v.string(), clientOperationId: v.string() },
  returns: v.object({ teamId: v.id("teams") }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    const { person } = await requireCurrentPerson(ctx);
    const code = normalizeCode(args.code);
    const requestFingerprint = operationFingerprint([code]);
    const replayTeamId = await existingOperationTeam(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "team.join",
      requestFingerprint,
    );
    if (replayTeamId) return { teamId: replayTeamId };
    requireRegistrationOpen(event);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = requireEligibleMembership(
      await requireMembership(ctx, event._id, person._id),
    );
    requireCurrentPolicyAcceptance(membership, participantPolicy.policy);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.join",
      scopeType: "self",
      scopeId: membership._id,
    });
    await requireNoActiveTeam(ctx, event._id, membership._id);

    const team = await ctx.db
      .query("teams")
      .withIndex("by_event_code", (index) => index.eq("eventId", event._id).eq("publicCode", code))
      .unique();
    if (!team || team.status === "withdrawn" || team.status === "disqualified") {
      throw new ConvexError({ code: "TEAM_NOT_FOUND", message: "That team code is not active." });
    }
    if (team.membershipLocked) {
      throw new ConvexError({ code: "TEAM_LOCKED", message: "That team has already submitted." });
    }
    const activeMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_status", (index) => index.eq("teamId", team._id).eq("status", "active"))
      .collect();
    if (activeMembers.length >= participantPolicy.normalized.teamMaximumSize) {
      throw new ConvexError({ code: "TEAM_FULL", message: "That team is full." });
    }
    const participantClasses = await Promise.all(
      activeMembers.map(async (activeMember) => {
        const activeMembership = await ctx.db.get(activeMember.membershipId);
        if (!activeMembership) throw new Error("Team member references a missing membership.");
        return activeMembership.participantClass;
      }),
    );
    if (
      !participantClassesMeetPolicy(
        [...participantClasses, membership.participantClass],
        participantPolicy.normalized,
      )
    ) {
      throw new ConvexError({
        code: "MIXED_TEAM_NOT_ALLOWED",
        message: "The current participant policy does not allow mixed VIT and external teams.",
      });
    }

    const now = Date.now();
    const teamMemberId = await ctx.db.insert("teamMembers", {
      eventId: event._id,
      teamId: team._id,
      membershipId: membership._id,
      role: "member",
      status: "active",
      joinedAt: now,
      source: "code",
    });
    await addTeamMemberGrants(ctx, {
      event,
      membership,
      teamId: team._id,
      teamMemberId,
      actorPersonId: person._id,
      lead: false,
    });
    await cancelPendingLeadershipTransfers(ctx, {
      teamId: team._id,
      decidedByPersonId: person._id,
      decidedAt: now,
    });
    await ctx.db.patch(team._id, { version: team.version + 1, updatedAt: now });
    await ctx.db.patch(membership._id, {
      onboardingStatus:
        membership.onboardingStatus === "profile_required" ? "profile_required" : "project_required",
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "team.join",
      requestFingerprint,
      targetType: "team",
      targetId: team._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.join",
      grantIds,
      scopeType: "self",
      scopeId: membership._id,
      action: "team.member_joined",
      targetType: "team",
      targetId: team._id,
      previousSummary: JSON.stringify({ memberCount: activeMembers.length }),
      nextSummary: JSON.stringify({ memberCount: activeMembers.length + 1 }),
      reason: "Participant joined with team code",
    });
    return { teamId: team._id };
  },
});

export const leave = mutation({
  args: {
    eventSlug: v.string(),
    teamId: v.id("teams"),
    expectedTeamVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ teamId: v.id("teams") }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([args.teamId, args.expectedTeamVersion]);
    const replayTeamId = await existingOperationTeam(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "team.leave",
      requestFingerprint,
    );
    if (replayTeamId) return { teamId: replayTeamId };

    requireRegistrationOpen(event);

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (!member || member.teamId !== args.teamId) {
      throw new ConvexError({ code: "NOT_ON_TEAM", message: "You are not on that team." });
    }
    const team = await ctx.db.get(args.teamId);
    if (!team || team.eventId !== event._id) {
      throw new ConvexError({ code: "TEAM_NOT_FOUND", message: "That team is not available." });
    }
    if (team.membershipLocked) {
      throw new ConvexError({ code: "TEAM_LOCKED", message: "Team membership is locked." });
    }
    if (team.version !== args.expectedTeamVersion) {
      throw new ConvexError({
        code: "TEAM_CHANGED",
        message: "The team changed. Review it and try again.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.leave",
      scopeType: "team",
      scopeId: team._id,
    });
    const activeMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_status", (index) =>
        index.eq("teamId", team._id).eq("status", "active"),
      )
      .collect();
    if (member.role === "lead" && activeMembers.length > 1) {
      throw new ConvexError({
        code: "TRANSFER_LEADERSHIP_FIRST",
        message: "Transfer leadership before leaving this team.",
      });
    }

    const now = Date.now();
    const withdrawTeam = activeMembers.length === 1;
    await ctx.db.patch(member._id, { status: "left", leftAt: now });
    if (withdrawTeam) {
      await ctx.db.patch(team._id, {
        status: "withdrawn",
        version: team.version + 1,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(team._id, { version: team.version + 1, updatedAt: now });
    }
    await ctx.db.patch(membership._id, { onboardingStatus: "team_required", updatedAt: now });
    await cancelPendingLeadershipTransfers(ctx, {
      teamId: team._id,
      decidedByPersonId: person._id,
      decidedAt: now,
    });
    await revokeSourceGrants(ctx, {
      eventId: event._id,
      sourceType: "team_membership",
      sourceId: member._id,
      revokedByPersonId: person._id,
      reason: "Participant left the team",
    });
    if (member.role === "lead") {
      await revokeSourceGrants(ctx, {
        eventId: event._id,
        sourceType: "team_lead",
        sourceId: `${team._id}:${membership._id}`,
        revokedByPersonId: person._id,
        reason: "Sole team lead withdrew the team",
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "team.leave",
      requestFingerprint,
      targetType: "team",
      targetId: team._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.leave",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: withdrawTeam ? "team.withdrawn" : "team.member_left",
      targetType: "team_member",
      targetId: member._id,
      previousSummary: JSON.stringify({ memberCount: activeMembers.length }),
      nextSummary: JSON.stringify({ memberCount: activeMembers.length - 1 }),
      reason: withdrawTeam ? "Sole member left the team" : "Participant left the team",
    });
    return { teamId: team._id };
  },
});

export const removeMember = mutation({
  args: {
    eventSlug: v.string(),
    teamId: v.id("teams"),
    targetTeamMemberId: v.id("teamMembers"),
    expectedTeamVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ teamId: v.id("teams") }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.teamId,
      args.targetTeamMemberId,
      args.expectedTeamVersion,
    ]);
    const replayTeamId = await existingOperationTeam(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "team.member.remove",
      requestFingerprint,
    );
    if (replayTeamId) return { teamId: replayTeamId };

    requireRegistrationOpen(event);

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const team = await ctx.db.get(args.teamId);
    if (!team || team.eventId !== event._id) {
      throw new ConvexError({ code: "TEAM_NOT_FOUND", message: "That team is not available." });
    }
    if (team.membershipLocked) {
      throw new ConvexError({ code: "TEAM_LOCKED", message: "Team membership is locked." });
    }
    if (team.version !== args.expectedTeamVersion) {
      throw new ConvexError({
        code: "TEAM_CHANGED",
        message: "The team changed. Review it and try again.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.members.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const targetMember = await ctx.db.get(args.targetTeamMemberId);
    if (
      !targetMember ||
      targetMember.eventId !== event._id ||
      targetMember.teamId !== team._id ||
      targetMember.status !== "active" ||
      targetMember.role !== "member"
    ) {
      throw new ConvexError({
        code: "MEMBER_NOT_REMOVABLE",
        message: "Choose an active non-lead member of this team.",
      });
    }
    const targetMembership = await ctx.db.get(targetMember.membershipId);
    if (!targetMembership || targetMembership.eventId !== event._id) {
      throw new Error("The team member references a missing event membership.");
    }
    const activeMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_status", (index) =>
        index.eq("teamId", team._id).eq("status", "active"),
      )
      .collect();

    const now = Date.now();
    const nextPublicCode = await unusedTeamCode(ctx, event._id);
    await ctx.db.patch(targetMember._id, { status: "removed", leftAt: now });
    await ctx.db.patch(targetMembership._id, {
      onboardingStatus: "team_required",
      updatedAt: now,
    });
    await ctx.db.patch(team._id, {
      publicCode: nextPublicCode,
      version: team.version + 1,
      updatedAt: now,
    });
    await cancelPendingLeadershipTransfers(ctx, {
      teamId: team._id,
      decidedByPersonId: person._id,
      decidedAt: now,
    });
    await revokeSourceGrants(ctx, {
      eventId: event._id,
      sourceType: "team_membership",
      sourceId: targetMember._id,
      revokedByPersonId: person._id,
      reason: "Participant was removed from the team",
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "team.member.remove",
      requestFingerprint,
      targetType: "team",
      targetId: team._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.members.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "team.member_removed",
      targetType: "team_member",
      targetId: targetMember._id,
      previousSummary: JSON.stringify({ memberCount: activeMembers.length }),
      nextSummary: JSON.stringify({
        memberCount: activeMembers.length - 1,
        joinCodeRotated: true,
      }),
      reason: "Authorised team manager removed a member",
    });
    return { teamId: team._id };
  },
});

export const requestLeadershipTransfer = mutation({
  args: {
    eventSlug: v.string(),
    toMembershipId: v.id("eventMemberships"),
    expectedTeamVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ transferId: v.id("teamLeadershipTransfers"), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.toMembershipId,
      args.expectedTeamVersion,
    ]);
    const replayTransferId = await existingOperationTransfer(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "team.lead.request",
      requestFingerprint,
    );
    if (replayTransferId) {
      const replayTransfer = await ctx.db.get(replayTransferId);
      if (!replayTransfer) throw new Error("The prior leadership transfer no longer resolves.");
      return { transferId: replayTransfer._id, expiresAt: replayTransfer.expiresAt };
    }
    requireRegistrationOpen(event);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (!member || member.role !== "lead") {
      throw new ConvexError({ code: "TEAM_LEAD_REQUIRED", message: "Only the team lead can do that." });
    }
    const team = await ctx.db.get(member.teamId);
    if (!team || team.membershipLocked) {
      throw new ConvexError({ code: "TEAM_LOCKED", message: "Team leadership is locked." });
    }
    if (team.version !== args.expectedTeamVersion) {
      throw new ConvexError({ code: "TEAM_CHANGED", message: "The team changed. Review it and try again." });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.lead.transfer",
      scopeType: "team",
      scopeId: team._id,
    });
    const targetMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_membership_status", (index) =>
        index
          .eq("teamId", team._id)
          .eq("membershipId", args.toMembershipId)
          .eq("status", "active"),
      )
      .unique();
    if (!targetMember || targetMember.role !== "member") {
      throw new ConvexError({
        code: "INVALID_NEW_LEAD",
        message: "Choose another active member of this team.",
      });
    }
    const now = Date.now();
    await cancelPendingLeadershipTransfers(ctx, {
      teamId: team._id,
      decidedByPersonId: person._id,
      decidedAt: now,
    });
    const expiresAt = now + 24 * 60 * 60 * 1_000;
    const transferId = await ctx.db.insert("teamLeadershipTransfers", {
      eventId: event._id,
      teamId: team._id,
      fromMembershipId: membership._id,
      toMembershipId: args.toMembershipId,
      expectedTeamVersion: team.version,
      state: "pending",
      requestedByPersonId: person._id,
      requestedAt: now,
      expiresAt,
      clientOperationId: args.clientOperationId,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "team.lead.request",
      requestFingerprint,
      targetType: "team_leadership_transfer",
      targetId: transferId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.lead.transfer",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "team.lead_transfer_requested",
      targetType: "team_leadership_transfer",
      targetId: transferId,
      nextSummary: JSON.stringify({ from: membership._id, to: args.toMembershipId, expiresAt }),
      reason: "Team lead requested transfer",
    });
    return { transferId, expiresAt };
  },
});

export const respondToLeadershipTransfer = mutation({
  args: {
    eventSlug: v.string(),
    transferId: v.id("teamLeadershipTransfers"),
    accept: v.boolean(),
    clientOperationId: v.string(),
  },
  returns: v.object({ state: v.union(v.literal("accepted"), v.literal("declined")) }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([args.transferId, args.accept]);
    const replayTransferId = await existingOperationTransfer(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "team.lead.respond",
      requestFingerprint,
    );
    if (replayTransferId) {
      const replayTransfer = await ctx.db.get(replayTransferId);
      if (
        !replayTransfer ||
        (replayTransfer.state !== acceptedTransferState &&
          replayTransfer.state !== declinedTransferState)
      ) {
        throw new Error("The prior leadership-transfer response no longer resolves.");
      }
      return { state: replayTransfer.state };
    }
    requireRegistrationOpen(event);
    const membership = await requireMembership(ctx, event._id, person._id);
    const transfer = await ctx.db.get(args.transferId);
    if (
      !transfer ||
      transfer.eventId !== event._id ||
      transfer.toMembershipId !== membership._id ||
      transfer.state !== "pending"
    ) {
      throw new ConvexError({ code: "TRANSFER_NOT_AVAILABLE", message: "That transfer is not available." });
    }
    const now = Date.now();
    if (transfer.expiresAt <= now) {
      throw new ConvexError({ code: "TRANSFER_EXPIRED", message: "That transfer has expired." });
    }
    const team = await ctx.db.get(transfer.teamId);
    if (!team || team.membershipLocked || team.version !== transfer.expectedTeamVersion) {
      throw new ConvexError({
        code: "TRANSFER_STALE",
        message: "The team changed after this transfer was requested.",
      });
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.lead.accept",
      scopeType: "team",
      scopeId: team._id,
    });
    if (!args.accept) {
      await ctx.db.patch(transfer._id, {
        state: declinedTransferState,
        decidedByPersonId: person._id,
        decidedAt: now,
      });
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "team.lead.respond",
        requestFingerprint,
        targetType: "team_leadership_transfer",
        targetId: transfer._id,
        createdAt: now,
      });
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        permissionKey: "team.lead.accept",
        grantIds,
        scopeType: "team",
        scopeId: team._id,
        action: "team.lead_transfer_declined",
        targetType: "team_leadership_transfer",
        targetId: transfer._id,
        nextSummary: JSON.stringify({ state: declinedTransferState }),
        reason: "Proposed team lead declined the transfer",
      });
      return { state: declinedTransferState };
    }
    const fromMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_membership_status", (index) =>
        index
          .eq("teamId", team._id)
          .eq("membershipId", transfer.fromMembershipId)
          .eq("status", "active"),
      )
      .unique();
    const toMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_membership_status", (index) =>
        index
          .eq("teamId", team._id)
          .eq("membershipId", transfer.toMembershipId)
          .eq("status", "active"),
      )
      .unique();
    if (
      !fromMember ||
      !toMember ||
      fromMember.role !== "lead" ||
      toMember.role !== "member"
    ) {
      throw new ConvexError({ code: "TRANSFER_STALE", message: "Team leadership has changed." });
    }
    const fromMembership = await ctx.db.get(transfer.fromMembershipId);
    const toMembership = await ctx.db.get(transfer.toMembershipId);
    if (!fromMembership || !toMembership) throw new Error("Transfer memberships are missing.");

    await ctx.db.patch(fromMember._id, { role: "member" });
    await ctx.db.patch(toMember._id, { role: "lead" });
    await ctx.db.patch(team._id, {
      leadMembershipId: toMembership._id,
      version: team.version + 1,
      updatedAt: now,
    });
    await ctx.db.patch(transfer._id, {
      state: acceptedTransferState,
      decidedByPersonId: person._id,
      decidedAt: now,
    });
    await revokeSourceGrants(ctx, {
      eventId: event._id,
      sourceType: "team_lead",
      sourceId: `${team._id}:${fromMembership._id}`,
      revokedByPersonId: person._id,
      reason: "Team leadership transferred",
    });
    await addTeamLeadGrants(ctx, {
      event,
      membership: toMembership,
      teamId: team._id,
      actorPersonId: person._id,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "team.lead.respond",
      requestFingerprint,
      targetType: "team_leadership_transfer",
      targetId: transfer._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.lead.accept",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "team.lead_transfer_accepted",
      targetType: "team_leadership_transfer",
      targetId: transfer._id,
      previousSummary: JSON.stringify({ leadMembershipId: transfer.fromMembershipId }),
      nextSummary: JSON.stringify({ leadMembershipId: transfer.toMembershipId }),
      reason: "Proposed team lead accepted the transfer",
    });
    return { state: acceptedTransferState };
  },
});
