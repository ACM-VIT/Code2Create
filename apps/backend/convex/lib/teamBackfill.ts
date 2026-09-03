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

type TeamBackfillOutcome =
  | "still_pending"
  | "identity_conflict"
  | "choice_required"
  | "waiting_for_lead"
  | "claimed";

type TeamBackfillResult = {
  outcome: TeamBackfillOutcome;
  claimedCount: number;
};

function isTeamPlacementFailure(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
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
 * Applies one participant's explicit acceptance of an imported team assignment.
 * The caller owns policy, permission, and version checks. A member who accepts
 * before the listed lead waits; accepting the lead forms the team and joins only
 * members who already accepted. A roster import never opts a participant in.
 */
export async function applyTeamRosterEntry(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    entry: Doc<"teamRosterEntries">;
    actorPersonId: Id<"people">;
    maximumClaims?: number;
  },
): Promise<TeamBackfillResult> {
  const entry = args.entry;
  if (entry.status === "choice_required") {
    return { outcome: "choice_required", claimedCount: 0 };
  }
  const now = Date.now();
  const resolved = await resolveTeamRosterPerson(ctx, {
    eventId: args.event._id,
    entry,
  });
  if (resolved.kind === "not_found") {
    return { outcome: "still_pending", claimedCount: 0 };
  }
  if (resolved.kind === "identity_conflict") {
    await ctx.db.patch(entry._id, {
      status: "identity_conflict",
      version: entry.version + 1,
    });
    return { outcome: "identity_conflict", claimedCount: 0 };
  }
  const { membership } = resolved;
  if (membership.eligibilityStatus !== "eligible") {
    return { outcome: "still_pending", claimedCount: 0 };
  }
  const existingMember = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index.eq("eventId", args.event._id).eq("membershipId", membership._id).eq("status", "active"),
    )
    .unique();
  if (existingMember) {
    const existingTeam = await ctx.db.get(existingMember.teamId);
    if (!existingTeam || existingTeam.eventId !== args.event._id) {
      throw new Error("The active team membership references an invalid team.");
    }
    if (
      existingTeam.name === entry.teamName &&
      existingTeam.status !== "withdrawn" &&
      existingTeam.status !== "disqualified"
    ) {
      await ctx.db.patch(entry._id, {
        status: "claimed",
        version: entry.version + 1,
        claimedByMembershipId: membership._id,
        claimedTeamId: existingTeam._id,
        claimedAt: now,
      });
      return { outcome: "claimed", claimedCount: 1 };
    }
    await ctx.db.patch(entry._id, {
      status: "choice_required",
      version: entry.version + 1,
    });
    return { outcome: "choice_required", claimedCount: 0 };
  }
  const githubStarCompletion = await ctx.db
    .query("githubStarCompletions")
    .withIndex("by_event_membership", (index) =>
      index.eq("eventId", args.event._id).eq("membershipId", membership._id),
    )
    .unique();
  if (!githubStarCompletion) {
    return { outcome: "still_pending", claimedCount: 0 };
  }

  try {
    return await placeTeamRosterEntry(ctx, {
      event: args.event,
      entry,
      membership,
      actorPersonId: args.actorPersonId,
      now,
      ...(args.maximumClaims === undefined ? {} : { maximumClaims: args.maximumClaims }),
    });
  } catch (error) {
    if (isTeamPlacementFailure(error)) {
      return { outcome: "still_pending", claimedCount: 0 };
    }
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
    maximumClaims?: number;
  },
): Promise<TeamBackfillResult> {
  const { entry, membership, now } = args;
  const participantPolicy = await loadPublishedParticipantPolicy(ctx, args.event);

  const activeMatches = await activeTeamsWithName(ctx, {
    eventId: args.event._id,
    name: entry.teamName,
  });
  if (activeMatches.length > 1) {
    return { outcome: "still_pending", claimedCount: 0 };
  }
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
      const followerCount = await applyFollowingEntries(ctx, {
        event: args.event,
        teamId: created.teamId,
        teamName: entry.teamName,
        actorPersonId: args.actorPersonId,
        teamMaximumSize: participantPolicy.normalized.teamMaximumSize,
        maximumClaims: Math.max(
          0,
          (args.maximumClaims ?? participantPolicy.normalized.teamMaximumSize) - 1,
        ),
      });
      return { outcome: "claimed", claimedCount: 1 + followerCount };
    }
    await ctx.db.patch(entry._id, {
      status: "waiting_for_lead",
      version: entry.version + 1,
    });
    return { outcome: "waiting_for_lead", claimedCount: 0 };
  }

  if (team.membershipLocked) {
    return { outcome: "still_pending", claimedCount: 0 };
  }
  const rosterCounts = teamRosterCounts(team);
  if (rosterCounts.activeMemberCount >= participantPolicy.normalized.teamMaximumSize) {
    return { outcome: "still_pending", claimedCount: 0 };
  }
  if (
    !participantPolicy.normalized.mixedParticipantClassesAllowed &&
    rosterCounts.activeMemberCount > 0 &&
    !teamContainsParticipantClass(team, membership.participantClass)
  ) {
    return { outcome: "still_pending", claimedCount: 0 };
  }

  const role = entry.role;
  if (role === "lead") {
    const leadMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_status", (index) => index.eq("teamId", team._id).eq("status", "active"))
      .take(team.activeMemberCount);
    const leadSeatTaken = leadMember.some(
      (member) => member.role === "lead" && member.membershipId !== membership._id,
    );
    if (leadSeatTaken) {
      return { outcome: "still_pending", claimedCount: 0 };
    }
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
  return { outcome: "claimed", claimedCount: 1 };
}

