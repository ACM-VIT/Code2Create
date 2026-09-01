import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireGitHubStarCompletion } from "./githubStarGate";
import { writeAuditEvent } from "./lib/audit";
import {
  addTeamLeadGrants,
  addTeamMemberGrants,
  createFormingTeamWithLead,
  unusedTeamCode,
} from "./lib/teamMembership";
import {
  applicationsCloseAtFor,
  requireEventBySlug,
  requireRegistrationOpen,
} from "./lib/events";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEligibleMembership,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import {
  matchingPermissionGrantIds,
  requirePermission,
  revokeSourceGrants,
} from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import {
  loadPublishedParticipantPolicy,
} from "./lib/participantPolicy";
import { normalizeCode } from "./lib/strings";
import { refreshSubmittedApplicationRoster } from "./lib/submittedTeamRoster";
import { rosterIdentitiesForPerson, teamRosterPendingEntry } from "./lib/teamBackfill";
import {
  endActiveTeamMember,
  insertActiveTeamMember,
  teamContainsParticipantClass,
  teamRosterCounts,
} from "./lib/teamRoster";
import { memberRole, participantClass, teamStatus } from "./values";

const acceptedTransferState = "accepted" as const;
const declinedTransferState = "declined" as const;

const teamView = v.object({
  id: v.id("teams"),
  name: v.string(),
  publicCode: v.string(),
  status: teamStatus,
  membershipLocked: v.boolean(),
  membershipEditableUntil: v.number(),
  teamMinimumSize: v.number(),
  teamMaximumSize: v.number(),
  mixedParticipantClassesAllowed: v.boolean(),
  activeMemberCount: v.number(),
  version: v.number(),
  currentMembershipId: v.id("eventMemberships"),
  currentRole: memberRole,
  canLeave: v.boolean(),
  canManageMembers: v.boolean(),
  canTransferLeadership: v.boolean(),
  canRespondToLeadershipTransfer: v.boolean(),
  canWriteProject: v.boolean(),
  canSubmitApplication: v.boolean(),
  canRespondToInformationRequest: v.boolean(),
  canRespondToOffer: v.boolean(),
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
    if (!team || team.eventId !== event._id || currentMember.eventId !== event._id) {
      throw new Error("The active team membership belongs to an invalid event team.");
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const readGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.read",
      scopeType: "team",
      scopeId: team._id,
    });
    if (readGrantIds.length === 0) return null;
    const [
      participantPolicy,
      pendingTransfers,
      leaveGrantIds,
      manageMemberGrantIds,
      transferLeadershipGrantIds,
      acceptLeadershipGrantIds,
      projectWriteGrantIds,
      applicationSubmitGrantIds,
      informationResponseGrantIds,
      offerResponseGrantIds,
    ] = await Promise.all([
      loadPublishedParticipantPolicy(ctx, event),
      ctx.db
        .query("teamLeadershipTransfers")
        .withIndex("by_team_state", (index) =>
          index.eq("teamId", team._id).eq("state", "pending"),
        )
        .take(2),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "team.leave",
        scopeType: "team",
        scopeId: team._id,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "team.members.manage",
        scopeType: "team",
        scopeId: team._id,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "team.lead.transfer",
        scopeType: "team",
        scopeId: team._id,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "team.lead.accept",
        scopeType: "team",
        scopeId: team._id,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "team.project.write",
        scopeType: "team",
        scopeId: team._id,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.submit",
        scopeType: "team",
        scopeId: team._id,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.information.respond",
        scopeType: "team",
        scopeId: team._id,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.offer.respond",
        scopeType: "team",
        scopeId: team._id,
      }),
    ]);
    const rosterCounts = teamRosterCounts(team);
    if (rosterCounts.activeMemberCount > participantPolicy.normalized.teamMaximumSize) {
      throw new Error("A team exceeds the published participant-policy maximum size.");
    }
    if (pendingTransfers.length > 1) {
      throw new Error("A team has more than one pending leadership transfer.");
    }
    const pendingTransfer = pendingTransfers[0];
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
      membershipEditableUntil: applicationsCloseAtFor(event, membership.participantClass),
      teamMinimumSize: participantPolicy.normalized.teamMinimumSize,
      teamMaximumSize: participantPolicy.normalized.teamMaximumSize,
      mixedParticipantClassesAllowed:
        participantPolicy.normalized.mixedParticipantClassesAllowed,
      activeMemberCount: rosterCounts.activeMemberCount,
      version: team.version,
      currentMembershipId: membership._id,
      currentRole: currentMember.role,
      canLeave: leaveGrantIds.length > 0,
      canManageMembers: manageMemberGrantIds.length > 0,
      canTransferLeadership: transferLeadershipGrantIds.length > 0,
      canRespondToLeadershipTransfer: acceptLeadershipGrantIds.length > 0,
      canWriteProject: projectWriteGrantIds.length > 0,
      canSubmitApplication:
        currentMember.role === "lead" && applicationSubmitGrantIds.length > 0,
      canRespondToInformationRequest: informationResponseGrantIds.length > 0,
      canRespondToOffer: offerResponseGrantIds.length > 0,
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

