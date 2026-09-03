import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { advanceAccessVersion } from "./accessVersion";
import { insertPermissionGrant } from "./permissions";
import { normalizedText } from "./strings";

export const teamMemberPermissionKeys = [
  "team.read",
  "team.leave",
  "team.project.write",
  "integration.read",
  "project.checkpoint.read",
  "team.lead.accept",
  "queue.participant.read",
  "review.team_qr.mint",
  "score.feedback.read",
] as const;

const teamLeadPermissionKeys = [
  "team.members.manage",
  "team.lead.transfer",
  "application.submit",
  "application.information.respond",
  "application.offer.respond",
  "integration.github.manage",
  "integration.figma.manage",
] as const;

export async function currentTeamForMembership(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
  membershipId: Id<"eventMemberships">,
) {
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index.eq("eventId", eventId).eq("membershipId", membershipId).eq("status", "active"),
    )
    .unique();
  if (!member) return null;
  const team = await ctx.db.get(member.teamId);
  return team?.eventId === eventId ? { team, member } : null;
}

function randomTeamCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return Array.from(bytes, (byte) => alphabet.charAt(byte % alphabet.length)).join("");
}

export async function unusedTeamCode(ctx: MutationCtx, eventId: Id<"events">) {
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
  if (!subject || subject.status !== "active")
    throw new Error("Team member subject is not active.");
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

export async function addTeamLeadGrants(
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

/**
 * Creates a forming team with the given membership as its lead and grants team
 * permissions. Callers must already have run every policy and permission check.
 */
export async function createFormingTeamWithLead(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    membership: Doc<"eventMemberships">;
    personId: Id<"people">;
    name: string;
    joinedAt: number;
    source: Doc<"teamMembers">["source"];
  },
): Promise<{ teamId: Id<"teams">; publicCode: string; teamMemberId: Id<"teamMembers"> }> {
  const name = normalizedText(args.name, "Team name", 2, 60);
  const publicCode = await unusedTeamCode(ctx, args.event._id);
  const activeVitMemberCount = args.membership.participantClass === "vit_student" ? 1 : 0;
  const activeExternalMemberCount =
    args.membership.participantClass === "external_participant" ? 1 : 0;
  const teamId = await ctx.db.insert("teams", {
    eventId: args.event._id,
    name,
    publicCode,
    leadMembershipId: args.membership._id,
    status: "forming",
    activeMemberCount: 1,
    activeVitMemberCount,
    activeExternalMemberCount,
    membershipLocked: false,
    version: 1,
    createdAt: args.joinedAt,
    updatedAt: args.joinedAt,
  });
  const teamMemberId = await ctx.db.insert("teamMembers", {
    eventId: args.event._id,
    teamId,
    membershipId: args.membership._id,
    role: "lead",
    status: "active",
    joinedAt: args.joinedAt,
    source: args.source,
  });
  const team = await ctx.db.get(teamId);
  if (!team) throw new Error("The new team did not persist.");
  if (team.activeMemberCount !== team.activeVitMemberCount + team.activeExternalMemberCount) {
    throw new Error("The new team's roster projection is invalid.");
  }
  await addTeamMemberGrants(ctx, {
    event: args.event,
    membership: args.membership,
    teamId,
    teamMemberId,
    actorPersonId: args.personId,
    lead: true,
  });
  await ctx.db.patch(args.membership._id, {
    onboardingStatus:
      args.membership.onboardingStatus === "profile_required"
        ? "profile_required"
        : "project_required",
    updatedAt: args.joinedAt,
  });
  return { teamId, publicCode, teamMemberId };
}
