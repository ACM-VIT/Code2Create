import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { synchronizeTeamAdmissionIdeaComparison } from "./lib/noveltyIndex";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { requirePermission, revokeSourceGrants } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { addTeamLeadGrants } from "./lib/teamMembership";

function unavailable(): never {
  throw new ConvexError({ code: "LEAD_TRANSFER_UNAVAILABLE", message: "The confirmed team or its locked roster changed. Refresh before transferring leadership." });
}

/** Organizer intervention for an unresponsive lead; never records participant acceptance. */
export const transfer = mutation({
  args: {
    eventSlug: v.string(), teamId: v.id("teams"), toMembershipId: v.id("eventMemberships"),
    expectedTeamVersion: v.number(), reason: v.string(), clientOperationId: v.string(),
  },
  returns: v.object({ teamId: v.id("teams"), leadMembershipId: v.id("eventMemberships"), projectVersionId: v.id("projectVersions") }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person: actor } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, actor._id);
    const now = Date.now();
    const roles = await ctx.db.query("eventRoles").withIndex("by_event_person_status", q =>
      q.eq("eventId", event._id).eq("personId", actor._id).eq("status", "active")).take(20);
    if (!roles.some(r => r.role === "supreme" && r.validFrom <= now && (r.validUntil === undefined || r.validUntil > now))) {
      throw new ConvexError({ code: "SUPREME_ROLE_REQUIRED", message: "Only an active Supreme can override confirmed-team leadership." });
    }
    const grantIds = await requirePermission(ctx, { eventId: event._id, eventAccessSubjectId: subject._id,
      permissionKey: "team.roster.import", scopeType: "event" });
    const team = await ctx.db.get(args.teamId);
    if (!team || team.eventId !== event._id) return unavailable();
    const application = await ctx.db.query("applications").withIndex("by_team", q => q.eq("teamId", team._id)).unique();
    if (!application || application.eventId !== event._id) return unavailable();
    const decisionGrants = await requirePermission(ctx, { eventId: event._id, eventAccessSubjectId: subject._id,
      permissionKey: "application.decide", scopeType: "application", scopeId: application._id });
    const authorizingGrantIds = [...grantIds, ...decisionGrants];
    const reason = normalizedText(args.reason, "Leadership override reason", 10, 500);
    const clientOperationId = normalizedText(args.clientOperationId, "Operation ID", 1, 200);
    const operation = { eventId: event._id, actorPersonId: actor._id, clientOperationId,
      commandName: "team.operator_lead_transferred", requestFingerprint: operationFingerprint([
        team._id, args.toMembershipId, args.expectedTeamVersion, reason,
      ]) };
    const prior = await findOperation(ctx, operation);
    if (prior) {
      const projectVersionId = ctx.db.normalizeId("projectVersions", prior.targetId);
      if (!projectVersionId) throw new Error("Invalid stored leadership override result.");
      return { teamId: team._id, leadMembershipId: args.toMembershipId, projectVersionId };
    }
    if (event.status !== "registration_closed" || event.endsAt === undefined || now >= event.endsAt ||
        team.version !== args.expectedTeamVersion || !team.membershipLocked ||
        !["confirmed", "checked_in", "active"].includes(team.status) ||
        application.state !== "confirmed" || application.decisionStage !== "released" || application.humanDecision !== "accept") return unavailable();
    const target = await ctx.db.get(args.toMembershipId);
    if (!target || target.eventId !== event._id || target.eligibilityStatus !== "eligible") return unavailable();
    const targetPerson = await ctx.db.get(target.personId);
    if (!targetPerson || targetPerson.status !== "active") return unavailable();
    const targetSubject = await requireEventSubject(ctx, event._id, target.personId);
    if (targetSubject._id !== target.eventAccessSubjectId) return unavailable();
    const members = await ctx.db.query("teamMembers").withIndex("by_team_status", q =>
      q.eq("teamId", team._id).eq("status", "active")).take(100);
    const oldLead = members.find(m => m.membershipId === team.leadMembershipId && m.role === "lead");
    const newLead = members.find(m => m.membershipId === target._id && m.role === "member");
    if (!oldLead || !newLead || members.length >= 100 || members.length !== team.activeMemberCount ||
        members.filter(m => m.role === "lead").length !== 1 ||
        new Set(members.map(m => m.membershipId)).size !== members.length ||
        members.some(m => m.eventId !== event._id)) return unavailable();
    const project = await ctx.db.get(application.submittedProjectVersionId);
    if (!project || project.eventId !== event._id || project.teamId !== team._id ||
        project._id !== team.lockedProjectVersionId || project.lockedLeadMembershipId !== oldLead.membershipId ||
        project.lockedMemberCount !== members.length) return unavailable();
    const attempt = await ctx.db.get(project.lockedRosterSnapshotId);
    if (!attempt || attempt.eventId !== event._id || attempt.teamId !== team._id || attempt.state !== "complete" ||
        attempt._id !== team.submissionAttemptId || attempt.projectVersionId !== project._id ||
        attempt.applicationId !== application._id || attempt.processedMemberCount !== members.length) return unavailable();
    const rows = await ctx.db.query("teamSubmissionMembers").withIndex("by_submission_attempt_and_ordinal", q =>
      q.eq("submissionAttemptId", attempt._id)).take(100);
    if (rows.length !== members.length || new Set(rows.map(r => r.teamMemberId)).size !== rows.length ||
        rows.some((r, i) => r.ordinal !== i + 1 ||
        r.eventId !== event._id || r.teamId !== team._id ||
        !members.some(m => m._id === r.teamMemberId && m.membershipId === r.membershipId && m.role === r.role))) return unavailable();
    const offer = application.currentOfferId ? await ctx.db.get(application.currentOfferId) : null;
    if (!offer || offer.state !== "confirmed" || offer.eventId !== event._id || offer.teamId !== team._id ||
        offer.applicationId !== application._id || offer.lockedRosterSnapshotId !== attempt._id ||
        offer.participantCount !== members.length) return unavailable();
    const pending = await ctx.db.query("teamLeadershipTransfers").withIndex("by_team_state", q =>
      q.eq("teamId", team._id).eq("state", "pending")).take(2);
    if (pending.length > 1) return unavailable();

    await ctx.db.patch(oldLead._id, { role: "member" });
    await ctx.db.patch(newLead._id, { role: "lead" });
    await revokeSourceGrants(ctx, { eventId: event._id, sourceType: "team_lead",
      sourceId: `${team._id}:${oldLead.membershipId}`, revokedByPersonId: actor._id, reason });
    await addTeamLeadGrants(ctx, { event, membership: target, teamId: team._id, actorPersonId: actor._id });
    for (const transfer of pending) await ctx.db.patch(transfer._id, {
      state: "cancelled", decidedByPersonId: actor._id, decidedAt: now,
    });
    const { _id: oldAttemptId, _creationTime: oldAttemptCreated, ...attemptData } = attempt;
    void oldAttemptCreated;
    const attemptId = await ctx.db.insert("teamSubmissionAttempts", {
      ...attemptData, requestedByPersonId: actor._id, requestedByMembershipId: target._id,
      authorizingGrantIds, clientOperationId, requestFingerprint: operation.requestFingerprint,
      sourceTeamVersion: team.version, lockedTeamVersion: team.version + 1,
      createdAt: now, updatedAt: now, completedAt: now,
    });
    for (const row of rows) {
      const { _id, _creationTime, ...rowData } = row;
      void _id; void _creationTime;
      await ctx.db.insert("teamSubmissionMembers", { ...rowData, submissionAttemptId: attemptId,
        role: row.membershipId === target._id ? "lead" : "member", materializedAt: now });
    }
    const { _id: oldProjectId, _creationTime: oldProjectCreated, ...projectData } = project;
    void oldProjectCreated;
    const projectVersionId = await ctx.db.insert("projectVersions", {
      ...projectData, version: project.version + 1, lockedRosterSnapshotId: attemptId,
      lockedLeadMembershipId: target._id,
      rosterRevision: { sourceProjectVersionId: oldProjectId, changedByMembershipId: target._id, changedAt: now },
    });
    await ctx.db.patch(attemptId, { projectVersionId });
    await ctx.db.patch(team._id, { leadMembershipId: target._id, version: team.version + 1,
      submissionAttemptId: attemptId, lockedProjectVersionId: projectVersionId, updatedAt: now });
    await ctx.db.patch(application._id, { submittedProjectVersionId: projectVersionId, version: application.version + 1 });
    await ctx.db.patch(offer._id, { lockedRosterSnapshotId: attemptId, version: offer.version + 1 });
    await synchronizeTeamAdmissionIdeaComparison(ctx, { eventId: event._id, teamId: team._id });
    await recordOperation(ctx, { ...operation, targetType: "project_version", targetId: projectVersionId, createdAt: now });
    await writeAuditEvent(ctx, { eventId: event._id, actorPersonId: actor._id,
      permissionKey: "team.roster.import", grantIds: authorizingGrantIds, scopeType: "event", scopeId: event._id,
      action: operation.commandName, targetType: "team", targetId: team._id,
      previousSummary: JSON.stringify({ leadMembershipId: oldLead.membershipId, teamVersion: team.version,
        projectVersionId: oldProjectId, submissionAttemptId: oldAttemptId }),
      nextSummary: JSON.stringify({ leadMembershipId: target._id, teamVersion: team.version + 1,
        projectVersionId, submissionAttemptId: attemptId, memberCount: members.length,
        admissionDecisionPreserved: true, participantAcceptanceRecorded: false,
        attendanceAndCapacityUnchanged: true }), reason });
    return { teamId: team._id, leadMembershipId: target._id, projectVersionId };
  },
});
