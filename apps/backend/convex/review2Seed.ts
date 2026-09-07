import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { advanceAccessVersion } from "./lib/accessVersion";
import { appendReviewPanelVacancyReadFactById } from "./lib/operationsAutonomyReadFacts";
import { revokeSourceGrants } from "./lib/permissions";
import { grantPanelMemberAccess } from "./lib/reviewAccess";
import { insertTeamRoundState } from "./lib/reviewQueueProjection";
import { ensureRoundConfirmation, putInRoundReserve } from "./lib/reviewRoster";

/**
 * One-off desk seeding for Review 2 on 2026-09-08 from the final panel sheet.
 * Delete this module once the round has been seeded.
 */

const seatInput = v.object({ personId: v.id("people"), isCoordinator: v.boolean() });

async function requireRound(ctx: MutationCtx, roundId: Id<"reviewRounds">) {
  const round = await ctx.db.get(roundId);
  if (!round) throw new Error("The round does not exist.");
  const event = await ctx.db.get(round.eventId);
  if (!event) throw new Error("The round's event does not exist.");
  return { round, event };
}

async function requireActor(ctx: MutationCtx, eventId: Id<"events">, email: string) {
  const subject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_email", (q) => q.eq("eventId", eventId).eq("emailNormalized", email))
    .first();
  if (!subject) throw new Error(`No event subject for ${email}.`);
  return subject.personId;
}

