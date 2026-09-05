import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { writeAuditEvent } from "./lib/audit";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePermission } from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { loadRosterMembers, experienceBandFor } from "./lib/submittedTeamRoster";
import { loadCurrentIntakeResponses } from "./lib/intakeQuestions";
import { synchronizeTeamAdmissionIdeaComparison } from "./lib/noveltyIndex";
import { requireSelectedAdmissionCapacity } from "./lib/admissionRsvpSchedule";

/** Increase operational capacity without changing the immutable rules pinned to existing reviews. */
export const increaseCapacity = internalMutation({
  args: { eventId: v.id("events"), expectedBucketVersion: v.number(), expectedCapacity: v.number(),
    capacity: v.number(), reason: v.string(), clientOperationId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const { person } = await requireCurrentPerson(ctx);
    const event = await ctx.db.get(args.eventId);
    if (!event?.publishedAdmissionPolicyId) throw new Error("Published admission policy missing.");
    const policyId = event.publishedAdmissionPolicyId;
    const now = Date.now();
    const roles = await ctx.db.query("eventRoles").withIndex("by_event_person_status", q =>
      q.eq("eventId", event._id).eq("personId", person._id).eq("status", "active")).take(50);
    if (!roles.some(r => r.role === "supreme" && r.validFrom <= now && (r.validUntil === undefined || r.validUntil > now)))
      throw new Error("An active Supreme must approve operational capacity changes.");
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, { eventId: event._id, eventAccessSubjectId: subject._id,
      permissionKey: "configuration.admission.publish", scopeType: "event" });
    const reason = args.reason.trim();
    if (!Number.isSafeInteger(args.capacity) || args.capacity <= args.expectedCapacity || reason.length < 10 ||
      reason.length > 2000 || !args.clientOperationId.trim()) throw new Error("A positive capacity increase and explanation are required.");
    const operation = { eventId: event._id, actorPersonId: person._id, clientOperationId: args.clientOperationId,
      commandName: "admission.capacity.increase", requestFingerprint: operationFingerprint([
        args.expectedBucketVersion, args.expectedCapacity, args.capacity, reason]) };
    const prior = await findOperation(ctx, operation);
    if (prior) return args.capacity;
    if (event.status !== "registration_closed" || event.startsAt === undefined || now >= event.startsAt)
      throw new Error("Capacity exceptions require closed registration before the event starts.");
    const bucket = await ctx.db.query("admissionCapacityBuckets").withIndex("by_policy", q =>
      q.eq("admissionPolicyVersionId", policyId)).unique();
    if (!bucket || bucket.eventId !== event._id || bucket.version !== args.expectedBucketVersion ||
      bucket.capacity !== args.expectedCapacity) throw new Error("Capacity changed; inspect it again.");
    await ctx.db.patch(bucket._id, { capacity: args.capacity, version: bucket.version + 1, updatedAt: now });
    await recordOperation(ctx, { ...operation, targetType: "admission_capacity", targetId: bucket._id,
      resultJson: String(args.capacity), createdAt: now });
    await writeAuditEvent(ctx, { eventId: event._id, actorPersonId: person._id,
      permissionKey: "configuration.admission.publish", grantIds, scopeType: "event", scopeId: event._id,
      action: "admission.capacity.increase", targetType: "admission_capacity", targetId: bucket._id,
      previousSummary: JSON.stringify({ capacity: bucket.capacity, reserved: bucket.reserved, version: bucket.version }),
      nextSummary: JSON.stringify({ capacity: args.capacity, reserved: bucket.reserved, version: bucket.version + 1,
        immutableReviewPolicyUnchanged: true }), reason });
    return args.capacity;
  },
});

type Members = Awaited<ReturnType<typeof loadRosterMembers>>["members"];

