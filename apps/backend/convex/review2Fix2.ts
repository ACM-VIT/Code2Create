import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { advanceAccessVersion } from "./lib/accessVersion";
import { writeAuditEvent } from "./lib/audit";
import { appendReviewPanelVacancyReadFactById } from "./lib/operationsAutonomyReadFacts";
import { revokeSourceGrants } from "./lib/permissions";
import { grantPanelMemberAccess } from "./lib/reviewAccess";
import { ensureRoundConfirmation } from "./lib/reviewRoster";

/** One-off desk corrections during Review 2 on 2026-09-08; delete after use. */

async function requireActor(ctx: MutationCtx, eventId: Id<"events">, email: string) {
  const subject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_email", (q) => q.eq("eventId", eventId).eq("emailNormalized", email))
    .first();
  if (!subject) throw new Error(`No event subject for ${email}.`);
  return subject.personId;
}

/** A round that never opened still counts as current for reviewer phones; close it. */
export const closeRound = internalMutation({
  args: { roundId: v.id("reviewRounds"), actorEmail: v.string(), reason: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    if (round.status === "closed") return { status: "closed", unchanged: true };
    const session = await ctx.db
      .query("reviewSessions")
      .withIndex("by_round_status_updated", (q) => q.eq("roundId", round._id))
      .first();
    if (session) throw new Error("This round has review sessions; close it through exports.");
    const actorPersonId = await requireActor(ctx, round.eventId, args.actorEmail);
    await ctx.db.patch(round._id, { status: "closed", version: round.version + 1 });
    await writeAuditEvent(ctx, {
      eventId: round.eventId,
      actorPersonId,
      permissionKey: "round.manage",
      grantIds: [],
      scopeType: "round",
      scopeId: round._id,
      action: "review.round_closed",
      targetType: "review_round",
      targetId: round._id,
      previousSummary: JSON.stringify({ status: round.status, version: round.version }),
      nextSummary: JSON.stringify({ status: "closed", version: round.version + 1 }),
      reason: args.reason,
    });
    return { status: "closed", previous: round.status, version: round.version + 1 };
  },
});