/**
 * After an imported lead accepts and creates a team, joins only same-team
 * members who already accepted. Bounded by the team's maximum size and never
 * spills into other team names.
 */
async function applyFollowingEntries(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    teamId: Id<"teams">;
    teamName: string;
    actorPersonId: Id<"people">;
    teamMaximumSize: number;
    maximumClaims: number;
  },
) {
  if (args.maximumClaims === 0) return 0;
  const waiting = await ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_team_status", (index) =>
      index
        .eq("eventId", args.event._id)
        .eq("teamName", args.teamName)
        .eq("status", "waiting_for_lead"),
    )
    .take(args.teamMaximumSize);
  const ordered = [...waiting].sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
  let claimedCount = 0;
  for (const entry of ordered) {
    if (claimedCount >= args.maximumClaims) break;
    const team = await ctx.db.get(args.teamId);
    if (!team) throw new Error("The backfilled team did not persist.");
    if (teamRosterCounts(team).activeMemberCount >= args.teamMaximumSize) break;
    const currentEntry = await ctx.db.get(entry._id);
    if (!currentEntry || currentEntry.status !== "waiting_for_lead") {
      continue;
    }
    const result = await applyTeamRosterEntry(ctx, {
      event: args.event,
      entry: currentEntry,
      actorPersonId: args.actorPersonId,
      maximumClaims: 1,
    });
    claimedCount += result.claimedCount;
  }
  return claimedCount;
}

/**
 * Finds the one non-terminal roster entry for a person's identities, if any.
 * Import supersede rules keep at most one pending or waiting entry per identity.
 */
type PendingTeamRosterEntryStatus = "pending" | "waiting_for_lead" | "choice_required";

type PendingTeamRosterEntry = Omit<Doc<"teamRosterEntries">, "status"> & {
  status: PendingTeamRosterEntryStatus;
};

function isPendingTeamRosterEntry(
  entry: Doc<"teamRosterEntries">,
): entry is PendingTeamRosterEntry {
  return (
    entry.status === "pending" ||
    entry.status === "waiting_for_lead" ||
    entry.status === "choice_required"
  );
}

export function rosterIdentitiesForPerson(
  person: Pick<Doc<"people">, "verifiedEmail">,
  membership: Pick<Doc<"eventMemberships">, "vitStudentIdentity"> | null,
) {
  const identities = [person.verifiedEmail];
  const registrationNumber = membership?.vitStudentIdentity?.registrationNumber;
  if (registrationNumber) identities.push(registrationNumber);
  return identities;
}

export async function pendingEntryForIdentity(
  ctx: MutationCtx | QueryCtx,
  args: {
    eventId: Id<"events">;
    identityNormalized: string;
  },
): Promise<PendingTeamRosterEntry | null> {
  const byStatus = (status: PendingTeamRosterEntryStatus) =>
    args.identityNormalized.includes("@")
      ? ctx.db
          .query("teamRosterEntries")
          .withIndex("by_event_email_status", (index) =>
            index
              .eq("eventId", args.eventId)
              .eq("emailNormalized", args.identityNormalized)
              .eq("status", status),
          )
          .unique()
      : ctx.db
          .query("teamRosterEntries")
          .withIndex("by_event_vit_registration_status", (index) =>
            index
              .eq("eventId", args.eventId)
              .eq("vitRegistrationNumber", args.identityNormalized)
              .eq("status", status),
          )
          .unique();
  const pending = await byStatus("pending");
  if (pending && isPendingTeamRosterEntry(pending)) return pending;
  const waiting = await byStatus("waiting_for_lead");
  if (waiting && isPendingTeamRosterEntry(waiting)) return waiting;
  const choice = await byStatus("choice_required");
  if (choice && isPendingTeamRosterEntry(choice)) return choice;
  return null;
}