async function importSavedDraft(ctx: MutationCtx, args: {
  event: Doc<"events">; team: Doc<"teams">; draft: Doc<"projectDrafts">;
  participantPolicy: Doc<"participantPolicyVersions">; admissionPolicy: Doc<"admissionPolicyVersions">;
  members: Members; actorId: Id<"people">; grantIds: Id<"permissionGrants">[];
  reason: string; clientOperationId: string; fingerprint: string; now: number;
}) {
  const { event, team, draft, members, now } = args;
  if (!draft.initialIdea?.trim()) throw new Error("A saved idea is required for an organizer import.");
  const priorProject = await ctx.db.query("projectVersions")
    .withIndex("by_team_version", q => q.eq("teamId", team._id)).first();
  if (priorProject) throw new Error("An existing project must not be replaced by a draft import.");
  const responses = await loadCurrentIntakeResponses(ctx, draft._id);
  const attemptId = await ctx.db.insert("teamSubmissionAttempts", {
    eventId: event._id, teamId: team._id, draftId: draft._id,
    requestedByPersonId: args.actorId, requestedByMembershipId: team.leadMembershipId,
    authorizingGrantIds: args.grantIds, clientOperationId: args.clientOperationId,
    requestFingerprint: args.fingerprint, state: "complete", sourceTeamVersion: team.version,
    lockedTeamVersion: team.version + 1, sourceDraftVersion: draft.version,
    participantPolicyVersionId: args.participantPolicy._id, admissionPolicyVersionId: args.admissionPolicy._id,
    processedMemberCount: members.length,
    processedVitMemberCount: members.filter(m => m.membership.participantClass === "vit_student").length,
    processedExternalMemberCount: members.filter(m => m.membership.participantClass === "external_participant").length,
    hasFirstYear: members.some(m => m.profile.yearOfStudy === "first"),
    hasSecondYear: members.some(m => m.profile.yearOfStudy === "second"),
    hasLaterYear: members.some(m => ["third", "fourth", "fifth_or_later"].includes(m.profile.yearOfStudy)),
    hasPostgraduateYear: members.some(m => m.profile.yearOfStudy === "postgraduate"),
    hasNotApplicableYear: members.some(m => m.profile.yearOfStudy === "not_applicable"),
    createdAt: now, updatedAt: now, completedAt: now,
  });
  for (const [index, m] of members.entries()) await ctx.db.insert("teamSubmissionMembers", {
    eventId: event._id, submissionAttemptId: attemptId, teamId: team._id, ordinal: index + 1,
    teamMemberId: m.teamMember._id, membershipId: m.membership._id, personId: m.person._id,
    role: m.teamMember.role, participantClass: m.membership.participantClass,
    displayName: m.profile.fullName, institution: m.profile.institution,
    yearOfStudy: m.profile.yearOfStudy, profileVersion: m.profile.profileVersion,
    destinationEmailNormalized: m.person.verifiedEmail.trim().toLowerCase(), materializedAt: now,
  });
  const evidence = JSON.stringify({ kind: "organizer_saved_draft_exception", reason: args.reason,
    draftId: draft._id, draftVersion: draft.version, draftStage: draft.stage, draftSavedAt: draft.updatedAt });
  const projectId = await ctx.db.insert("projectVersions", {
    eventId: event._id, teamId: team._id, version: 1, initialIdea: draft.initialIdea,
    ...(draft.additionalInformation !== undefined ? { additionalInformation: draft.additionalInformation } : {}),
    intakePolicyVersionId: draft.intakePolicyVersionId,
    intakeResponses: responses.flatMap(({ question, answer }) => answer ? [{
      questionId: question._id, ordinal: question.ordinal, question: question.text,
      purposeKey: question.purposeKey, answerLength: question.answerLength, source: question.source,
      answer: answer.value,
    }] : []),
    lockedRosterSnapshotId: attemptId, lockedMemberCount: members.length, lockedLeadMembershipId: team.leadMembershipId,
    freshForEventAttestation: null, finalConfirmation: null,
    organizerImport: { importedByPersonId: args.actorId, importedAt: now, evidence },
    participantPolicyVersionId: args.participantPolicy._id, admissionPolicyVersionId: args.admissionPolicy._id,
    sourceDraftVersion: draft.version, submittedByMembershipId: team.leadMembershipId, submittedAt: now,
  });
  const applicationId = await ctx.db.insert("applications", {
    eventId: event._id, teamId: team._id, submittedProjectVersionId: projectId,
    admissionPolicyVersionId: args.admissionPolicy._id, state: "accepted", experienceBand: experienceBandFor(members),
    decisionStage: "released", humanDecision: "accept", humanReasonCode: "organizer_admission_exception",
    decidedByPersonId: args.actorId, decidedAt: now, releasedByPersonId: args.actorId, releasedAt: now,
    assignedReviewCount: 0, completedReviewCount: 0, contentVersion: 1, version: 1, submittedAt: now,
  });
  await ctx.db.patch(attemptId, { projectVersionId: projectId, applicationId });
  await ctx.db.patch(team._id, {
    status: "admitted", membershipLocked: true, lockedProjectVersionId: projectId,
    submissionAttemptId: attemptId, lockedAt: now, lockParticipantPolicyVersionId: args.participantPolicy._id,
    version: team.version + 1, updatedAt: now,
  });
  // Preserve the original draft, answers and attestations as source evidence.
  // The immutable organizer-import project, not a fabricated participant confirmation, owns admission.
  return applicationId;
}