export const seedPanels = internalMutation({
  args: {
    roundId: v.id("reviewRounds"),
    actorEmail: v.string(),
    panels: v.array(
      v.object({ stableKey: v.string(), name: v.string(), members: v.array(seatInput) }),
    ),
    dryRun: v.boolean(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const { round, event } = await requireRound(ctx, args.roundId);
    const actorPersonId = await requireActor(ctx, event._id, args.actorEmail);
    const criteria = await ctx.db
      .query("reviewRubricCriteria")
      .filter((q) => q.eq(q.field("rubricVersionId"), round.rubricVersionId))
      .collect();
    if (criteria.length === 0) throw new Error("The round has no rubric criteria.");
    const criterionIds = criteria.map((criterion) => criterion._id);

    const wanted = args.panels.flatMap((panel) => panel.members.map((member) => member.personId));
    if (new Set(wanted).size !== wanted.length) throw new Error("A person is seated twice.");
    for (const panel of args.panels) {
      if (panel.members.filter((member) => member.isCoordinator).length !== 1) {
        throw new Error(`${panel.name} needs exactly one coordinator.`);
      }
    }

    const problems: string[] = [];
    const contexts = new Map<
      Id<"people">,
      { subject: Doc<"eventAccessSubjects">; profile: Doc<"reviewerProfiles"> | null }
    >();
    for (const personId of wanted) {
      const [subject, profile] = await Promise.all([
        ctx.db
          .query("eventAccessSubjects")
          .withIndex("by_event_person", (q) => q.eq("eventId", event._id).eq("personId", personId))
          .unique(),
        ctx.db
          .query("reviewerProfiles")
          .withIndex("by_event_person", (q) => q.eq("eventId", event._id).eq("personId", personId))
          .unique(),
      ]);
      if (!subject || subject.status !== "active") {
        problems.push(`${personId}: no active event subject`);
        continue;
      }
      if (profile && profile.status !== "active") problems.push(`${subject.displayName}: inactive profile (seating anyway)`);
      contexts.set(personId, { subject, profile });
    }

    const existingPanels = (
      await ctx.db
        .query("reviewPanels")
        .filter((q) => q.eq(q.field("roundId"), round._id))
        .collect()
    ).sort((left, right) => left.stableKey.localeCompare(right.stableKey, undefined, { numeric: true }));
    const existingMembers = (
      await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_round_person_status", (q) => q.eq("roundId", round._id))
        .collect()
    ).filter((member) => member.status === "active");
    const reserves = await ctx.db
      .query("reviewRoundReserves")
      .withIndex("by_round_person", (q) => q.eq("roundId", round._id))
      .take(600);

    const plan = {
      roundName: round.name,
      criteria: criterionIds.length,
      existingPanels: existingPanels.map((panel) => panel.name),
      vacating: existingMembers.length,
      seating: wanted.length,
      reservesBecomingSeats: reserves.filter(
        (reserve) => wanted.includes(reserve.personId) && ["available", "paged"].includes(reserve.status),
      ).length,
      formerSeatsBecomingReserves: existingMembers.filter((member) => !wanted.includes(member.personId)).length,
      profilesToCreate: [...contexts.values()].filter((context) => context.profile === null).map((c) => c.subject.displayName),
      problems,
    };
    if (args.dryRun || problems.some((problem) => problem.includes("no active event subject"))) {
      return { applied: false, plan };
    }

    // 1. Vacate every current seat; the sheet is authoritative.
    const touchedSubjects = new Set<Id<"eventAccessSubjects">>();
    for (const member of existingMembers) {
      await ctx.db.patch(member._id, { status: "removed", endedAt: now });
      await revokeSourceGrants(ctx, {
        eventId: event._id,
        sourceType: "panel_assignment",
        sourceId: member._id,
        revokedByPersonId: actorPersonId,
        reason: "Seat vacated when Review 2 panels were seeded from the final sheet",
      });
      touchedSubjects.add(member.eventAccessSubjectId);
    }

    // 2. Panels: reuse existing rows in key order, then create the rest.
    const panelIds: Id<"reviewPanels">[] = [];
    for (const [index, spec] of args.panels.entries()) {
      const coordinator = spec.members.find((member) => member.isCoordinator);
      if (!coordinator) throw new Error("Validated coordinator is missing.");
      const existing = existingPanels[index];
      if (existing) {
        await ctx.db.patch(existing._id, {
          name: spec.name,
          coordinatorPersonId: coordinator.personId,
          status: "ready",
          version: existing.version + 1,
          updatedAt: now,
        });
        panelIds.push(existing._id);
      } else {
        panelIds.push(
          await ctx.db.insert("reviewPanels", {
            eventId: event._id,
            roundId: round._id,
            stableKey: spec.stableKey,
            name: spec.name,
            coordinatorPersonId: coordinator.personId,
            status: "ready",
            version: 1,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
    }

    // 3. Seat everyone with the full criterion set and the panel grants.
    let profilesCreated = 0;
    for (const [index, spec] of args.panels.entries()) {
      const panelId = panelIds[index];
      if (!panelId) throw new Error("Panel id is missing.");
      for (const member of spec.members) {
        const context = contexts.get(member.personId);
        if (!context) throw new Error("Validated reviewer context is missing.");
        let seniority = context.profile?.seniority;
        if (!context.profile) {
          await ctx.db.insert("reviewerProfiles", {
            eventId: event._id,
            personId: member.personId,
            seniority: "board",
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
          seniority = "board";
          profilesCreated += 1;
        }
        const panelMemberId = await ctx.db.insert("reviewPanelMembers", {
          eventId: event._id,
          roundId: round._id,
          panelId,
          personId: member.personId,
          eventAccessSubjectId: context.subject._id,
          assignedCriterionIds: criterionIds,
          isCoordinator: member.isCoordinator,
          status: "active",
          assignedAt: now,
          seatSeniority: member.isCoordinator ? "lead" : seniority === "jc" ? "jc" : "sc",
        });
        await grantPanelMemberAccess(ctx, {
          eventId: event._id,
          roundId: round._id,
          panelId,
          panelMemberId,
          reviewerPersonId: member.personId,
          eventAccessSubjectId: context.subject._id,
          grantedByPersonId: actorPersonId,
          isCoordinator: member.isCoordinator,
          reason: "Review 2 panel seeded from the final panel sheet",
        });
        touchedSubjects.add(context.subject._id);

        const reserve = reserves.find((row) => row.personId === member.personId);
        if (reserve && ["available", "paged"].includes(reserve.status)) {
          await ctx.db.patch(reserve._id, {
            status: "assigned",
            version: reserve.version + 1,
            updatedAt: now,
          });
        }

        await ensureRoundConfirmation(ctx, round, member.personId, now);
        const confirmation = await ctx.db
          .query("reviewerRoundConfirmations")
          .withIndex("by_roundId_and_personId", (q) =>
            q.eq("roundId", round._id).eq("personId", member.personId),
          )
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
      }
      await appendReviewPanelVacancyReadFactById(ctx, panelId, now);
    }

    // 4. Former seat holders who are not on the sheet stay available as reserves.
    let becameReserve = 0;
    for (const member of existingMembers) {
      if (wanted.includes(member.personId)) continue;
      const reserve = reserves.find((row) => row.personId === member.personId);
      if (reserve && ["available", "paged"].includes(reserve.status)) continue;
      await putInRoundReserve(ctx, {
        round,
        personId: member.personId,
        subjectId: member.eventAccessSubjectId,
        actorId: actorPersonId,
        reason: "Moved to reserves when Review 2 panels were seeded from the final sheet",
        now,
      });
      becameReserve += 1;
    }

    for (const subjectId of touchedSubjects) await advanceAccessVersion(ctx, subjectId, now);
    return { applied: true, plan, profilesCreated, becameReserve, panelIds };
  },
});

export const seedQueue = internalMutation({
  args: {
    roundId: v.id("reviewRounds"),
    actorEmail: v.string(),
    teamCodes: v.array(v.string()),
    excludeCodes: v.array(v.string()),
    dryRun: v.boolean(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const { round, event } = await requireRound(ctx, args.roundId);
    const actorPersonId = await requireActor(ctx, event._id, args.actorEmail);
    const panels = (
      await ctx.db
        .query("reviewPanels")
        .filter((q) => q.eq(q.field("roundId"), round._id))
        .collect()
    )
      .filter((panel) => panel.status !== "closed")
      .sort((left, right) => left.stableKey.localeCompare(right.stableKey, undefined, { numeric: true }));
    if (panels.length === 0) throw new Error("The round has no panels to queue teams on.");
    const excluded = new Set(args.excludeCodes.map((code) => code.trim().toUpperCase()));
    const unknown: string[] = [];
    const skipped: string[] = [];
    const alreadyQueued: string[] = [];
    const queued: { code: string; panel: string }[] = [];
    let index = 0;
    for (const raw of args.teamCodes) {
      const code = raw.trim().toUpperCase();
      if (excluded.has(code)) {
        skipped.push(code);
        continue;
      }
      const team = await ctx.db
        .query("teams")
        .withIndex("by_event_code", (q) => q.eq("eventId", event._id).eq("publicCode", code))
        .unique();
      if (!team) {
        unknown.push(code);
        continue;
      }
      const state = await ctx.db
        .query("teamRoundStates")
        .withIndex("by_round_team", (q) => q.eq("roundId", round._id).eq("teamId", team._id))
        .unique();
      if (state) {
        alreadyQueued.push(code);
        continue;
      }
      const panel = panels[index % panels.length];
      if (!panel) throw new Error("Panel rotation is empty.");
      if (!args.dryRun) {
        await insertTeamRoundState(ctx, {
          eventId: event._id,
          roundId: round._id,
          teamId: team._id,
          panelId: panel._id,
          state: "queued",
          queuedAt: now + index,
          callAttemptCount: 0,
          priority: 0,
          version: 1,
          updatedByPersonId: actorPersonId,
          updatedAt: now,
        });
      }
      queued.push({ code, panel: panel.name });
      index += 1;
    }
    return {
      applied: !args.dryRun,
      panels: panels.map((panel) => panel.name),
      queued: queued.length,
      perPanel: Object.fromEntries(panels.map((panel) => [panel.name, queued.filter((q) => q.panel === panel.name).length])),
      skipped,
      unknown,
      alreadyQueued,
    };
  },
});
