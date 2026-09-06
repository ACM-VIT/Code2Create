import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePermission, revokeSourceGrants } from "./lib/permissions";
import { canManagePanelRoster, grantPanelMemberAccess } from "./lib/reviewAccess";
import { putInRoundReserve } from "./lib/reviewRoster";
import { scheduleShiftReminders } from "./lib/reviewConfirmation";
import { appendReviewPanelVacancyReadFactById } from "./lib/operationsAutonomyReadFacts";
import { findOperation, operationFingerprint, recordOperation, storedOperationVersion } from "./lib/operations";
import { normalizedText } from "./lib/strings";
import { writeAuditEvent } from "./lib/audit";
import { loadPublishedPhaseSchedule, phaseWindowInput, phaseScheduleChecksum, phaseScheduleIssues } from "./lib/phaseSchedule";

/** Audited recovery of a finalized roster, before any team has entered review. */
export const restoreBeforeStart = internalMutation({
  args: {
    eventSlug: v.string(), roundId: v.id("reviewRounds"), snapshotAt: v.number(), startsAt: v.number(),
    expectedRoundVersion: v.number(),
    panels: v.array(v.object({ panelId: v.id("reviewPanels"), expectedVersion: v.number() })),
    reason: v.string(), clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    if (!(await canManagePanelRoster(ctx, event._id, person._id))) throw new ConvexError("Only Board members can restore panels.");
    const grantIds = await requirePermission(ctx, { eventId: event._id, eventAccessSubjectId: subject._id,
      permissionKey: "round.manage", scopeType: "round", scopeId: args.roundId });
    const reason = normalizedText(args.reason, "Recovery reason", 10, 1000);
    const operation = { eventId: event._id, actorPersonId: person._id, clientOperationId: args.clientOperationId,
      commandName: "review.round.restore_before_start", requestFingerprint: operationFingerprint([
        args.roundId, args.snapshotAt, args.startsAt, args.expectedRoundVersion, JSON.stringify(args.panels), reason,
      ]) };
    const prior = await findOperation(ctx, operation);
    if (prior) return { version: storedOperationVersion(prior.resultJson, "round recovery") };
    const round = await ctx.db.get(args.roundId);
    const now = Date.now();
    if (!round || round.eventId !== event._id || round.status !== "published" || round.version !== args.expectedRoundVersion) {
      throw new ConvexError("Only the unchanged, published round can be restored before reviews begin.");
    }
    if (!Number.isSafeInteger(args.snapshotAt) || args.snapshotAt < round.createdAt || args.snapshotAt >= now ||
      !Number.isSafeInteger(args.startsAt) || args.startsAt <= Math.max(now, round.startsAt) ||
      args.startsAt + round.reviewDurationSeconds * 1000 > round.endsAt) {
      throw new ConvexError("Choose a past roster snapshot and a later review start before the current finish.");
    }
    const panels = await ctx.db.query("reviewPanels").withIndex("by_round_status", q => q.eq("roundId", round._id)).collect();
    if (panels.length === 0 || panels.length > 20 || args.panels.length !== panels.length ||
      new Set(args.panels.map(p => p.panelId)).size !== panels.length) throw new ConvexError("Provide every current panel exactly once.");
    const history = await ctx.db.query("reviewPanelMembers").withIndex("by_round_person_status", q => q.eq("roundId", round._id)).collect();
    const restored = history.filter(m => m.assignedAt <= args.snapshotAt && (m.endedAt === undefined || m.endedAt > args.snapshotAt));
    if (new Set(restored.map(m => m.personId)).size !== restored.length) throw new ConvexError("The snapshot has overlapping reviewer assignments.");
    for (const panel of panels) {
      if (args.panels.find(p => p.panelId === panel._id)?.expectedVersion !== panel.version ||
        !["ready", "needs_reviewer", "paused"].includes(panel.status)) throw new ConvexError("A panel changed. Inspect the new roster before restoring.");
      await requirePermission(ctx, { eventId: event._id, eventAccessSubjectId: subject._id,
        permissionKey: "review.substitute.assign", scopeType: "panel", scopeId: panel._id });
      const sessions = await ctx.db.query("reviewSessions").withIndex("by_panel_status", q => q.eq("panelId", panel._id)).collect();
      const chain = await ctx.db.query("reviewerPageChains").withIndex("by_panel_state", q => q.eq("panelId", panel._id).eq("state", "active")).first();
      if (sessions.some(s => s.status !== "cancelled") || chain) throw new ConvexError("Resolve existing reviews or active substitute pages before restoring panels.");
      const members = restored.filter(m => m.panelId === panel._id);
      if (members.length !== round.requiredPanelSize || members.filter(m => m.isCoordinator).length !== 1) {
        throw new ConvexError("The snapshot must contain a complete panel and exactly one lead for every panel.");
      }
    }
    for (const member of restored) {
      const account = await ctx.db.get(member.eventAccessSubjectId);
      const reviewer = await ctx.db.get(member.personId);
      if (account?.status !== "active" || reviewer?.status !== "active") throw new ConvexError("A snapshot reviewer no longer has an active account.");
    }
    // The public schedule normally freezes started phases. This recovery is only
    // allowed while the actual review round has never been opened or used.
    const published = await loadPublishedPhaseSchedule(ctx, event);
    if (published) {
      const { schedule, windows } = published;
      const phases = windows.map(phaseWindowInput);
      const index = phases.findIndex(p => p.phaseKey === round.stableKey);
      const phase = phases[index];
      if (phase) {
        const phaseGrants = await requirePermission(ctx, { eventId: event._id, eventAccessSubjectId: subject._id,
          permissionKey: "configuration.phase.publish", scopeType: "event" });
        if (phase.startsAt !== round.startsAt) throw new ConvexError("The phase and round starts differ. Reconcile the schedule before recovery.");
        const previous = phases[index - 1];
        const next = phases[index + 1];
        phase.startsAt = args.startsAt;
        phase.endsAt = round.endsAt;
        if (previous) previous.endsAt = args.startsAt;
        if (next) next.startsAt = round.endsAt;
        const issues = phaseScheduleIssues(phases);
        if (issues.length) throw new ConvexError(issues[0] ?? "Invalid phase schedule");
        const latest = await ctx.db.query("eventPhaseScheduleVersions").withIndex("by_event_version", q => q.eq("eventId", event._id)).order("desc").first();
        const scheduleId = await ctx.db.insert("eventPhaseScheduleVersions", { eventId: event._id,
          version: (latest?.version ?? 0) + 1, status: "published", checksum: phaseScheduleChecksum(phases),
          createdByPersonId: person._id, createdAt: now, publishedAt: now });
        for (const entry of phases) await ctx.db.insert("eventPhaseWindows", { ...entry, eventId: event._id,
          scheduleVersionId: scheduleId, status: "published", createdAt: now });
        await ctx.db.patch(schedule._id, { status: "superseded" });
        await ctx.db.patch(event._id, { publishedEventPhaseScheduleId: scheduleId, version: event.version + 1, updatedAt: now });
        await writeAuditEvent(ctx, { eventId: event._id, actorPersonId: person._id, permissionKey: "configuration.phase.publish",
          grantIds: phaseGrants, scopeType: "event", action: "review.phase_postponed", targetType: "event_phase_schedule", targetId: scheduleId,
          previousSummary: JSON.stringify({ scheduleId: schedule._id }), nextSummary: JSON.stringify({ scheduleId, phaseKey: phase.phaseKey,
            startsAt: args.startsAt, endsAt: round.endsAt }), reason });
      }
    }
    const retainedIds = new Set(restored.map(m => m._id));
    const departing = history.filter(m => m.status === "active" && !retainedIds.has(m._id));
    for (const member of departing) {
      await ctx.db.patch(member._id, { status: "removed", endedAt: now });
      await revokeSourceGrants(ctx, { eventId: event._id, sourceType: "panel_assignment", sourceId: member._id,
        revokedByPersonId: person._id, reason });
    }
    for (const member of restored) {
      if (member.status !== "active") {
        const id = await ctx.db.insert("reviewPanelMembers", {
          eventId: event._id, roundId: round._id, panelId: member.panelId, personId: member.personId,
          eventAccessSubjectId: member.eventAccessSubjectId, assignedCriterionIds: member.assignedCriterionIds,
          seatSeniority: member.seatSeniority, isCoordinator: member.isCoordinator, status: "active", assignedAt: now,
        });
        await grantPanelMemberAccess(ctx, { eventId: event._id, roundId: round._id, panelId: member.panelId,
          panelMemberId: id, reviewerPersonId: member.personId, eventAccessSubjectId: member.eventAccessSubjectId,
          grantedByPersonId: person._id, isCoordinator: member.isCoordinator, reason });
      }
      const reserve = await ctx.db.query("reviewRoundReserves").withIndex("by_round_person", q =>
        q.eq("roundId", round._id).eq("personId", member.personId)).unique();
      if (reserve && reserve.status !== "assigned") {
        if (reserve.status === "paged") throw new ConvexError("A restored reviewer has an outstanding page.");
        await ctx.db.patch(reserve._id, { status: "assigned", version: reserve.version + 1, updatedAt: now });
        await revokeSourceGrants(ctx, { eventId: event._id, sourceType: "reserve_assignment", sourceId: reserve._id,
          revokedByPersonId: person._id, reason });
      }
    }
    const restoredPeople = new Set(restored.map(m => m.personId));
    for (const member of departing.filter(m => !restoredPeople.has(m.personId))) {
      const reserve = await ctx.db.query("reviewRoundReserves").withIndex("by_round_person", q =>
        q.eq("roundId", round._id).eq("personId", member.personId)).unique();
      if (reserve) await revokeSourceGrants(ctx, { eventId: event._id, sourceType: "reserve_assignment",
        sourceId: reserve._id, revokedByPersonId: person._id, reason });
      await putInRoundReserve(ctx, { round, personId: member.personId, subjectId: member.eventAccessSubjectId,
        actorId: person._id, reason, now });
    }
    const version = round.version + 1;
    const updatedRound = { ...round, startsAt: args.startsAt,
      reviewerReportAt: args.startsAt - round.noShowGraceSeconds * 1000, version };
    await ctx.db.patch(round._id, { startsAt: updatedRound.startsAt, reviewerReportAt: updatedRound.reviewerReportAt,
      version, configurationChecksum: operationFingerprint([round.configurationChecksum, operation.requestFingerprint]) });
    const confirmations = await ctx.db.query("reviewerRoundConfirmations").withIndex("by_roundId_and_personId", q => q.eq("roundId", round._id)).collect();
    for (const confirmation of confirmations.filter(c => c.status === "confirmed")) {
      // A delay may shorten confirmed hours, but cannot extend anyone's consented availability.
      const windows = confirmation.windows.map(w => ({ startsAt: Math.max(w.startsAt, args.startsAt), endsAt: w.endsAt }))
        .filter(w => w.endsAt - w.startsAt >= round.reviewDurationSeconds * 1000);
      const status = windows.length > 0 ? "confirmed" as const : "pending" as const;
      const updated = { ...confirmation, windows, status, version: confirmation.version + 1, updatedAt: now };
      await ctx.db.patch(confirmation._id, { windows, status, version: updated.version, updatedAt: now });
      await scheduleShiftReminders(ctx, updated, updatedRound, now);
    }
    for (const panel of panels) {
      const members = restored.filter(m => m.panelId === panel._id);
      const lead = members.find(m => m.isCoordinator);
      if (!lead) throw new Error("Validated lead missing");
      await ctx.db.patch(panel._id, { coordinatorPersonId: lead.personId, status: panel.status === "paused" ? "paused" : "ready",
        version: panel.version + 1, updatedAt: now });
      await appendReviewPanelVacancyReadFactById(ctx, panel._id, now);
      await writeAuditEvent(ctx, { eventId: event._id, actorPersonId: person._id, permissionKey: "round.manage", grantIds,
        scopeType: "round", scopeId: round._id, action: "review.panel_roster_restored", targetType: "review_panel", targetId: panel._id,
        previousSummary: JSON.stringify({ version: panel.version, memberPersonIds: history.filter(m => m.panelId === panel._id && m.status === "active").map(m => m.personId) }),
        nextSummary: JSON.stringify({ version: panel.version + 1, snapshotAt: args.snapshotAt, memberPersonIds: members.map(m => m.personId), sourceMemberIds: members.map(m => m._id) }), reason });
    }
    await recordOperation(ctx, { ...operation, targetType: "review_round", targetId: round._id, resultJson: String(version), createdAt: now });
    await writeAuditEvent(ctx, { eventId: event._id, actorPersonId: person._id, permissionKey: "round.manage", grantIds,
      scopeType: "round", scopeId: round._id, action: "review.round_start_postponed", targetType: "review_round", targetId: round._id,
      previousSummary: JSON.stringify({ startsAt: round.startsAt, reviewerReportAt: round.reviewerReportAt, version: round.version }),
      nextSummary: JSON.stringify({ startsAt: args.startsAt, reviewerReportAt: updatedRound.reviewerReportAt, version, snapshotAt: args.snapshotAt }), reason });
    return { version };
  },
});