const teamMemberView = v.object({
  teamMemberId: v.id("teamMembers"),
  membershipId: v.id("eventMemberships"),
  role: memberRole,
  displayName: v.string(),
  institution: v.optional(v.string()),
  participantClass,
});

export const members = query({
  args: { eventSlug: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(teamMemberView),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.paginationOpts.numItems) || args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > 50) {
      throw new ConvexError({
        code: "INVALID_PAGE_SIZE",
        message: "Team roster pages contain between 1 and 50 members.",
      });
    }
    const person = await findCurrentPerson(ctx);
    if (!person) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!membership) return { page: [], isDone: true, continueCursor: "" };
    const currentMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (!currentMember) return { page: [], isDone: true, continueCursor: "" };
    const team = await ctx.db.get(currentMember.teamId);
    if (!team || team.eventId !== event._id) {
      throw new Error("The active team membership belongs to an invalid event team.");
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const readGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.read",
      scopeType: "team",
      scopeId: team._id,
    });
    if (readGrantIds.length === 0) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const page = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_status", (index) =>
        index.eq("teamId", team._id).eq("status", "active"),
      )
      .paginate(args.paginationOpts);
    const memberViews = await Promise.all(page.page.map(async (member) => {
      if (member.eventId !== event._id) {
        throw new Error("An active team member belongs to another event.");
      }
      const eventMembership = await ctx.db.get(member.membershipId);
      if (!eventMembership || eventMembership.eventId !== event._id) {
        throw new Error("Team member references an invalid event membership.");
      }
      const [memberPerson, profile] = await Promise.all([
        ctx.db.get(eventMembership.personId),
        ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) =>
            index.eq("membershipId", member.membershipId),
          )
          .unique(),
      ]);
      if (!memberPerson) throw new Error("Membership references a missing person.");
      return {
        teamMemberId: member._id,
        membershipId: member.membershipId,
        role: member.role,
        displayName: profile?.fullName ?? memberPerson.displayName,
        ...(profile?.institution !== undefined ? { institution: profile.institution } : {}),
        participantClass: eventMembership.participantClass,
      };
    }));
    return { ...page, page: memberViews };
  },
});


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

