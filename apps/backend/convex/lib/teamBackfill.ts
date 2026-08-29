import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { loadPublishedParticipantPolicy } from "./participantPolicy";
import { createFormingTeamWithLead, addTeamMemberGrants } from "./teamMembership";
import {
  insertActiveTeamMember,
  teamContainsParticipantClass,
  teamRosterCounts,
} from "./teamRoster";

export type TeamBackfillOutcome =
  | "still_pending"
  | "skipped_has_team"
  | "waiting_for_lead"
  | "claimed";

function isTeamPlacementFailure(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data = error.data;
  const code =
    typeof data === "object" && data !== null && "code" in data && typeof data.code === "string"
      ? data.code
      : null;
  return (
    code === "TEAM_FULL" ||
    code === "TEAM_LOCKED" ||
    code === "MIXED_TEAM_NOT_ALLOWED" ||
    code === "TEAM_NAME_AMBIGUOUS" ||
    code === "EVENT_TEAM_LIMIT_REACHED"
  );
}

/**
 * Every non-withdrawn, non-disqualified team with this exact name in the event.
 * Walks the `by_event_name` index until it is exhausted so older withdrawn
 * rows cannot hide the live team.
 */
export async function activeTeamsWithName(
  ctx: MutationCtx | QueryCtx,
  args: {
    eventId: Id<"events">;
    name: string;
  },
): Promise<Doc<"teams">[]> {
  const matches: Doc<"teams">[] = [];
  for await (const candidate of ctx.db
    .query("teams")
    .withIndex("by_event_name", (index) =>
      index.eq("eventId", args.eventId).eq("name", args.name),
    )) {
    if (candidate.status === "withdrawn" || candidate.status === "disqualified") continue;
    matches.push(candidate);
  }
  return matches;
}

/**
 * Places one roster entry's person on their assigned team. The person must
 * already be provisioned; otherwise the entry stays pending. Never moves a
 * person who already has an active team. Policy acceptance is deliberately not
 * required here: assignment is organizer-driven and consent happens on the
 * participant portal screens. Placement failures leave the entry pending
 * instead of throwing, so signup and import apply can commit around a bad row.
 */
export async function applyTeamRosterEntry(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    entry: Doc<"teamRosterEntries">;
    actorPersonId: Id<"people">;
  },
): Promise<TeamBackfillOutcome> {
  const entry = args.entry;
  const now = Date.now();
  const person = await ctx.db
    .query("people")
    .withIndex("by_verified_email", (index) => index.eq("verifiedEmail", entry.emailNormalized))
    .unique();
  if (!person) return "still_pending";
  const membership = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", args.event._id).eq("personId", person._id),
    )
    .unique();
  if (!membership) return "still_pending";
  if (membership.eligibilityStatus !== "eligible") return "still_pending";

  const existingMember = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", args.event._id)
        .eq("membershipId", membership._id)
        .eq("status", "active"),
    )
    .unique();
  if (existingMember) {
    await ctx.db.patch(entry._id, {
      status: "skipped_has_team",
      version: entry.version + 1,
    });
    return "skipped_has_team";
  }

  try {
    return await placeTeamRosterEntry(ctx, {
      event: args.event,
      entry,
      membership,
      actorPersonId: args.actorPersonId,
      now,
    });
  } catch (error) {
    if (isTeamPlacementFailure(error)) return "still_pending";
    throw error;
  }
}

async function placeTeamRosterEntry(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    entry: Doc<"teamRosterEntries">;
    membership: Doc<"eventMemberships">;
    actorPersonId: Id<"people">;
    now: number;
  },
): Promise<TeamBackfillOutcome> {
  const { entry, membership, now } = args;
  const participantPolicy = await loadPublishedParticipantPolicy(ctx, args.event);

  const activeMatches = await activeTeamsWithName(ctx, {
    eventId: args.event._id,
    name: entry.teamName,
  });
  if (activeMatches.length > 1) return "still_pending";
  const team = activeMatches[0];

  if (!team) {
    if (entry.role === "lead") {
      const created = await createFormingTeamWithLead(ctx, {
        event: args.event,
        membership,
        personId: args.actorPersonId,
        name: entry.teamName,
        joinedAt: now,
        source: "backfill",
      });
      await ctx.db.patch(entry._id, {
        status: "claimed",
        version: entry.version + 1,
        claimedByMembershipId: membership._id,
        claimedTeamId: created.teamId,
        claimedAt: now,
      });
      await applyFollowingEntries(ctx, {
        event: args.event,
        teamId: created.teamId,
        teamName: entry.teamName,
        actorPersonId: args.actorPersonId,
        teamMaximumSize: participantPolicy.normalized.teamMaximumSize,
      });
      return "claimed";
    }
    await ctx.db.patch(entry._id, {
      status: "waiting_for_lead",
      version: entry.version + 1,
    });
    return "waiting_for_lead";
  }

  if (team.membershipLocked) return "still_pending";
  const rosterCounts = teamRosterCounts(team);
  if (rosterCounts.activeMemberCount >= participantPolicy.normalized.teamMaximumSize) {
    return "still_pending";
  }
  if (
    !participantPolicy.normalized.mixedParticipantClassesAllowed &&
    rosterCounts.activeMemberCount > 0 &&
    !teamContainsParticipantClass(team, membership.participantClass)
  ) {
    return "still_pending";
  }

  const role = entry.role;
  if (role === "lead") {
    const leadMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_status", (index) =>
        index.eq("teamId", team._id).eq("status", "active"),
      )
      .take(team.activeMemberCount);
    const leadSeatTaken = leadMember.some(
      (member) =>
        member.role === "lead" && member.membershipId !== membership._id,
    );
    if (leadSeatTaken) return "still_pending";
  }

  const { teamMemberId } = await insertActiveTeamMember(ctx, {
    team,
    membership,
    role,
    joinedAt: now,
    source: "backfill",
  });
  await addTeamMemberGrants(ctx, {
    event: args.event,
    membership,
    teamId: team._id,
    teamMemberId,
    actorPersonId: args.actorPersonId,
    lead: role === "lead",
  });
  await ctx.db.patch(team._id, { version: team.version + 1, updatedAt: now });
  await ctx.db.patch(membership._id, {
    onboardingStatus:
      membership.onboardingStatus === "profile_required" ? "profile_required" : "project_required",
    updatedAt: now,
  });
  await ctx.db.patch(entry._id, {
    status: "claimed",
    version: entry.version + 1,
    claimedByMembershipId: membership._id,
    claimedTeamId: team._id,
    claimedAt: now,
  });
  return "claimed";
}