export async function teamRosterPendingEntry(
  ctx: MutationCtx | QueryCtx,
  args: {
    eventId: Id<"events">;
    identities: readonly string[];
  },
): Promise<PendingTeamRosterEntry | null> {
  for (const identityNormalized of args.identities) {
    const entry = await pendingEntryForIdentity(ctx, {
      eventId: args.eventId,
      identityNormalized,
    });
    if (entry) return entry;
  }
  return null;
}

export async function resolveTeamRosterPerson(
  ctx: MutationCtx | QueryCtx,
  args: {
    eventId: Id<"events">;
    entry: Pick<Doc<"teamRosterEntries">, "emailNormalized" | "vitRegistrationNumber">;
  },
): Promise<
  | { kind: "resolved"; person: Doc<"people">; membership: Doc<"eventMemberships"> }
  | { kind: "not_found" }
  | { kind: "identity_conflict" }
> {
  if (args.entry.emailNormalized !== undefined) {
    const emailNormalized = args.entry.emailNormalized;
    const person = await ctx.db
      .query("people")
      .withIndex("by_verified_email", (index) => index.eq("verifiedEmail", emailNormalized))
      .unique();
    if (!person) return { kind: "not_found" };
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", args.eventId).eq("personId", person._id),
      )
      .unique();
    if (!membership) return { kind: "not_found" };
    return { kind: "resolved", person, membership };
  }
  if (args.entry.vitRegistrationNumber === undefined) {
    throw new Error("A team roster entry must contain one identity.");
  }
  const memberships = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_vit_registration", (index) =>
      index
        .eq("eventId", args.eventId)
        .eq("vitStudentIdentity.registrationNumber", args.entry.vitRegistrationNumber),
    )
    .take(2);
  if (memberships.length > 1) {
    return { kind: "identity_conflict" };
  }
  const membership = memberships[0];
  if (!membership) return { kind: "not_found" };
  const person = await ctx.db.get(membership.personId);
  if (!person) return { kind: "not_found" };
  return { kind: "resolved", person, membership };
}

export type PendingTeamAssignee = {
  displayName: string;
  role: Doc<"teamRosterEntries">["role"];
  signedIn: boolean;
  accepted: boolean;
  isYou: boolean;
};

const maximumPendingAssignees = 16;

export async function pendingTeamAssignees(
  ctx: MutationCtx | QueryCtx,
  args: {
    eventId: Id<"events">;
    teamName: string;
    viewerIdentities: readonly string[];
  },
): Promise<PendingTeamAssignee[]> {
  const pending = await ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_team_status", (index) =>
      index.eq("eventId", args.eventId).eq("teamName", args.teamName).eq("status", "pending"),
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
  const choices = await ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_team_status", (index) =>
      index
        .eq("eventId", args.eventId)
        .eq("teamName", args.teamName)
        .eq("status", "choice_required"),
    )
    .take(maximumPendingAssignees);
  const claimed = await ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_team_status", (index) =>
      index.eq("eventId", args.eventId).eq("teamName", args.teamName).eq("status", "claimed"),
    )
    .take(maximumPendingAssignees);
  const entries = [...pending, ...waiting, ...choices, ...claimed]
    .sort((left, right) => {
      if (left.role !== right.role) return left.role === "lead" ? -1 : 1;
      return left.sourceRowNumber - right.sourceRowNumber;
    })
    .slice(0, maximumPendingAssignees);
  return Promise.all(
    entries.map(async (entry) => {
      const resolved = await resolveTeamRosterPerson(ctx, {
        eventId: args.eventId,
        entry,
      });
      return {
        displayName: entry.displayName,
        role: entry.role,
        signedIn: resolved.kind === "resolved",
        accepted: entry.status === "waiting_for_lead" || entry.status === "claimed",
        isYou: args.viewerIdentities.includes(
          entry.emailNormalized ?? entry.vitRegistrationNumber ?? "",
        ),
      };
    }),
  );
}