async function requireNoPendingTeamAssignment(
  ctx: MutationCtx,
  eventId: Id<"events">,
  identities: readonly string[],
) {
  const entry = await teamRosterPendingEntry(ctx, { eventId, identities });
  if (!entry) return;
  throw new ConvexError({
    code: "TEAM_ASSIGNMENT_PENDING",
    message: "Leave the assigned team before creating or joining another.",
  });
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
    .take(2);
  if (pendingTransfers.length > 1) {
    throw new Error("A team has more than one pending leadership transfer.");
  }
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
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = requireEligibleMembership(
      await requireMembership(ctx, event._id, person._id),
    );
    requireRegistrationOpen(event, membership.participantClass);
    requireCurrentPolicyAcceptance(membership, participantPolicy.policy);
    await requireGitHubStarCompletion(ctx, event, membership);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.join",
      scopeType: "self",
      scopeId: membership._id,
    });
    await requireNoActiveTeam(ctx, event._id, membership._id);
    await requireNoPendingTeamAssignment(
      ctx,
      event._id,
      rosterIdentitiesForPerson(person, membership),
    );
    const now = Date.now();
    const { teamId, publicCode } = await createFormingTeamWithLead(ctx, {
      event,
      membership,
      personId: person._id,
      name: args.name,
      joinedAt: now,
      source: "created",
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
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = requireEligibleMembership(
      await requireMembership(ctx, event._id, person._id),
    );
    requireRegistrationOpen(event, membership.participantClass);
    requireCurrentPolicyAcceptance(membership, participantPolicy.policy);
    await requireGitHubStarCompletion(ctx, event, membership);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.join",
      scopeType: "self",
      scopeId: membership._id,
    });
    await requireNoActiveTeam(ctx, event._id, membership._id);
    await requireNoPendingTeamAssignment(
      ctx,
      event._id,
      rosterIdentitiesForPerson(person, membership),
    );

    const team = await ctx.db
      .query("teams")
      .withIndex("by_event_code", (index) => index.eq("eventId", event._id).eq("publicCode", code))
      .unique();
    if (!team || team.status === "withdrawn" || team.status === "disqualified") {
      throw new ConvexError({ code: "TEAM_NOT_FOUND", message: "That team code is not active." });
    }
    const rosterCounts = teamRosterCounts(team);
    if (rosterCounts.activeMemberCount >= participantPolicy.normalized.teamMaximumSize) {
      throw new ConvexError({ code: "TEAM_FULL", message: "That team is full." });
    }
    if (
      !participantPolicy.normalized.mixedParticipantClassesAllowed &&
      rosterCounts.activeMemberCount > 0 &&
      !teamContainsParticipantClass(team, membership.participantClass)
    ) {
      throw new ConvexError({
        code: "MIXED_TEAM_NOT_ALLOWED",
        message: "The current participant policy does not allow mixed VIT and external teams.",
      });
    }

    const now = Date.now();
    const { teamMemberId } = await insertActiveTeamMember(ctx, {
      team,
      membership,
      role: "member",
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
    await refreshSubmittedApplicationRoster(ctx, {
      event,
      teamId: team._id,
      actorPersonId: person._id,
      actorMembershipId: membership._id,
      authorizingGrantIds: grantIds,
      clientOperationId: args.clientOperationId,
      requestFingerprint,
      now,
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
      previousSummary: JSON.stringify({ memberCount: rosterCounts.activeMemberCount }),
      nextSummary: JSON.stringify({ memberCount: rosterCounts.activeMemberCount + 1 }),
      reason: "Participant joined with team code",
    });
    return { teamId: team._id };
  },
});

