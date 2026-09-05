import { ConvexError, v } from "convex/values";

import { writeAuditEvent } from "./lib/audit";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { addTeamMemberGrants } from "./lib/teamMembership";
import { endActiveTeamMember, insertActiveTeamMember } from "./lib/teamRoster";
import {
  isParticipantReadyForPolicy,
  loadPublishedParticipantPolicy,
} from "./lib/participantPolicy";
import { requirePermission, revokeSourceGrants } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { experienceBandFor, loadRosterMembers } from "./lib/submittedTeamRoster";
import { requireSelectedAdmissionCapacity } from "./lib/admissionRsvpSchedule";
import { synchronizeTeamAdmissionIdeaComparison } from "./lib/noveltyIndex";
import { mutation } from "./_generated/server";

/** Moves the sole member of a forming team into an accepted team and copies its locked roster. */
export const moveSoleMemberIntoAcceptedTeam = mutation({
  args: {
    eventSlug: v.string(),
    personId: v.id("people"),
    sourceTeamId: v.id("teams"),
    expectedSourceTeamVersion: v.number(),
    targetTeamId: v.id("teams"),
    expectedTargetTeamVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ teamId: v.id("teams"), projectVersionId: v.id("projectVersions") }),
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (query) => query.eq("slug", args.eventSlug))
      .unique();
    if (!event) throw new Error("Event missing.");
    const { person: actor } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, actor._id);
    const roles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event_person_status", (query) =>
        query.eq("eventId", event._id).eq("personId", actor._id).eq("status", "active"),
      )
      .collect();
    const now = Date.now();
    if (
      !roles.some(
        (role) =>
          role.role === "supreme" &&
          role.validFrom <= now &&
          (role.validUntil === undefined || role.validUntil > now),
      )
    ) {
      throw new ConvexError({
        code: "SUPREME_ROLE_REQUIRED",
        message: "Only an active Supreme can move a participant after admission release.",
      });
    }
    const [rosterGrantIds, source, target, movedPerson] = await Promise.all([
      requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: actorSubject._id,
        permissionKey: "team.roster.import",
        scopeType: "event",
      }),
      ctx.db.get(args.sourceTeamId),
      ctx.db.get(args.targetTeamId),
      ctx.db.get(args.personId),
    ]);
    if (!source || !target || !movedPerson || source.eventId !== event._id || target.eventId !== event._id) {
      throw new Error("Roster move context is incomplete.");
    }
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (query) =>
        query.eq("eventId", event._id).eq("personId", movedPerson._id),
      )
      .unique();
    if (!membership || membership.eligibilityStatus !== "eligible") {
      throw new Error("Eligible membership missing.");
    }
    const existingTargetMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (query) =>
        query.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
      )
      .unique();
    const application = await ctx.db
      .query("applications")
      .withIndex("by_team", (query) => query.eq("teamId", target._id))
      .unique();
    if (!application) throw new Error("Target application missing.");
    const decisionGrantIds = await requirePermission(ctx, {
      eventId: event._id, eventAccessSubjectId: actorSubject._id,
      permissionKey: "application.decide", scopeType: "application", scopeId: application._id,
    });
    const reason = normalizedText(args.reason, "Roster move reason", 10, 500);
    const clientOperationId = normalizedText(args.clientOperationId, "Operation ID", 1, 200);
    const operation = { eventId: event._id, actorPersonId: actor._id, clientOperationId,
      commandName: "team.operator_member_moved", requestFingerprint: operationFingerprint([
        args.personId, source._id, args.expectedSourceTeamVersion, target._id, args.expectedTargetTeamVersion, reason,
      ]) };
    const prior = await findOperation(ctx, operation);
    if (prior) {
      const projectVersionId = ctx.db.normalizeId("projectVersions", prior.targetId);
      if (!projectVersionId) throw new Error("Invalid recorded roster move.");
      return { teamId: target._id, projectVersionId };
    }
    if (event.status !== "registration_closed" || event.startsAt === undefined || now >= event.startsAt ||
      event.admissionResultsReleasedAt === undefined) throw new Error("Roster corrections require released admissions before the event starts.");
    const currentProject = await ctx.db.get(application.submittedProjectVersionId);
    if (
      source.version !== args.expectedSourceTeamVersion ||
      target.version !== args.expectedTargetTeamVersion ||
      source.status !== "forming" ||
      source.membershipLocked ||
      source.activeMemberCount !== 1 ||
      source.leadMembershipId !== membership._id ||
      target.status !== "admitted" ||
      !target.membershipLocked ||
      application.state !== "accepted" ||
      application.decisionStage !== "released" ||
      application.humanDecision !== "accept" ||
      application.currentOfferId !== undefined ||
      !currentProject ||
      target.lockedProjectVersionId !== currentProject._id
    ) {
      throw new Error("The source or target team changed and cannot be moved safely.");
    }
    const reservations = await ctx.db
      .query("admissionCapacityReservations")
      .withIndex("by_application_state", (query) =>
        query.eq("applicationId", application._id).eq("state", "active"),
      )
      .take(1);
    if (reservations.length > 0) throw new Error("Target team has a pending admission reservation.");
    const profile = await ctx.db
      .query("participantProfiles")
      .withIndex("by_membership", (query) => query.eq("membershipId", membership._id))
      .unique();
    const { policy, normalized } = await loadPublishedParticipantPolicy(ctx, event);
    if (
      !profile ||
      !(await isParticipantReadyForPolicy(ctx, profile, membership, policy)) ||
      target.activeMemberCount + 1 > normalized.teamMaximumSize
    ) {
      throw new Error("The participant or target roster does not meet the published policy.");
    }
    const sourceMember = existingTargetMember;
    if (!sourceMember || sourceMember.teamId !== source._id || sourceMember.role !== "lead") {
      throw new Error("The participant is not the sole lead of the source team.");
    }
    const priorAttempt = await ctx.db.get(currentProject.lockedRosterSnapshotId);
    if (!priorAttempt || priorAttempt.state !== "complete" || target.submissionAttemptId !== priorAttempt._id) {
      throw new Error("The accepted roster snapshot is inconsistent.");
    }
    const [priorRows, activeTargetMembers] = await Promise.all([
      ctx.db
        .query("teamSubmissionMembers")
        .withIndex("by_submission_attempt_and_ordinal", (query) =>
          query.eq("submissionAttemptId", priorAttempt._id),
        )
        .collect(),
      ctx.db
        .query("teamMembers")
        .withIndex("by_team_status", (query) =>
          query.eq("teamId", target._id).eq("status", "active"),
        )
        .collect(),
    ]);
    if (
      priorRows.length !== currentProject.lockedMemberCount ||
      activeTargetMembers.length !== target.activeMemberCount ||
      priorRows.some((row) => !activeTargetMembers.some((member) => member._id === row.teamMemberId))
    ) {
      throw new Error("The accepted roster no longer matches its snapshot.");
    }

    await endActiveTeamMember(ctx, {
      team: source,
      teamMember: sourceMember,
      membership,
      status: "left",
      leftAt: now,
    });
    await ctx.db.patch(source._id, { status: "withdrawn", version: source.version + 1, updatedAt: now });
    await revokeSourceGrants(ctx, {
      eventId: event._id,
      sourceType: "team_membership",
      sourceId: sourceMember._id,
      revokedByPersonId: actor._id,
      reason,
    });
    await revokeSourceGrants(ctx, {
      eventId: event._id,
      sourceType: "team_lead",
      sourceId: `${source._id}:${membership._id}`,
      revokedByPersonId: actor._id,
      reason,
    });
    const { teamMemberId } = await insertActiveTeamMember(ctx, {
      team: target,
      membership,
      role: "member",
      source: "backfill",
      joinedAt: now,
    });
    await addTeamMemberGrants(ctx, {
      event,
      membership,
      teamId: target._id,
      teamMemberId,
      actorPersonId: actor._id,
      lead: false,
    });
    await ctx.db.patch(target._id, { version: target.version + 1, updatedAt: now });

    const updatedTarget = await ctx.db.get(target._id);
    if (!updatedTarget) throw new Error("Target team missing after roster move.");
    const { members } = await loadRosterMembers(ctx, { event, team: updatedTarget, participantPolicy: policy });
    const { _id: priorAttemptId, _creationTime: priorAttemptCreated, ...attemptData } = priorAttempt;
    void priorAttemptId;
    void priorAttemptCreated;
    const attemptId = await ctx.db.insert("teamSubmissionAttempts", {
      ...attemptData,
      requestedByPersonId: actor._id,
      requestedByMembershipId: membership._id,
      authorizingGrantIds: [...rosterGrantIds, ...decisionGrantIds],
      clientOperationId,
      requestFingerprint: operation.requestFingerprint,
      sourceTeamVersion: target.version,
      lockedTeamVersion: target.version + 1,
      processedMemberCount: priorRows.length + 1,
      processedVitMemberCount:
        priorAttempt.processedVitMemberCount + (membership.participantClass === "vit_student" ? 1 : 0),
      processedExternalMemberCount:
        priorAttempt.processedExternalMemberCount +
        (membership.participantClass === "external_participant" ? 1 : 0),
      hasFirstYear: priorAttempt.hasFirstYear || profile.yearOfStudy === "first",
      hasSecondYear: priorAttempt.hasSecondYear || profile.yearOfStudy === "second",
      hasLaterYear:
        priorAttempt.hasLaterYear ||
        ["third", "fourth", "fifth_or_later"].includes(profile.yearOfStudy),
      hasPostgraduateYear:
        priorAttempt.hasPostgraduateYear || profile.yearOfStudy === "postgraduate",
      hasNotApplicableYear:
        priorAttempt.hasNotApplicableYear || profile.yearOfStudy === "not_applicable",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    for (const row of priorRows) {
      const { _id, _creationTime, ...rowData } = row;
      void _id;
      void _creationTime;
      await ctx.db.insert("teamSubmissionMembers", {
        ...rowData,
        submissionAttemptId: attemptId,
        materializedAt: now,
      });
    }
    await ctx.db.insert("teamSubmissionMembers", {
      eventId: event._id,
      submissionAttemptId: attemptId,
      teamId: target._id,
      ordinal: priorRows.length + 1,
      teamMemberId,
      membershipId: membership._id,
      personId: movedPerson._id,
      role: "member",
      participantClass: membership.participantClass,
      displayName: profile.fullName,
      institution: profile.institution,
      yearOfStudy: profile.yearOfStudy,
      profileVersion: profile.profileVersion,
      destinationEmailNormalized: movedPerson.verifiedEmail,
      materializedAt: now,
    });
    const { _id: priorProjectId, _creationTime: priorProjectCreated, ...projectData } = currentProject;
    void priorProjectCreated;
    const projectVersionId = await ctx.db.insert("projectVersions", {
      ...projectData,
      version: currentProject.version + 1,
      lockedRosterSnapshotId: attemptId,
      lockedMemberCount: priorRows.length + 1,
      rosterRevision: {
        sourceProjectVersionId: priorProjectId,
        changedByMembershipId: membership._id,
        changedAt: now,
      },
    });
    await ctx.db.patch(attemptId, { projectVersionId, applicationId: application._id });
    await ctx.db.patch(target._id, {
      submissionAttemptId: attemptId,
      lockedProjectVersionId: projectVersionId,
      updatedAt: now,
    });
    await ctx.db.patch(application._id, {
      submittedProjectVersionId: projectVersionId,
      experienceBand: experienceBandFor(members),
      version: application.version + 1,
    });
    await requireSelectedAdmissionCapacity(ctx, event._id);
    await synchronizeTeamAdmissionIdeaComparison(ctx, { eventId: event._id, teamId: target._id });
    await recordOperation(ctx, { ...operation, targetType: "project_version", targetId: projectVersionId, createdAt: now });
    await ctx.db.patch(membership._id, { onboardingStatus: "selected", updatedAt: now });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: actor._id,
      permissionKey: "team.roster.import",
      grantIds: [...rosterGrantIds, ...decisionGrantIds],
      scopeType: "event",
      scopeId: event._id,
      action: "team.operator_member_moved",
      targetType: "team",
      targetId: target._id,
      previousSummary: JSON.stringify({
        sourceTeamId: source._id,
        targetMemberCount: priorRows.length,
        projectVersionId: priorProjectId,
        applicationVersion: application.version,
      }),
      nextSummary: JSON.stringify({
        personId: movedPerson._id,
        sourceTeamStatus: "withdrawn",
        targetMemberCount: priorRows.length + 1,
        projectVersionId,
        applicationVersion: application.version + 1,
        admissionDecisionPreserved: true,
      }),
      reason,
    });
    return { teamId: target._id, projectVersionId };
  },
});
