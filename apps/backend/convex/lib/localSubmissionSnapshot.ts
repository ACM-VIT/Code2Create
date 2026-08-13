import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeEmail } from "./strings";

export async function createLocalSubmissionSnapshot(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    team: Doc<"teams">;
    draftId: Id<"projectDrafts">;
    teamMemberIds: Id<"teamMembers">[];
    participantPolicyVersionId: Id<"participantPolicyVersions">;
    admissionPolicyVersionId: Id<"admissionPolicyVersions">;
    coreTrackVersionId: Id<"trackVersions">;
    requesterMembershipId: Id<"eventMemberships">;
    requesterPersonId: Id<"people">;
    submittedAt: number;
  },
) {
  const submissionAttemptId = await ctx.db.insert("teamSubmissionAttempts", {
    eventId: args.eventId,
    teamId: args.team._id,
    draftId: args.draftId,
    requestedByPersonId: args.requesterPersonId,
    requestedByMembershipId: args.requesterMembershipId,
    submissionSource: "local_seed",
    authorizingGrantIds: [],
    clientOperationId: `local-seed:${args.team._id}`,
    requestFingerprint: `local-seed:${args.team._id}:${args.draftId}`,
    state: "finalizing",
    sourceTeamVersion: args.team.version,
    lockedTeamVersion: args.team.version,
    sourceDraftVersion: 2,
    participantPolicyVersionId: args.participantPolicyVersionId,
    admissionPolicyVersionId: args.admissionPolicyVersionId,
    expectedCoreTrackVersionId: args.coreTrackVersionId,
    expectedSponsorTrackVersionIds: [],
    processedMemberCount: args.team.activeMemberCount,
    processedVitMemberCount: args.team.activeVitMemberCount,
    processedExternalMemberCount: args.team.activeExternalMemberCount,
    hasFirstYear: false,
    hasSecondYear: false,
    hasLaterYear: false,
    hasPostgraduateYear: false,
    hasNotApplicableYear: false,
    createdAt: args.submittedAt,
    updatedAt: args.submittedAt,
  });
  let hasFirstYear = false;
  let hasSecondYear = false;
  let hasLaterYear = false;
  let hasPostgraduateYear = false;
  let hasNotApplicableYear = false;
  for (const [index, teamMemberId] of args.teamMemberIds.entries()) {
    const teamMember = await ctx.db.get(teamMemberId);
    if (!teamMember || teamMember.teamId !== args.team._id || teamMember.status !== "active") {
      throw new Error("A local submitted roster member is invalid.");
    }
    const membership = await ctx.db.get(teamMember.membershipId);
    if (!membership || membership.eventId !== args.eventId) {
      throw new Error("A local submitted roster membership is invalid.");
    }
    const [person, profile] = await Promise.all([
      ctx.db.get(membership.personId),
      ctx.db
        .query("participantProfiles")
        .withIndex("by_membership", (query) => query.eq("membershipId", membership._id))
        .unique(),
    ]);
    if (!person || !profile) throw new Error("A local submitted participant is incomplete.");
    hasFirstYear ||= profile.yearOfStudy === "first";
    hasSecondYear ||= profile.yearOfStudy === "second";
    hasLaterYear ||= ["third", "fourth", "fifth_or_later"].includes(profile.yearOfStudy);
    hasPostgraduateYear ||= profile.yearOfStudy === "postgraduate";
    hasNotApplicableYear ||= profile.yearOfStudy === "not_applicable";
    await ctx.db.insert("teamSubmissionMembers", {
      eventId: args.eventId,
      submissionAttemptId,
      teamId: args.team._id,
      ordinal: index + 1,
      teamMemberId: teamMember._id,
      membershipId: membership._id,
      personId: person._id,
      role: teamMember.role,
      participantClass: membership.participantClass,
      displayName: profile.preferredName ?? profile.fullName ?? person.displayName,
      institution: profile.institution,
      yearOfStudy: profile.yearOfStudy,
      profileVersion: profile.profileVersion,
      destinationEmailNormalized: normalizeEmail(person.verifiedEmail),
      materializedAt: args.submittedAt,
    });
  }
  await ctx.db.patch(submissionAttemptId, {
    hasFirstYear,
    hasSecondYear,
    hasLaterYear,
    hasPostgraduateYear,
    hasNotApplicableYear,
  });
  return submissionAttemptId;
}

export async function completeLocalSubmissionSnapshot(
  ctx: MutationCtx,
  args: {
    submissionAttemptId: Id<"teamSubmissionAttempts">;
    projectVersionId: Id<"projectVersions">;
    applicationId: Id<"applications">;
    completedAt: number;
  },
) {
  await ctx.db.patch(args.submissionAttemptId, {
    state: "complete",
    projectVersionId: args.projectVersionId,
    applicationId: args.applicationId,
    updatedAt: args.completedAt,
    completedAt: args.completedAt,
  });
}