export const switchTeam = mutation({
  args: {
    eventSlug: v.string(),
    fromTeamId: v.id("teams"),
    expectedFromTeamVersion: v.number(),
    code: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ teamId: v.id("teams") }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    const { person } = await requireCurrentPerson(ctx);
    const code = normalizeCode(args.code);
    const requestFingerprint = operationFingerprint([
      args.fromTeamId,
      args.expectedFromTeamVersion,
      code,
    ]);
    const replayTeamId = await existingOperationTeam(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "team.switch",
      requestFingerprint,
    );
    if (replayTeamId) return { teamId: replayTeamId };

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = requireEligibleMembership(
      await requireMembership(ctx, event._id, person._id),
    );
    requireRegistrationOpen(event, membership.participantClass);
    requireCurrentPolicyAcceptance(membership, participantPolicy.policy);
    const joinGrantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.join",
      scopeType: "self",
      scopeId: membership._id,
    });
    await requireNoPendingTeamAssignment(
      ctx,
      event._id,
      rosterIdentitiesForPerson(person, membership),
    );

    const currentMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (!currentMember || currentMember.teamId !== args.fromTeamId) {
      throw new ConvexError({ code: "NOT_ON_TEAM", message: "You are not on that team." });
    }
    const fromTeam = await ctx.db.get(args.fromTeamId);
    if (!fromTeam || fromTeam.eventId !== event._id) {
      throw new ConvexError({ code: "TEAM_NOT_FOUND", message: "That team is not available." });
    }
    if (fromTeam.version !== args.expectedFromTeamVersion) {
      throw new ConvexError({
        code: "TEAM_CHANGED",
        message: "The team changed. Review it and try again.",
      });
    }
    const leaveGrantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.leave",
      scopeType: "team",
      scopeId: fromTeam._id,
    });
    const fromCounts = teamRosterCounts(fromTeam);
    if (currentMember.role === "lead" && fromCounts.activeMemberCount > 1) {
      throw new ConvexError({
        code: "TRANSFER_LEADERSHIP_FIRST",
        message: "Transfer leadership before leaving this team.",
      });
    }

    const toTeam = await ctx.db
      .query("teams")
      .withIndex("by_event_code", (index) =>
        index.eq("eventId", event._id).eq("publicCode", code),
      )
      .unique();
    if (!toTeam || toTeam.status === "withdrawn" || toTeam.status === "disqualified") {
      throw new ConvexError({ code: "TEAM_NOT_FOUND", message: "That team code is not active." });
    }
    if (toTeam._id === fromTeam._id) {
      throw new ConvexError({ code: "ALREADY_ON_TEAM", message: "You are already on that team." });
    }
    const toCounts = teamRosterCounts(toTeam);
    if (toCounts.activeMemberCount >= participantPolicy.normalized.teamMaximumSize) {
      throw new ConvexError({ code: "TEAM_FULL", message: "That team is full." });
    }
    if (
      !participantPolicy.normalized.mixedParticipantClassesAllowed &&
      toCounts.activeMemberCount > 0 &&
      !teamContainsParticipantClass(toTeam, membership.participantClass)
    ) {
      throw new ConvexError({
        code: "MIXED_TEAM_NOT_ALLOWED",
        message: "The current participant policy does not allow mixed VIT and external teams.",
      });
    }

    const now = Date.now();
    const withdrawFromTeam = fromCounts.activeMemberCount === 1;
    await endActiveTeamMember(ctx, {
      team: fromTeam,
      teamMember: currentMember,
      membership,
      status: "left",
      leftAt: now,
    });
    await ctx.db.patch(fromTeam._id, {
      ...(withdrawFromTeam ? { status: "withdrawn" as const } : {}),
      version: fromTeam.version + 1,
      updatedAt: now,
    });
    await cancelPendingLeadershipTransfers(ctx, {
      teamId: fromTeam._id,
      decidedByPersonId: person._id,
      decidedAt: now,
    });
    await revokeSourceGrants(ctx, {
      eventId: event._id,
      sourceType: "team_membership",
      sourceId: currentMember._id,
      revokedByPersonId: person._id,
      reason: "Participant switched teams",
    });
    if (currentMember.role === "lead") {
      await revokeSourceGrants(ctx, {
        eventId: event._id,
        sourceType: "team_lead",
        sourceId: `${fromTeam._id}:${membership._id}`,
        revokedByPersonId: person._id,
        reason: "Sole team lead switched teams",
      });
    }

    const { teamMemberId } = await insertActiveTeamMember(ctx, {
      team: toTeam,
      membership,
      role: "member",
      joinedAt: now,
      source: "code",
    });
    await addTeamMemberGrants(ctx, {
      event,
      membership,
      teamId: toTeam._id,
      teamMemberId,
      actorPersonId: person._id,
      lead: false,
    });
    await cancelPendingLeadershipTransfers(ctx, {
      teamId: toTeam._id,
      decidedByPersonId: person._id,
      decidedAt: now,
    });
    await ctx.db.patch(toTeam._id, { version: toTeam.version + 1, updatedAt: now });
    await ctx.db.patch(membership._id, {
      onboardingStatus:
        membership.onboardingStatus === "profile_required" ? "profile_required" : "project_required",
      updatedAt: now,
    });
    await refreshSubmittedApplicationRoster(ctx, {
      event,
      teamId: fromTeam._id,
      actorPersonId: person._id,
      actorMembershipId: membership._id,
      authorizingGrantIds: leaveGrantIds,
      clientOperationId: args.clientOperationId,
      requestFingerprint,
      now,
    });
    await refreshSubmittedApplicationRoster(ctx, {
      event,
      teamId: toTeam._id,
      actorPersonId: person._id,
      actorMembershipId: membership._id,
      authorizingGrantIds: joinGrantIds,
      clientOperationId: args.clientOperationId,
      requestFingerprint,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "team.switch",
      requestFingerprint,
      targetType: "team",
      targetId: toTeam._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.leave",
      grantIds: leaveGrantIds,
      scopeType: "team",
      scopeId: fromTeam._id,
      action: withdrawFromTeam ? "team.withdrawn" : "team.member_left",
      targetType: "team_member",
      targetId: currentMember._id,
      previousSummary: JSON.stringify({ memberCount: fromCounts.activeMemberCount }),
      nextSummary: JSON.stringify({ memberCount: fromCounts.activeMemberCount - 1 }),
      reason: "Participant switched teams",
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.join",
      grantIds: joinGrantIds,
      scopeType: "self",
      scopeId: membership._id,
      action: "team.member_joined",
      targetType: "team",
      targetId: toTeam._id,
      previousSummary: JSON.stringify({ memberCount: toCounts.activeMemberCount }),
      nextSummary: JSON.stringify({ memberCount: toCounts.activeMemberCount + 1 }),
      reason: "Participant switched teams with a team code",
    });
    return { teamId: toTeam._id };
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

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    requireRegistrationOpen(event, membership.participantClass);
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
    const rosterCounts = teamRosterCounts(team);
    if (member.role === "lead" && rosterCounts.activeMemberCount > 1) {
      throw new ConvexError({
        code: "TRANSFER_LEADERSHIP_FIRST",
        message: "Transfer leadership before leaving this team.",
      });
    }

    const now = Date.now();
    const withdrawTeam = rosterCounts.activeMemberCount === 1;
    await endActiveTeamMember(ctx, {
      team,
      teamMember: member,
      membership,
      status: "left",
      leftAt: now,
    });
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
    await refreshSubmittedApplicationRoster(ctx, {
      event,
      teamId: team._id,
      actorPersonId: person._id,
      actorMembershipId: membership._id,
      authorizingGrantIds: grantIds,
      clientOperationId: args.clientOperationId,
      requestFingerprint,
      now,
    });
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
      previousSummary: JSON.stringify({ memberCount: rosterCounts.activeMemberCount }),
      nextSummary: JSON.stringify({ memberCount: rosterCounts.activeMemberCount - 1 }),
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

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    requireRegistrationOpen(event, membership.participantClass);
    const team = await ctx.db.get(args.teamId);
    if (!team || team.eventId !== event._id) {
      throw new ConvexError({ code: "TEAM_NOT_FOUND", message: "That team is not available." });
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
    const rosterCounts = teamRosterCounts(team);

    const now = Date.now();
    const nextPublicCode = await unusedTeamCode(ctx, event._id);
    await endActiveTeamMember(ctx, {
      team,
      teamMember: targetMember,
      membership: targetMembership,
      status: "removed",
      leftAt: now,
    });
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
    await refreshSubmittedApplicationRoster(ctx, {
      event,
      teamId: team._id,
      actorPersonId: person._id,
      actorMembershipId: membership._id,
      authorizingGrantIds: grantIds,
      clientOperationId: args.clientOperationId,
      requestFingerprint,
      now,
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
      previousSummary: JSON.stringify({ memberCount: rosterCounts.activeMemberCount }),
      nextSummary: JSON.stringify({
        memberCount: rosterCounts.activeMemberCount - 1,
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
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    requireRegistrationOpen(event, membership.participantClass);
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
    if (!team) {
      throw new ConvexError({ code: "TEAM_NOT_FOUND", message: "That team is not available." });
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
    const membership = await requireMembership(ctx, event._id, person._id);
    requireRegistrationOpen(event, membership.participantClass);
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
    if (!team || team.version !== transfer.expectedTeamVersion) {
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
    await refreshSubmittedApplicationRoster(ctx, {
      event,
      teamId: team._id,
      actorPersonId: person._id,
      actorMembershipId: membership._id,
      authorizingGrantIds: grantIds,
      clientOperationId: args.clientOperationId,
      requestFingerprint,
      now,
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
