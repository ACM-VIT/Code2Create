import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeEmail } from "./strings";

export async function createTestSubmissionSnapshot(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    teamMemberIds: Id<"teamMembers">[];
    intakePolicyVersionId: Id<"intakePolicyVersions">;
    participantPolicyVersionId: Id<"participantPolicyVersions">;
    admissionPolicyVersionId: Id<"admissionPolicyVersions">;
    submittedAt: number;
  },
) {
  const [team, existingDraft] = await Promise.all([
    ctx.db.get(args.teamId),
    ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", args.teamId))
      .unique(),
  ]);
  if (!team) {
    throw new Error("The test submission context is incomplete.");
  }
  const draftId = existingDraft?._id ?? await ctx.db.insert("projectDrafts", {
    eventId: args.eventId,
    teamId: team._id,
    intakePolicyVersionId: args.intakePolicyVersionId,
    stage: "submitted",
    initialIdea: "Fixture submitted project.",
    freshnessAttestedByMembershipId: team.leadMembershipId,
    freshnessAttestedAt: args.submittedAt,
    version: 1,
    lastEditedByMembershipId: team.leadMembershipId,
    updatedAt: args.submittedAt,
  });
  const leadMembership = await ctx.db.get(team.leadMembershipId);
  if (!leadMembership) throw new Error("The test team lead membership is missing.");
  const submissionAttemptId = await ctx.db.insert("teamSubmissionAttempts", {
    eventId: args.eventId,
    teamId: team._id,
    draftId,
    requestedByPersonId: leadMembership.personId,
    requestedByMembershipId: leadMembership._id,
    authorizingGrantIds: [],
    clientOperationId: `test:${team._id}`,
    requestFingerprint: `test:${team._id}:${draftId}`,
    state: "complete",
    sourceTeamVersion: team.version,
    lockedTeamVersion: team.version,
    sourceDraftVersion: existingDraft?.version ?? 1,
    participantPolicyVersionId: args.participantPolicyVersionId,
    admissionPolicyVersionId: args.admissionPolicyVersionId,
    processedMemberCount: args.teamMemberIds.length,
    processedVitMemberCount: 0,
    processedExternalMemberCount: 0,
    hasFirstYear: false,
    hasSecondYear: false,
    hasLaterYear: false,
    hasPostgraduateYear: false,
    hasNotApplicableYear: false,
    createdAt: args.submittedAt,
    updatedAt: args.submittedAt,
    completedAt: args.submittedAt,
  });
  let vitCount = 0;
  let externalCount = 0;
  for (const [index, teamMemberId] of args.teamMemberIds.entries()) {
    const teamMember = await ctx.db.get(teamMemberId);
    if (!teamMember || teamMember.teamId !== team._id) {
      throw new Error("A test roster member is invalid.");
    }
    const membership = await ctx.db.get(teamMember.membershipId);
    if (!membership || membership.eventId !== args.eventId) {
      throw new Error("A test roster membership is invalid.");
    }
    const [person, profile] = await Promise.all([
      ctx.db.get(membership.personId),
      ctx.db
        .query("participantProfiles")
        .withIndex("by_membership", (query) => query.eq("membershipId", membership._id))
        .unique(),
    ]);
    if (!person) throw new Error("A test roster person is missing.");
    if (membership.participantClass === "vit_student") vitCount += 1;
    else externalCount += 1;
    await ctx.db.insert("teamSubmissionMembers", {
      eventId: args.eventId,
      submissionAttemptId,
      teamId: team._id,
      ordinal: index + 1,
      teamMemberId: teamMember._id,
      membershipId: membership._id,
      personId: person._id,
      role: teamMember.role,
      participantClass: membership.participantClass,
      displayName: profile?.fullName ?? person.displayName,
      institution: profile?.institution ?? "Fixture institution",
      yearOfStudy: profile?.yearOfStudy ?? "not_applicable",
      profileVersion: profile?.profileVersion ?? 1,
      destinationEmailNormalized: normalizeEmail(person.verifiedEmail),
      materializedAt: args.submittedAt,
    });
  }
  await ctx.db.patch(submissionAttemptId, {
    processedVitMemberCount: vitCount,
    processedExternalMemberCount: externalCount,
  });
  await ctx.db.patch(team._id, { submissionAttemptId });
  return submissionAttemptId;
}

export async function linkTestSubmissionSnapshot(
  ctx: MutationCtx,
  args: {
    submissionAttemptId: Id<"teamSubmissionAttempts">;
    projectVersionId: Id<"projectVersions">;
    applicationId: Id<"applications">;
  },
) {
  const snapshot = await ctx.db.get(args.submissionAttemptId);
  if (!snapshot || snapshot.state !== "complete") {
    throw new Error("The test submission snapshot is missing.");
  }
  await ctx.db.patch(snapshot._id, {
    projectVersionId: args.projectVersionId,
    applicationId: args.applicationId,
  });
  await ctx.db.patch(snapshot.teamId, { submissionAttemptId: snapshot._id });
}
