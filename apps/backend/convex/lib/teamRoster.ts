import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type TeamRosterCounts = {
  activeMemberCount: number;
  activeVitMemberCount: number;
  activeExternalMemberCount: number;
};

function requireCount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The team's ${label} is invalid.`);
  }
  return value;
}

export function teamRosterCounts(team: Doc<"teams">): TeamRosterCounts {
  const counts = {
    activeMemberCount: requireCount(team.activeMemberCount, "active-member count"),
    activeVitMemberCount: requireCount(team.activeVitMemberCount, "VIT-member count"),
    activeExternalMemberCount: requireCount(
      team.activeExternalMemberCount,
      "external-member count",
    ),
  };
  if (counts.activeMemberCount !== counts.activeVitMemberCount + counts.activeExternalMemberCount) {
    throw new Error("The team's active roster projection is inconsistent.");
  }
  return counts;
}

function adjustedTeamRosterCounts(
  team: Doc<"teams">,
  participantClass: Doc<"eventMemberships">["participantClass"],
  delta: 1 | -1,
) {
  const current = teamRosterCounts(team);
  const next = {
    activeMemberCount: current.activeMemberCount + delta,
    activeVitMemberCount:
      current.activeVitMemberCount + (participantClass === "vit_student" ? delta : 0),
    activeExternalMemberCount:
      current.activeExternalMemberCount + (participantClass === "external_participant" ? delta : 0),
  };
  requireCount(next.activeMemberCount, "next active-member count");
  requireCount(next.activeVitMemberCount, "next VIT-member count");
  requireCount(next.activeExternalMemberCount, "next external-member count");
  return next;
}

export async function insertActiveTeamMember(
  ctx: MutationCtx,
  args: {
    team: Doc<"teams">;
    membership: Doc<"eventMemberships">;
    role: Doc<"teamMembers">["role"];
    source: Doc<"teamMembers">["source"];
    joinedAt: number;
  },
) {
  if (
    args.membership.eventId !== args.team.eventId ||
    args.membership.eligibilityStatus !== "eligible"
  ) {
    throw new Error("An active team member must be an eligible member of the same event.");
  }
  const counts = adjustedTeamRosterCounts(args.team, args.membership.participantClass, 1);
  const teamMemberId = await ctx.db.insert("teamMembers", {
    eventId: args.team.eventId,
    teamId: args.team._id,
    membershipId: args.membership._id,
    role: args.role,
    status: "active",
    joinedAt: args.joinedAt,
    source: args.source,
  });
  await ctx.db.patch(args.team._id, counts);
  return { teamMemberId, counts };
}

export async function endActiveTeamMember(
  ctx: MutationCtx,
  args: {
    team: Doc<"teams">;
    teamMember: Doc<"teamMembers">;
    membership: Doc<"eventMemberships">;
    status: "left" | "removed";
    leftAt: number;
  },
) {
  if (
    args.teamMember.teamId !== args.team._id ||
    args.teamMember.eventId !== args.team.eventId ||
    args.teamMember.membershipId !== args.membership._id ||
    args.membership.eventId !== args.team.eventId ||
    args.teamMember.status !== "active"
  ) {
    throw new Error("The active team-member transition does not match its roster root.");
  }
  const counts = adjustedTeamRosterCounts(args.team, args.membership.participantClass, -1);
  await ctx.db.patch(args.teamMember._id, {
    status: args.status,
    leftAt: args.leftAt,
  });
  await ctx.db.patch(args.team._id, counts);
  return counts;
}

export function teamContainsParticipantClass(
  team: Doc<"teams">,
  participantClass: Doc<"eventMemberships">["participantClass"],
) {
  const counts = teamRosterCounts(team);
  return participantClass === "vit_student"
    ? counts.activeVitMemberCount > 0
    : counts.activeExternalMemberCount > 0;
}

export function teamClassesMeetPolicy(
  team: Doc<"teams">,
  policy: { mixedParticipantClassesAllowed: boolean },
) {
  const counts = teamRosterCounts(team);
  return (
    policy.mixedParticipantClassesAllowed ||
    counts.activeVitMemberCount === 0 ||
    counts.activeExternalMemberCount === 0
  );
}