/** Seats one person into a panel's open seat, optionally taking over as coordinator. */
export const seatReviewer = internalMutation({
  args: {
    roundId: v.id("reviewRounds"),
    panelStableKey: v.string(),
    personId: v.id("people"),
    vacancyMemberId: v.optional(v.id("reviewPanelMembers")),
    asCoordinator: v.boolean(),
    actorEmail: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const actorPersonId = await requireActor(ctx, round.eventId, args.actorEmail);
    const panel = (
      await ctx.db
        .query("reviewPanels")
        .filter((q) => q.eq(q.field("roundId"), round._id))
        .collect()
    ).find((row) => row.stableKey === args.panelStableKey);
    if (!panel) throw new Error("The panel does not exist.");
    const subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) => q.eq("eventId", round.eventId).eq("personId", args.personId))
      .unique();
    if (!subject || subject.status !== "active") throw new Error("The person has no active event subject.");
    const already = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_round_person_status", (q) =>
        q.eq("roundId", round._id).eq("personId", args.personId).eq("status", "active"),
      )
      .first();
    if (already) throw new Error("The person already holds a seat in this round.");
    let profile = await ctx.db
      .query("reviewerProfiles")
      .withIndex("by_event_person", (q) => q.eq("eventId", round.eventId).eq("personId", args.personId))
      .unique();
    let profileCreated = false;
    if (!profile) {
      const profileId = await ctx.db.insert("reviewerProfiles", {
        eventId: round.eventId,
        personId: args.personId,
        seniority: args.asCoordinator ? "board" : "sc",
        strength: 3,
        technicalDomains: [],
        productDomains: [],
        languages: [],
        criterionKeys: [],
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      profile = await ctx.db.get(profileId);
      profileCreated = true;
    }
    if (!profile) throw new Error("The reviewer profile is missing.");
    const criteria = await ctx.db
      .query("reviewRubricCriteria")
      .filter((q) => q.eq(q.field("rubricVersionId"), round.rubricVersionId))
      .collect();
    const touched = new Set<Id<"eventAccessSubjects">>([subject._id]);

    if (args.vacancyMemberId) {
      const vacancy = await ctx.db.get(args.vacancyMemberId);
      if (vacancy && vacancy.panelId === panel._id && vacancy.status === "removed") {
        await ctx.db.patch(vacancy._id, { status: "replaced" });
      }
    }

    let demoted: string | null = null;
    if (args.asCoordinator) {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_round_person_status", (q) => q.eq("roundId", round._id))
        .collect();
      const current = members.find(
        (m) => m.panelId === panel._id && m.status === "active" && m.isCoordinator,
      );
      if (current) {
        await ctx.db.patch(current._id, { isCoordinator: false, seatSeniority: "sc" });
        await revokeSourceGrants(ctx, {
          eventId: round.eventId,
          sourceType: "panel_assignment",
          sourceId: current._id,
          revokedByPersonId: actorPersonId,
          reason: "Coordinator seat handed to the Board member from the panel sheet",
        });
        await grantPanelMemberAccess(ctx, {
          eventId: round.eventId,
          roundId: round._id,
          panelId: panel._id,
          panelMemberId: current._id,
          reviewerPersonId: current.personId,
          eventAccessSubjectId: current.eventAccessSubjectId,
          grantedByPersonId: actorPersonId,
          isCoordinator: false,
          reason: "Panel member after coordinator handover",
        });
        touched.add(current.eventAccessSubjectId);
        demoted = current.personId;
      }
      await ctx.db.patch(panel._id, {
        coordinatorPersonId: args.personId,
        version: panel.version + 1,
        updatedAt: now,
      });
    }

    const panelMemberId = await ctx.db.insert("reviewPanelMembers", {
      eventId: round.eventId,
      roundId: round._id,
      panelId: panel._id,
      personId: args.personId,
      eventAccessSubjectId: subject._id,
      assignedCriterionIds: criteria.map((criterion) => criterion._id),
      isCoordinator: args.asCoordinator,
      status: "active",
      assignedAt: now,
      seatSeniority: args.asCoordinator ? "lead" : profile.seniority === "jc" ? "jc" : "sc",
    });
    await grantPanelMemberAccess(ctx, {
      eventId: round.eventId,
      roundId: round._id,
      panelId: panel._id,
      panelMemberId,
      reviewerPersonId: args.personId,
      eventAccessSubjectId: subject._id,
      grantedByPersonId: actorPersonId,
      isCoordinator: args.asCoordinator,
      reason: "Seated from the final panel sheet",
    });
    const reserve = await ctx.db
      .query("reviewRoundReserves")
      .withIndex("by_round_person", (q) => q.eq("roundId", round._id).eq("personId", args.personId))
      .unique();
    if (reserve && ["available", "paged"].includes(reserve.status)) {
      await ctx.db.patch(reserve._id, { status: "assigned", version: reserve.version + 1, updatedAt: now });
    }
    await ensureRoundConfirmation(ctx, round, args.personId, now);
    const confirmation = await ctx.db
      .query("reviewerRoundConfirmations")
      .withIndex("by_roundId_and_personId", (q) => q.eq("roundId", round._id).eq("personId", args.personId))
      .unique();
    if (confirmation && confirmation.status !== "confirmed") {
      await ctx.db.patch(confirmation._id, {
        status: "confirmed",
        windows: [{ startsAt: round.startsAt, endsAt: round.endsAt }],
        respondedAt: now,
        version: confirmation.version + 1,
        updatedAt: now,
      });
    }
    for (const subjectId of touched) await advanceAccessVersion(ctx, subjectId, now);
    await appendReviewPanelVacancyReadFactById(ctx, panel._id, now);
    return { panel: panel.name, panelMemberId, profileCreated, demoted, coordinator: args.asCoordinator };
  },
});