/**
 * After a backfill lead creates a team, immediately joins same-team entries
 * whose people are already provisioned. Bounded by the team's maximum size and
 * never spills into other team names.
 */
async function applyFollowingEntries(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    teamId: Id<"teams">;
    teamName: string;
    actorPersonId: Id<"people">;
    teamMaximumSize: number;
  },
) {
  const followers = await ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_team_status", (index) =>
      index.eq("eventId", args.event._id).eq("teamName", args.teamName).eq("status", "pending"),
    )
    .take(args.teamMaximumSize);
  const waiting = await ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_team_status", (index) =>
      index
        .eq("eventId", args.event._id)
        .eq("teamName", args.teamName)
        .eq("status", "waiting_for_lead"),
    )
    .take(args.teamMaximumSize);
  const ordered = [...followers, ...waiting].sort(
    (left, right) => left.sourceRowNumber - right.sourceRowNumber,
  );
  for (const entry of ordered) {
    const team = await ctx.db.get(args.teamId);
    if (!team) throw new Error("The backfilled team did not persist.");
    if (teamRosterCounts(team).activeMemberCount >= args.teamMaximumSize) break;
    await applyTeamRosterEntry(ctx, {
      event: args.event,
      entry,
      actorPersonId: args.actorPersonId,
    });
  }
}

/**
 * Finds the one non-terminal roster entry for a person's email, if any.
 * Import supersede rules keep at most one pending or waiting entry per email.
 */
export type PendingTeamRosterEntryStatus = "pending" | "waiting_for_lead";

export type PendingTeamRosterEntry = Omit<
  Doc<"teamRosterEntries">,
  "status"
> & {
  status: PendingTeamRosterEntryStatus;
};

function isPendingTeamRosterEntry(
  entry: Doc<"teamRosterEntries">,
): entry is PendingTeamRosterEntry {
  return entry.status === "pending" || entry.status === "waiting_for_lead";
}

export async function teamRosterPendingEntry(
  ctx: MutationCtx | QueryCtx,
  args: {
    eventId: Id<"events">;
    emailNormalized: string;
  },
): Promise<PendingTeamRosterEntry | null> {
  const pending = await ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_email_status", (index) =>
      index
        .eq("eventId", args.eventId)
        .eq("emailNormalized", args.emailNormalized)
        .eq("status", "pending"),
    )
    .unique();
  if (pending && isPendingTeamRosterEntry(pending)) return pending;
  const waiting = await ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_email_status", (index) =>
      index
        .eq("eventId", args.eventId)
        .eq("emailNormalized", args.emailNormalized)
        .eq("status", "waiting_for_lead"),
    )
    .unique();
  if (waiting && isPendingTeamRosterEntry(waiting)) return waiting;
  return null;
}

export type PendingTeamAssignee = {
  displayName: string;
  role: Doc<"teamRosterEntries">["role"];
  signedIn: boolean;
  isYou: boolean;
};

const maximumPendingAssignees = 16;

export async function pendingTeamAssignees(
  ctx: MutationCtx | QueryCtx,
  args: {
    eventId: Id<"events">;
    teamName: string;
    viewerEmailNormalized: string;
  },
): Promise<PendingTeamAssignee[]> {
  const pending = await ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_team_status", (index) =>
      index
        .eq("eventId", args.eventId)
        .eq("teamName", args.teamName)
        .eq("status", "pending"),
    )
    .take(maximumPendingAssignees);
  const waiting = await ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_team_status", (index) =>
      index
        .eq("eventId", args.eventId)
        .eq("teamName", args.teamName)
        .eq("status", "waiting_for_lead"),
    )
    .take(maximumPendingAssignees);
  return [...pending, ...waiting]
    .sort((left, right) => {
      if (left.role !== right.role) return left.role === "lead" ? -1 : 1;
      return left.sourceRowNumber - right.sourceRowNumber;
    })
    .slice(0, maximumPendingAssignees)
    .map((entry) => ({
      displayName: entry.displayName,
      role: entry.role,
      signedIn: entry.status === "waiting_for_lead",
      isYou: entry.emailNormalized === args.viewerEmailNormalized,
    }));
}

/**
 * Called at the end of participants.provision: joins the person to their
 * assigned team now that membership and self grants exist. Placement failures
 * leave the roster entry pending so the membership commit is not rolled back.
 */
export async function claimPendingTeamRosterEntry(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    person: Doc<"people">;
    membershipId: Id<"eventMemberships">;
  },
) {
  const entry = await teamRosterPendingEntry(ctx, {
    eventId: args.event._id,
    emailNormalized: args.person.verifiedEmail,
  });
  if (!entry) return "still_pending";
  try {
    return await applyTeamRosterEntry(ctx, {
      event: args.event,
      entry,
      actorPersonId: args.person._id,
    });
  } catch (error) {
    if (isTeamPlacementFailure(error)) return "still_pending";
    throw error;
  }
}
