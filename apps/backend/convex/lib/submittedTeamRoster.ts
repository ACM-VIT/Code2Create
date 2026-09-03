import { ConvexError } from "convex/values";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { loadPublishedAdmissionConfiguration } from "./admissionPolicy";
import { createAdmissionRecommendation } from "./admissionRecommendation";
import { noveltyInputFingerprint } from "./novelty";
import { invalidateTeamNoveltyIndex } from "./noveltyIndex";
import {
  isProfileCompleteForPolicy,
  loadPublishedParticipantPolicy,
  normalizeParticipantPolicy,
  participantPolicyAccepted,
  participantPolicyChecksum,
  participantPolicyFromDocument,
} from "./participantPolicy";
import { normalizeEmail } from "./strings";
import { teamClassesMeetPolicy, teamRosterCounts } from "./teamRoster";

type RosterMember = {
  teamMember: Doc<"teamMembers">;
  membership: Doc<"eventMemberships">;
  person: Doc<"people">;
  profile: Doc<"participantProfiles">;
};

const laterStudyYears: readonly Doc<"participantProfiles">["yearOfStudy"][] = [
  "third",
  "fourth",
  "fifth_or_later",
];

function experienceBandFor(members: readonly RosterMember[]) {
  if (members.some(({ membership }) => membership.participantClass === "external_participant")) {
    return "mixed_or_external" as const;
  }
  const years = new Set(members.map(({ profile }) => profile.yearOfStudy));
  if (years.has("postgraduate") || years.has("not_applicable")) {
    return "postgraduate_or_professional" as const;
  }
  const hasFirst = years.has("first");
  const hasSecond = years.has("second");
  const hasLater = laterStudyYears.some((year) => years.has(year));
  if (hasFirst && !hasSecond && !hasLater) return "first_year" as const;
  if (!hasLater && (hasFirst || hasSecond)) return "early_year" as const;
  if (hasLater && !hasFirst && !hasSecond) return "later_year" as const;
  return "mixed_or_external" as const;
}

async function loadRosterMembers(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    team: Doc<"teams">;
    participantPolicy: Doc<"participantPolicyVersions">;
  },
) {
  const policy = normalizeParticipantPolicy(participantPolicyFromDocument(args.participantPolicy));
  if (participantPolicyChecksum(policy) !== args.participantPolicy.checksum) {
    throw new Error("The submitted team's participant policy checksum is invalid.");
  }
  const teamMembers = await ctx.db
    .query("teamMembers")
    .withIndex("by_team_status", (index) =>
      index.eq("teamId", args.team._id).eq("status", "active"),
    )
    .take(policy.teamMaximumSize + 1);
  const counts = teamRosterCounts(args.team);
  if (
    teamMembers.length !== counts.activeMemberCount ||
    teamMembers.length < policy.teamMinimumSize ||
    teamMembers.length > policy.teamMaximumSize ||
    !teamClassesMeetPolicy(args.team, policy)
  ) {
    throw new ConvexError({
      code: "TEAM_SIZE",
      message: `A submitted team must keep ${policy.teamMinimumSize} to ${policy.teamMaximumSize} eligible members.`,
    });
  }

  const members = await Promise.all(
    teamMembers.map(async (teamMember): Promise<RosterMember> => {
      const membership = await ctx.db.get(teamMember.membershipId);
      if (
        !membership ||
        membership.eventId !== args.event._id ||
        membership.eligibilityStatus !== "eligible" ||
        !(await participantPolicyAccepted(ctx, membership, args.participantPolicy))
      ) {
        throw new ConvexError({
          code: "MEMBER_NOT_READY",
          message:
            "Every member of a submitted team must remain eligible and accept the current policy.",
        });
      }
      const [person, profile] = await Promise.all([
        ctx.db.get(membership.personId),
        ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
          .unique(),
      ]);
      if (
        !person ||
        person.status !== "active" ||
        !profile ||
        !isProfileCompleteForPolicy(profile, membership, args.participantPolicy)
      ) {
        throw new ConvexError({
          code: "MEMBER_PROFILE_INCOMPLETE",
          message: "Every member must finish their profile before joining a submitted team.",
        });
      }
      return { teamMember, membership, person, profile };
    }),
  );
  const lead = members.find(({ teamMember }) => teamMember.role === "lead");
  if (!lead || lead.membership._id !== args.team.leadMembershipId) {
    throw new Error("The submitted team's active lead projection is invalid.");
  }
  return { members, policy };
}

