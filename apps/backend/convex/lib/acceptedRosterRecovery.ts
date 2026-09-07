import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { writeAuditEvent } from "./audit";
import { isParticipantReadyForPolicy, loadPublishedParticipantPolicy } from "./participantPolicy";
import { experienceBandFor, loadRosterMembers } from "./submittedTeamRoster";
import { requireSelectedAdmissionCapacity } from "./admissionRsvpSchedule";
import { synchronizeTeamAdmissionIdeaComparison } from "./noveltyIndex";
import { recoveryUnavailable } from "./rosterRecovery";

/** Copies the locked roster, not the decision or idea. Old evidence remains immutable. */
export async function finalizeAcceptedRosterRecovery(ctx: MutationCtx, args: {
  event: Doc<"events">;
  recovery: Doc<"participantRosterRecoveries">;
  membership: Doc<"eventMemberships">;
  person: Doc<"people">;
  clientOperationId: string;
  requestFingerprint: string;
  grantIds: Id<"permissionGrants">[];
  now: number;
  operatorPersonId?: Id<"people">;
}) {
  const { event, recovery, membership, person, now } = args;
  const team = await ctx.db.get(recovery.teamId);
  const application = await ctx.db.query("applications")
    .withIndex("by_team", q => q.eq("teamId", recovery.teamId)).unique();
  if (!team || team.eventId !== event._id || !team.membershipLocked ||
      !application || application.eventId !== event._id ||
      application.decisionStage !== "released" || application.humanDecision !== "accept") return recoveryUnavailable();
  if (recovery.lateJoin) {
    if (application.state !== "confirmed" ||
        !["confirmed", "checked_in", "active"].includes(team.status)) return recoveryUnavailable();
  } else if (team.status !== "admitted" || application.state !== "accepted" ||
      application.currentOfferId !== undefined) return recoveryUnavailable();
  const reservations = await ctx.db.query("admissionCapacityReservations")
    .withIndex("by_application_state", q => q.eq("applicationId", application._id).eq("state", "active")).take(2);
  if (!recovery.lateJoin && reservations.length) return recoveryUnavailable();
  const project = await ctx.db.get(application.submittedProjectVersionId);
  if (!project || project.teamId !== team._id || team.lockedProjectVersionId !== project._id) return recoveryUnavailable();
  const priorAttempt = await ctx.db.get(project.lockedRosterSnapshotId);
  if (!priorAttempt || priorAttempt.state !== "complete" || priorAttempt.teamId !== team._id ||
      team.submissionAttemptId !== priorAttempt._id) return recoveryUnavailable();
  const offer = application.currentOfferId ? await ctx.db.get(application.currentOfferId) : null;
  const reservation = reservations[0];
  const bucket = recovery.lateJoin ? await ctx.db.query("admissionCapacityBuckets")
    .withIndex("by_policy", q => q.eq("admissionPolicyVersionId", application.admissionPolicyVersionId)).unique() : null;
  if (recovery.lateJoin) {
    if (!offer || offer.state !== "confirmed" || offer.eventId !== event._id ||
        offer.applicationId !== application._id || offer.teamId !== team._id ||
        offer.lockedRosterSnapshotId !== priorAttempt._id || offer.participantCount !== project.lockedMemberCount ||
        reservations.length !== 1 || !reservation || reservation.offerId !== offer._id ||
        reservation.eventId !== event._id || reservation.admissionPolicyVersionId !== application.admissionPolicyVersionId ||
        reservation.participantCount !== project.lockedMemberCount || !bucket || bucket.eventId !== event._id) return recoveryUnavailable();
    if (bucket.reserved + 1 > bucket.capacity) {
      throw new ConvexError({ code: "ADMISSION_CAPACITY_FULL", message: "No participant capacity remains for this late addition." });
    }
  }
  const { policy, normalized } = await loadPublishedParticipantPolicy(ctx, event);
  const profile = await ctx.db.query("participantProfiles")
    .withIndex("by_membership", q => q.eq("membershipId", membership._id)).unique();
  if (!profile || !(await isParticipantReadyForPolicy(ctx, profile, membership, policy))) {
    throw new ConvexError({ code: "PROFILE_REQUIRED", message: "Complete your profile and accept the participant policy first." });
  }
  if (membership.participantClass !== "vit_student" ||
      membership.vitStudentIdentity?.registrationNumber !== recovery.vitRegistrationNumber ||
      person.verifiedEmail !== recovery.emailNormalized || project.participantPolicyVersionId !== policy._id ||
      team.activeMemberCount > normalized.teamMaximumSize || team.activeExternalMemberCount !== 0) return recoveryUnavailable();
  const { members } = await loadRosterMembers(ctx, { event, team, participantPolicy: policy });
  const [oldMembers, activeMembers] = await Promise.all([
    ctx.db.query("teamSubmissionMembers").withIndex("by_submission_attempt_and_ordinal", q =>
      q.eq("submissionAttemptId", priorAttempt._id)).take(normalized.teamMaximumSize + 1),
    ctx.db.query("teamMembers").withIndex("by_team_status", q =>
      q.eq("teamId", team._id).eq("status", "active")).take(normalized.teamMaximumSize + 1),
  ]);
  const newMember = activeMembers.find(m => m.membershipId === membership._id);
  if (!newMember || newMember.role !== "member" || oldMembers.length !== project.lockedMemberCount ||
      activeMembers.length !== team.activeMemberCount || activeMembers.length !== oldMembers.length + 1 ||
      oldMembers.some((m, i) => m.ordinal !== i + 1 || m.membershipId === membership._id ||
        !activeMembers.some(a => a._id === m.teamMemberId && a.membershipId === m.membershipId && a.role === m.role))) {
    return recoveryUnavailable();
  }
  const { _id: oldAttemptId, _creationTime: oldAttemptCreationTime, ...attemptData } = priorAttempt;
  void oldAttemptId; void oldAttemptCreationTime;
  const attemptId = await ctx.db.insert("teamSubmissionAttempts", {
    ...attemptData,
    requestedByPersonId: args.operatorPersonId ?? person._id, requestedByMembershipId: membership._id,
    authorizingGrantIds: [...recovery.authorizingGrantIds, ...args.grantIds],
    clientOperationId: `${args.clientOperationId}:approved-roster`, requestFingerprint: args.requestFingerprint,
    sourceTeamVersion: team.version, lockedTeamVersion: team.version,
    processedMemberCount: activeMembers.length, processedVitMemberCount: activeMembers.length,
    processedExternalMemberCount: 0,
    hasFirstYear: members.some(m => m.profile.yearOfStudy === "first"),
    hasSecondYear: members.some(m => m.profile.yearOfStudy === "second"),
    hasLaterYear: members.some(m => ["third", "fourth", "fifth_or_later"].includes(m.profile.yearOfStudy)),
    hasPostgraduateYear: members.some(m => m.profile.yearOfStudy === "postgraduate"),
    hasNotApplicableYear: members.some(m => m.profile.yearOfStudy === "not_applicable"),
    createdAt: now, updatedAt: now, completedAt: now,
  });
  for (const row of oldMembers) {
    const { _id, _creationTime, ...data } = row;
    void _id; void _creationTime;
    await ctx.db.insert("teamSubmissionMembers", { ...data, submissionAttemptId: attemptId, materializedAt: now });
  }
  await ctx.db.insert("teamSubmissionMembers", {
    eventId: event._id, teamId: team._id, submissionAttemptId: attemptId,
    ordinal: oldMembers.length + 1, teamMemberId: newMember._id, membershipId: membership._id,
    personId: person._id, role: "member", participantClass: "vit_student",
    displayName: profile.fullName, institution: profile.institution, yearOfStudy: profile.yearOfStudy,
    profileVersion: profile.profileVersion, destinationEmailNormalized: person.verifiedEmail, materializedAt: now,
  });
  const { _id: oldProjectId, _creationTime: oldProjectCreationTime, ...projectData } = project;
  void oldProjectCreationTime;
  const projectVersionId = await ctx.db.insert("projectVersions", {
    ...projectData, version: project.version + 1, lockedRosterSnapshotId: attemptId,
    lockedMemberCount: activeMembers.length,
    rosterRevision: { sourceProjectVersionId: oldProjectId, changedByMembershipId: membership._id, changedAt: now },
  });
  await ctx.db.patch(attemptId, { projectVersionId, applicationId: application._id });
  await ctx.db.patch(team._id, { submissionAttemptId: attemptId, lockedProjectVersionId: projectVersionId, updatedAt: now });
  await ctx.db.patch(application._id, { submittedProjectVersionId: projectVersionId, experienceBand: experienceBandFor(members), version: application.version + 1 });
  if (recovery.lateJoin && offer && reservation && bucket) {
    await ctx.db.patch(offer._id, { lockedRosterSnapshotId: attemptId, participantCount: activeMembers.length,
      version: offer.version + 1 });
    await ctx.db.patch(reservation._id, { participantCount: activeMembers.length });
    await ctx.db.patch(bucket._id, { reserved: bucket.reserved + 1, version: bucket.version + 1, updatedAt: now });
    // The new member has not checked in. Do not retain an all-members-arrived milestone.
    if (team.status === "checked_in") await ctx.db.patch(team._id, { status: "confirmed" });
  }
  await requireSelectedAdmissionCapacity(ctx, event._id);
  await synchronizeTeamAdmissionIdeaComparison(ctx, { eventId: event._id, teamId: team._id });
  await ctx.db.patch(membership._id, { onboardingStatus: recovery.lateJoin ? "accepted" : "selected", updatedAt: now });
  await ctx.db.patch(recovery._id, { status: "completed", completedAt: now, completedByMembershipId: membership._id });
  await writeAuditEvent(ctx, { eventId: event._id, actorPersonId: args.operatorPersonId ?? person._id,
    permissionKey: args.operatorPersonId ? "team.roster.import" : "team.join", grantIds: args.grantIds,
    scopeType: args.operatorPersonId ? "event" : "self", scopeId: args.operatorPersonId ? event._id : membership._id,
    action: "participant.roster_recovery.completed", targetType: "participant_roster_recovery", targetId: recovery._id,
    previousSummary: JSON.stringify({ memberCount: oldMembers.length, projectVersionId: oldProjectId,
      offerVersion: offer?.version, reserved: bucket?.reserved, teamStatus: team.status }),
    nextSummary: JSON.stringify({ memberCount: activeMembers.length, projectVersionId, approvalId: recovery._id,
      applicationState: application.state, admissionDecisionPreserved: true,
      lateJoin: recovery.lateJoin === true, githubSetupWaived: args.operatorPersonId !== undefined,
      policyConsentPreserved: true, attendanceRecorded: false }),
    reason: args.operatorPersonId ? recovery.reason :
      "Participant completed onboarding and explicitly accepted their operator-approved imported team assignment" });
}