const acceptanceArgs = v.object({
    teamId: v.id("teams"), expectedTeamName: v.string(), expectedTeamVersion: v.number(),
    source: v.union(
      v.object({ kind: v.literal("released"), applicationId: v.id("applications"), expectedVersion: v.number() }),
      v.object({ kind: v.literal("draft"), draftId: v.id("projectDrafts"), expectedVersion: v.number() }),
    ),
    reason: v.string(), clientOperationId: v.string(),
});

/** Audited organizer exception only. Never opens RSVP, reserves places, or confirms attendance. */
export const accept = internalMutation({
  args: acceptanceArgs.fields,
  returns: v.id("applications"),
  handler: async (ctx, args) => {
    const { person: actor } = await requireCurrentPerson(ctx);
    const team = await ctx.db.get(args.teamId);
    if (!team || team.name !== args.expectedTeamName) throw new Error("The exact team does not match.");
    const event = await ctx.db.get(team.eventId);
    if (!event || event.admissionResultsReleasedAt === undefined) throw new Error("Released admission results are required.");
    const now = Date.now();
    const roles = await ctx.db.query("eventRoles").withIndex("by_event_person_status", q =>
      q.eq("eventId", event._id).eq("personId", actor._id).eq("status", "active")).take(50);
    if (!roles.some(r => r.role === "supreme" && r.validFrom <= now && (r.validUntil === undefined || r.validUntil > now)))
      throw new Error("An active Supreme must authorize an admission exception.");
    const subject = await requireEventSubject(ctx, event._id, actor._id);
    const grantIds = await requirePermission(ctx, { eventId: event._id, eventAccessSubjectId: subject._id,
      permissionKey: "application.decide", scopeType: "event" });
    const reason = args.reason.trim();
    if (reason.length < 10 || reason.length > 2000 || !args.clientOperationId.trim())
      throw new Error("A bounded explanation and operation ID are required.");
    const fingerprint = operationFingerprint([args.teamId, args.expectedTeamName, args.expectedTeamVersion,
      args.source.kind, args.source.kind === "draft" ? args.source.draftId : args.source.applicationId,
      args.source.expectedVersion, reason]);
    const operation = { eventId: event._id, actorPersonId: actor._id, clientOperationId: args.clientOperationId,
      commandName: "admission.exception.accept", requestFingerprint: fingerprint };
    const prior = await findOperation(ctx, operation);
    if (prior) {
      const id = ctx.db.normalizeId("applications", prior.targetId);
      if (!id) throw new Error("Invalid recorded admission exception.");
      return id;
    }
    if (event.status !== "registration_closed" || event.startsAt === undefined || now >= event.startsAt)
      throw new Error("Admission exceptions require closed registration before the event starts.");
    if (team.version !== args.expectedTeamVersion) throw new Error("The team changed; inspect it again.");
    const application = await ctx.db.query("applications").withIndex("by_team", q => q.eq("teamId", team._id)).unique();
    const existingProject = application ? await ctx.db.get(application.submittedProjectVersionId) : null;
    const participantPolicyId = existingProject?.participantPolicyVersionId ?? event.publishedParticipantPolicyId;
    const participantPolicy = participantPolicyId ? await ctx.db.get(participantPolicyId) : null;
    if (!participantPolicy || participantPolicy.eventId !== event._id) throw new Error("Participant policy missing.");
    const { members } = await loadRosterMembers(ctx, { event, team, participantPolicy });
    let applicationId: Id<"applications">;
    let previousSummary: string;
    if (args.source.kind === "released") {
      if (!application || application._id !== args.source.applicationId || application.eventId !== event._id ||
        application.version !== args.source.expectedVersion || application.decisionStage !== "released" ||
        !["declined", "waitlisted"].includes(application.state) || application.currentOfferId !== undefined ||
        team.status !== "submitted" || !team.membershipLocked || !existingProject ||
        existingProject.teamId !== team._id || existingProject.eventId !== event._id ||
        team.lockedProjectVersionId !== existingProject._id)
        throw new Error("Only an unchanged released decline or waitlist without an offer can be corrected.");
      const snapshot = await ctx.db.get(existingProject.lockedRosterSnapshotId);
      const snapshots = await ctx.db.query("teamSubmissionMembers").withIndex("by_submission_attempt_and_ordinal", q =>
        q.eq("submissionAttemptId", existingProject.lockedRosterSnapshotId)).take(members.length + 1);
      if (!snapshot || snapshot.state !== "complete" || snapshot.eventId !== event._id || snapshot.teamId !== team._id ||
        snapshot.processedMemberCount !== members.length || existingProject.lockedMemberCount !== members.length ||
        snapshots.length !== members.length || members.some(m => !snapshots.some(s =>
          s.membershipId === m.membership._id && s.personId === m.person._id && s.teamMemberId === m.teamMember._id)))
        throw new Error("The active roster no longer matches the submitted roster.");
      previousSummary = JSON.stringify(application);
      applicationId = application._id;
      await ctx.db.patch(applicationId, { state: "accepted", humanDecision: "accept",
        humanReasonCode: "organizer_admission_exception", aiDisposition: "cleared",
        decidedByPersonId: actor._id, decidedAt: now, releasedByPersonId: actor._id, releasedAt: now,
        version: application.version + 1 });
      await ctx.db.patch(team._id, { status: "admitted", version: team.version + 1, updatedAt: now });
    } else {
      const draft = await ctx.db.get(args.source.draftId);
      if (application || team.status !== "forming" || team.membershipLocked || !draft ||
        draft.eventId !== event._id || draft.teamId !== team._id || draft.version !== args.source.expectedVersion || draft.stage === "submitted")
        throw new Error("Only an unchanged forming team with its original saved draft can be imported.");
      const admissionPolicy = event.publishedAdmissionPolicyId ? await ctx.db.get(event.publishedAdmissionPolicyId) : null;
      const intakePolicy = await ctx.db.get(draft.intakePolicyVersionId);
      if (!admissionPolicy || admissionPolicy.eventId !== event._id || admissionPolicy.status !== "published" ||
        !intakePolicy || intakePolicy.eventId !== event._id) throw new Error("Admission or intake policy missing.");
      const importGrants = await requirePermission(ctx, { eventId: event._id, eventAccessSubjectId: subject._id,
        permissionKey: "team.roster.import", scopeType: "event" });
      previousSummary = JSON.stringify({ teamStatus: team.status, draftId: draft._id, draftVersion: draft.version,
        stage: draft.stage, savedAt: draft.updatedAt, participantConfirmation: false });
      applicationId = await importSavedDraft(ctx, { event, team, draft, participantPolicy, admissionPolicy, members,
        actorId: actor._id, grantIds: [...grantIds, ...importGrants], reason, now,
        clientOperationId: args.clientOperationId, fingerprint });
    }
    await requireSelectedAdmissionCapacity(ctx, event._id);
    for (const m of members) await ctx.db.patch(m.membership._id, { onboardingStatus: "selected", updatedAt: now });
    await synchronizeTeamAdmissionIdeaComparison(ctx, { eventId: event._id, teamId: team._id });
    await recordOperation(ctx, { ...operation, targetType: "application", targetId: applicationId, createdAt: now });
    await writeAuditEvent(ctx, { eventId: event._id, actorPersonId: actor._id, permissionKey: "application.decide",
      grantIds, scopeType: "event", scopeId: event._id, action: "admission.exception.accept",
      targetType: "application", targetId: applicationId, previousSummary,
      nextSummary: JSON.stringify({ teamId: team._id, applicationId, source: args.source, state: "accepted",
        participantCount: members.length, offerCreated: false, participantRsvpRecorded: false }), reason });
    return applicationId;
  },
});