/**
 * Re-pins a submitted application to the active roster after a team mutation.
 * The caller and this function run in one Convex transaction, so reviewers can
 * never observe a new roster with an old application snapshot.
 */
export async function refreshSubmittedApplicationRoster(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    teamId: Id<"teams">;
    actorPersonId: Id<"people">;
    actorMembershipId: Id<"eventMemberships">;
    authorizingGrantIds: Id<"permissionGrants">[];
    clientOperationId: string;
    requestFingerprint: string;
    now: number;
  },
) {
  const application = await ctx.db
    .query("applications")
    .withIndex("by_team", (index) => index.eq("teamId", args.teamId))
    .unique();
  if (!application) return null;
  if (
    application.eventId !== args.event._id ||
    !["submitted", "under_review", "needs_information"].includes(application.state)
  ) {
    throw new ConvexError({
      code: "APPLICATION_TEAM_FINALIZED",
      message: "This team can no longer change its members.",
    });
  }
  const team = await ctx.db.get(args.teamId);
  const project = await ctx.db.get(application.submittedProjectVersionId);
  if (
    !team ||
    team.eventId !== args.event._id ||
    !team.membershipLocked ||
    !project ||
    project.eventId !== args.event._id ||
    project.teamId !== team._id ||
    team.lockedProjectVersionId !== project._id
  ) {
    throw new Error("The submitted team application context is invalid.");
  }
  const [draft, participantPolicyConfiguration, admissionConfiguration] = await Promise.all([
    ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique(),
    loadPublishedParticipantPolicy(ctx, args.event),
    loadPublishedAdmissionConfiguration(ctx, args.event),
  ]);
  const participantPolicy = participantPolicyConfiguration.policy;
  if (!draft || admissionConfiguration.policy._id !== application.admissionPolicyVersionId) {
    throw new Error("The submitted team policy context is invalid.");
  }
  const { members } = await loadRosterMembers(ctx, {
    event: args.event,
    team,
    participantPolicy,
  });
  const attemptId = await ctx.db.insert("teamSubmissionAttempts", {
    eventId: args.event._id,
    teamId: team._id,
    draftId: draft._id,
    requestedByPersonId: args.actorPersonId,
    requestedByMembershipId: args.actorMembershipId,
    authorizingGrantIds: args.authorizingGrantIds,
    clientOperationId: `${args.clientOperationId}:roster:${team._id}`,
    requestFingerprint: args.requestFingerprint,
    state: "complete",
    sourceTeamVersion: team.version,
    lockedTeamVersion: team.version,
    sourceDraftVersion: draft.version,
    participantPolicyVersionId: participantPolicy._id,
    admissionPolicyVersionId: admissionConfiguration.policy._id,
    processedMemberCount: members.length,
    processedVitMemberCount: members.filter(
      ({ membership }) => membership.participantClass === "vit_student",
    ).length,
    processedExternalMemberCount: members.filter(
      ({ membership }) => membership.participantClass === "external_participant",
    ).length,
    hasFirstYear: members.some(({ profile }) => profile.yearOfStudy === "first"),
    hasSecondYear: members.some(({ profile }) => profile.yearOfStudy === "second"),
    hasLaterYear: members.some(({ profile }) =>
      ["third", "fourth", "fifth_or_later"].includes(profile.yearOfStudy),
    ),
    hasPostgraduateYear: members.some(({ profile }) => profile.yearOfStudy === "postgraduate"),
    hasNotApplicableYear: members.some(({ profile }) => profile.yearOfStudy === "not_applicable"),
    createdAt: args.now,
    updatedAt: args.now,
    completedAt: args.now,
  });
  for (const [index, member] of members.entries()) {
    await ctx.db.insert("teamSubmissionMembers", {
      eventId: args.event._id,
      submissionAttemptId: attemptId,
      teamId: team._id,
      ordinal: index + 1,
      teamMemberId: member.teamMember._id,
      membershipId: member.membership._id,
      personId: member.person._id,
      role: member.teamMember.role,
      participantClass: member.membership.participantClass,
      displayName: member.profile.fullName ?? member.person.displayName,
      institution: member.profile.institution,
      yearOfStudy: member.profile.yearOfStudy,
      profileVersion: member.profile.profileVersion,
      destinationEmailNormalized: normalizeEmail(member.person.verifiedEmail),
      materializedAt: args.now,
    });
    await ctx.db.patch(member.membership._id, {
      onboardingStatus: "submitted",
      updatedAt: args.now,
    });
  }

  await invalidateTeamNoveltyIndex(ctx, {
    teamId: team._id,
    sourceUpdatedAt: args.now,
  });
  const [activeReviews, activeAssignments, priorRecommendation] = await Promise.all([
    ctx.db
      .query("admissionHumanReviews")
      .withIndex("by_application_status", (index) =>
        index.eq("applicationId", application._id).eq("status", "active"),
      )
      .collect(),
    ctx.db
      .query("admissionReviewAssignments")
      .withIndex("by_application_state_assigned", (index) =>
        index.eq("applicationId", application._id).eq("state", "active"),
      )
      .collect(),
    application.aiRecommendationId
      ? ctx.db.get(application.aiRecommendationId)
      : Promise.resolve(null),
  ]);
  const projectVersionId = await ctx.db.insert("projectVersions", {
    eventId: args.event._id,
    teamId: team._id,
    version: project.version + 1,
    initialIdea: project.initialIdea,
    ...(project.additionalInformation !== undefined
      ? { additionalInformation: project.additionalInformation }
      : {}),
    intakePolicyVersionId: project.intakePolicyVersionId,
    intakeResponses: project.intakeResponses,
    lockedRosterSnapshotId: attemptId,
    lockedMemberCount: members.length,
    lockedLeadMembershipId: team.leadMembershipId,
    freshForEventAttestation: project.freshForEventAttestation,
    finalConfirmation: project.finalConfirmation,
    participantPolicyVersionId: participantPolicy._id,
    admissionPolicyVersionId: project.admissionPolicyVersionId,
    ...(project.admissionInformationResponses !== undefined
      ? { admissionInformationResponses: project.admissionInformationResponses }
      : {}),
    ...(project.proposalRevision !== undefined
      ? { proposalRevision: project.proposalRevision }
      : {}),
    rosterRevision: {
      sourceProjectVersionId: project._id,
      changedByMembershipId: args.actorMembershipId,
      changedAt: args.now,
    },
    sourceDraftVersion: project.sourceDraftVersion,
    submittedByMembershipId: args.actorMembershipId,
    submittedAt: args.now,
  });
  const nextContentVersion = application.contentVersion + 1;
  for (const review of activeReviews) {
    await ctx.db.patch(review._id, { status: "superseded" });
  }
  for (const assignment of activeAssignments) {
    await ctx.db.patch(assignment._id, {
      applicationContentVersion: nextContentVersion,
      version: assignment.version + 1,
    });
  }
  if (
    priorRecommendation &&
    (priorRecommendation.state === "pending" || priorRecommendation.state === "running")
  ) {
    await ctx.db.patch(priorRecommendation._id, {
      state: "stale",
      completedAt: args.now,
      failureCategory: "team_roster_revised",
    });
  }
  await ctx.db.patch(team._id, {
    submissionAttemptId: attemptId,
    lockedProjectVersionId: projectVersionId,
    lockParticipantPolicyVersionId: participantPolicy._id,
    updatedAt: args.now,
  });
  await ctx.db.patch(application._id, {
    submittedProjectVersionId: projectVersionId,
    experienceBand: experienceBandFor(members),
    aiDisposition: undefined,
    aiRecommendationId: undefined,
    assignedReviewCount: activeAssignments.length,
    completedReviewCount: 0,
    contentVersion: nextContentVersion,
    version: application.version + 1,
  });
  await ctx.db.patch(attemptId, {
    projectVersionId,
    applicationId: application._id,
  });
  const [updatedApplication, updatedProject] = await Promise.all([
    ctx.db.get(application._id),
    ctx.db.get(projectVersionId),
  ]);
  if (!updatedApplication || !updatedProject) {
    throw new Error("The revised submitted-team snapshot did not persist.");
  }
  await createAdmissionRecommendation(ctx, {
    application: updatedApplication,
    project: updatedProject,
    policy: admissionConfiguration.policy,
    modelConfig: admissionConfiguration.model,
    now: args.now,
  });
  await ctx.scheduler.runAfter(0, internal.novelty.indexSubmittedProjectIdea, {
    projectVersionId,
    inputFingerprint: noveltyInputFingerprint(project.initialIdea),
    sourceUpdatedAt: args.now,
  });
  return { applicationId: application._id, projectVersionId, attemptId };
}
