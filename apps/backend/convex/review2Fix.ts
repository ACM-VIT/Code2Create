import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { appendReviewPanelVacancyReadFactById } from "./lib/operationsAutonomyReadFacts";
import { patchTeamRoundState } from "./lib/reviewQueueProjection";

/** One-off corrections after the 2026-09-08 Review 2 seeding; delete after use. */

async function requireActor(ctx: MutationCtx, eventId: Id<"events">, email: string) {
  const subject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_email", (q) => q.eq("eventId", eventId).eq("emailNormalized", email))
    .first();
  if (!subject) throw new Error(`No event subject for ${email}.`);
  return subject.personId;
}

/**
 * Seats vacated by the seeding were marked removed, which the desk reads as an
 * open seat. They were refilled, so they become replaced; one removed row stays
 * on the panel that really is a reviewer short so the desk can page into it.
 */
export const resolveStaleVacancies = internalMutation({
  args: { roundId: v.id("reviewRounds"), shortPanelStableKey: v.string(), dryRun: v.boolean() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const members = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_round_person_status", (q) => q.eq("roundId", args.roundId))
      .collect();
    const active = new Set(members.filter((m) => m.status === "active").map((m) => m.personId));
    const removed = members.filter((m) => m.status === "removed");
    const panels = await ctx.db
      .query("reviewPanels")
      .filter((q) => q.eq(q.field("roundId"), args.roundId))
      .collect();
    const shortPanel = panels.find((panel) => panel.stableKey === args.shortPanelStableKey);
    if (!shortPanel) throw new Error("The short panel does not exist.");
    const keeper = removed
      .filter((m) => m.panelId === shortPanel._id && !active.has(m.personId))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
    const toReplace = removed.filter((m) => m._id !== keeper?._id);
    if (!args.dryRun) {
      for (const member of toReplace) await ctx.db.patch(member._id, { status: "replaced" });
      for (const panel of panels) await appendReviewPanelVacancyReadFactById(ctx, panel._id, now);
    }
    return {
      applied: !args.dryRun,
      replaced: toReplace.length,
      keptOpenSeat: keeper ? { panel: shortPanel.name, memberId: keeper._id } : null,
      activeByPanel: Object.fromEntries(
        panels.map((panel) => [panel.name, members.filter((m) => m.status === "active" && m.panelId === panel._id).length]),
      ),
    };
  },
});

/** Teams that withdrew or never confirmed leave the queue with the matching state. */
export const dequeueTeams = internalMutation({
  args: {
    roundId: v.id("reviewRounds"),
    actorEmail: v.string(),
    teamCodes: v.array(v.string()),
    dryRun: v.boolean(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const actorPersonId = await requireActor(ctx, round.eventId, args.actorEmail);
    const result: { code: string; team: string; from: string; to: string }[] = [];
    const missing: string[] = [];
    for (const raw of args.teamCodes) {
      const code = raw.trim().toUpperCase();
      const team = await ctx.db
        .query("teams")
        .withIndex("by_event_code", (q) => q.eq("eventId", round.eventId).eq("publicCode", code))
        .unique();
      const state = team
        ? await ctx.db
            .query("teamRoundStates")
            .withIndex("by_round_team", (q) => q.eq("roundId", round._id).eq("teamId", team._id))
            .unique()
        : null;
      if (!team || !state || state.state !== "queued") {
        missing.push(code);
        continue;
      }
      const to = team.status === "withdrawn" ? ("withdrawn" as const) : ("skipped" as const);
      if (!args.dryRun) {
        await patchTeamRoundState(ctx, state, {
          state: to,
          ...(to === "skipped" ? { skipReason: "Not confirmed for Review 2" } : {}),
          panelId: undefined,
          queuedAt: undefined,
          calledAt: undefined,
          callAttemptCount: 0,
          lastCallAttemptAt: undefined,
          holdReason: undefined,
          stateBeforeHold: undefined,
          heldAt: undefined,
          missedAt: undefined,
          version: state.version + 1,
          updatedByPersonId: actorPersonId,
          updatedAt: now,
        });
      }
      result.push({ code, team: team.name, from: state.state, to });
    }
    return { applied: !args.dryRun, changed: result.length, result, missing };
  },
});
