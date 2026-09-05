import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { createAdmissionOffer } from "./admissions";
import { experienceBandFor } from "./lib/submittedTeamRoster";
import { writeAuditEvent } from "./lib/audit";
import { requirePermission } from "./lib/permissions";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";

/** Organizer import of an emailed application; it does not attest or RSVP for participants. */
export const accept = internalMutation({
  args: {
    teamId: v.id("teams"), expectedTeamVersion: v.number(),
    memberEmails: v.array(v.string()), idea: v.string(), evidence: v.string(),
    receivedAt: v.number(), expiresAt: v.number(),
  },
  returns: v.id("admissionOffers"),
  handler: async (ctx, args) => {
    const { person: actor } = await requireCurrentPerson(ctx);
    const team = await ctx.db.get(args.teamId);
    if (!team) throw new Error("Team missing.");
    const event = await ctx.db.get(team.eventId);
    if (!event?.publishedAdmissionPolicyId || !event.publishedParticipantPolicyId ||
      !event.publishedIntakePolicyId || event.admissionResultsReleasedAt === undefined)
      throw new Error("A published event with released admission results is required.");
    const roles = await ctx.db.query("eventRoles")
      .withIndex("by_event_person_status", q => q.eq("eventId", event._id).eq("personId", actor._id).eq("status", "active"))
      .collect();
    if (!roles.some(role => role.role === "supreme" && role.validFrom <= Date.now() &&
      (role.validUntil === undefined || role.validUntil > Date.now())))
      throw new Error("Only an active Supreme can accept an emailed application after release.");
    const subject = await requireEventSubject(ctx, event._id, actor._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id, eventAccessSubjectId: subject._id,
      permissionKey: "application.decide", scopeType: "event",
    });
    const prior = await ctx.db.query("applications")
      .withIndex("by_team", q => q.eq("teamId", team._id)).unique();
    if (prior) {
      const project = await ctx.db.get(prior.submittedProjectVersionId);
      if (prior.currentOfferId && project?.initialIdea === args.idea &&
        project.additionalInformation === args.evidence && project.freshForEventAttestation === null)
        return prior.currentOfferId;
      throw new Error("Team already has an application; it cannot be replaced by an import.");
    }
    if (team.version !== args.expectedTeamVersion || team.status !== "forming" || team.membershipLocked)
      throw new Error("Team changed or is already locked.");
    const now = Date.now();
    if (!args.idea.trim() || !args.evidence.trim() || args.receivedAt > now)
      throw new Error("The emailed submission and its provenance are required.");
    const rows = await ctx.db.query("teamMembers")
      .withIndex("by_team_status", q => q.eq("teamId", team._id).eq("status", "active")).collect();
    const members = await Promise.all(rows.map(async (row) => {
      const membership = await ctx.db.get(row.membershipId);
      if (!membership || membership.eventId !== event._id) throw new Error("Invalid membership.");
      const person = await ctx.db.get(membership.personId);
      const profile = await ctx.db.query("participantProfiles")
        .withIndex("by_membership", q => q.eq("membershipId", membership._id)).unique();
      if (!person || !profile) throw new Error("Every member needs an existing completed profile.");
      return { row, membership, person, profile };
    }));
    const expectedEmails = [...new Set(args.memberEmails.map(email => email.trim().toLowerCase()))].sort();
    if (expectedEmails.length !== rows.length || rows.length !== team.activeMemberCount ||
      members.map(m => m.person.verifiedEmail.toLowerCase()).sort().join("\n") !== expectedEmails.join("\n"))
      throw new Error("The active team roster does not match the emailed roster.");
    const lead = members.find(m => m.membership._id === team.leadMembershipId);
    if (!lead) throw new Error("Team lead missing from roster.");
    const policy = await ctx.db.get(event.publishedAdmissionPolicyId);
    if (!policy || policy.eventId !== event._id) throw new Error("Admission policy missing.");
    const draft = await ctx.db.query("projectDrafts").withIndex("by_team", q => q.eq("teamId", team._id)).unique();
    const draftVersion = (draft?.version ?? 0) + 1;
    const draftFields = {
      eventId: event._id, teamId: team._id, intakePolicyVersionId: event.publishedIntakePolicyId,
      stage: "submitted" as const, initialIdea: args.idea, additionalInformation: args.evidence,
      version: draftVersion, lastEditedByMembershipId: lead.membership._id, updatedAt: now,
    };
    const draftId = draft?._id ?? await ctx.db.insert("projectDrafts", draftFields);
    if (draft) await ctx.db.patch(draftId, draftFields);
    const vitCount = members.filter(m => m.membership.participantClass === "vit_student").length;
    const years = new Set(members.map(m => m.profile.yearOfStudy));
    const attemptId = await ctx.db.insert("teamSubmissionAttempts", {
      eventId: event._id, teamId: team._id, draftId,
      requestedByPersonId: actor._id, requestedByMembershipId: lead.membership._id,
      authorizingGrantIds: grantIds, clientOperationId: `email-import:${team._id}`,
      requestFingerprint: args.evidence, state: "complete", sourceTeamVersion: team.version,
      lockedTeamVersion: team.version + 1, sourceDraftVersion: draftVersion,
      participantPolicyVersionId: event.publishedParticipantPolicyId,
      admissionPolicyVersionId: policy._id, processedMemberCount: rows.length,
      processedVitMemberCount: vitCount, processedExternalMemberCount: rows.length - vitCount,
      hasFirstYear: years.has("first"), hasSecondYear: years.has("second"),
      hasLaterYear: years.has("third") || years.has("fourth") || years.has("fifth_or_later"),
      hasPostgraduateYear: years.has("postgraduate"), hasNotApplicableYear: years.has("not_applicable"),
      createdAt: now, updatedAt: now, completedAt: now,
    });
    for (const [index, m] of members.entries()) await ctx.db.insert("teamSubmissionMembers", {
      eventId: event._id, submissionAttemptId: attemptId, teamId: team._id, ordinal: index + 1,
      teamMemberId: m.row._id, membershipId: m.membership._id, personId: m.person._id,
      role: m.row.role, participantClass: m.membership.participantClass,
      displayName: m.profile.fullName, institution: m.profile.institution,
      yearOfStudy: m.profile.yearOfStudy, profileVersion: m.profile.profileVersion,
      destinationEmailNormalized: m.person.verifiedEmail.toLowerCase(), materializedAt: now,
    });
    const projectId = await ctx.db.insert("projectVersions", {
      eventId: event._id, teamId: team._id, version: 1, initialIdea: args.idea,
      additionalInformation: args.evidence, intakePolicyVersionId: event.publishedIntakePolicyId,
      intakeResponses: [], lockedRosterSnapshotId: attemptId, lockedMemberCount: rows.length,
      lockedLeadMembershipId: lead.membership._id, freshForEventAttestation: null,
      finalConfirmation: null, organizerImport: { importedByPersonId: actor._id, importedAt: now, evidence: args.evidence },
      participantPolicyVersionId: event.publishedParticipantPolicyId,
      admissionPolicyVersionId: policy._id, sourceDraftVersion: draftVersion,
      submittedByMembershipId: lead.membership._id, submittedAt: args.receivedAt,
    });
    const applicationId = await ctx.db.insert("applications", {
      eventId: event._id, teamId: team._id, submittedProjectVersionId: projectId,
      admissionPolicyVersionId: policy._id, state: "accepted", experienceBand: experienceBandFor(members),
      decisionStage: "released", humanDecision: "accept", humanReasonCode: "organizer_email_acceptance",
      decidedByPersonId: actor._id, decidedAt: now, releasedByPersonId: actor._id, releasedAt: now,
      assignedReviewCount: 0, completedReviewCount: 0, contentVersion: 1, version: 1, submittedAt: args.receivedAt,
    });
    await ctx.db.patch(attemptId, { projectVersionId: projectId, applicationId });
    await ctx.db.patch(team._id, {
      status: "admitted", membershipLocked: true, lockedProjectVersionId: projectId,
      submissionAttemptId: attemptId, lockedAt: now,
      lockParticipantPolicyVersionId: event.publishedParticipantPolicyId,
      version: team.version + 1, updatedAt: now,
    });
    const application = await ctx.db.get(applicationId);
    const project = await ctx.db.get(projectId);
    const updatedTeam = await ctx.db.get(team._id);
    if (!application || !project || !updatedTeam) throw new Error("Import did not persist.");
    const { offer } = await createAdmissionOffer(ctx, {
      event, application, project, policy, team: updatedTeam, actorPersonId: actor._id,
      grantIds, expiresAt: args.expiresAt, now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id, actorPersonId: actor._id, permissionKey: "application.decide", grantIds,
      scopeType: "event", scopeId: event._id, action: "admission.email_import.accept",
      targetType: "application", targetId: applicationId,
      previousSummary: JSON.stringify({ teamId: team._id, status: team.status }),
      nextSummary: JSON.stringify({ applicationId, projectId, offerId: offer._id, receivedAt: args.receivedAt }),
      reason: args.evidence,
    });
    return offer._id;
  },
});
