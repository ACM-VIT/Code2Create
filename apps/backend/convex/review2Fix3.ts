import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { patchTeamRoundState } from "./lib/reviewQueueProjection";

/** One-off Review 2 adjustments on 2026-09-08 (scale, fixed questions, queue balance); delete after use. */

async function requireActor(ctx: MutationCtx, eventId: Id<"events">, email: string) {
  const subject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_email", (q) => q.eq("eventId", eventId).eq("emailNormalized", email))
    .first();
  if (!subject) throw new Error(`No event subject for ${email}.`);
  return subject.personId;
}

/** Moves a round's rubric to a new score range; refuses once any scorecard exists for it. */
export const setScale = internalMutation({
  args: { roundId: v.id("reviewRounds"), minimum: v.number(), maximum: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const rubric = await ctx.db.get(round.rubricVersionId);
    if (!rubric) throw new Error("The rubric is missing.");
    const session = await ctx.db
      .query("reviewSessions")
      .withIndex("by_round_status_updated", (q) => q.eq("roundId", round._id))
      .first();
    if (session) throw new Error("Scores may already exist for this round; the scale stays as it is.");
    if (!Number.isInteger(args.minimum) || !Number.isInteger(args.maximum) || args.minimum >= args.maximum) {
      throw new Error("Choose whole-number bounds with the minimum below the maximum.");
    }
    const previous = { minimum: rubric.scoreMinimum, maximum: rubric.scoreMaximum };
    await ctx.db.patch(rubric._id, { scoreMinimum: args.minimum, scoreMaximum: args.maximum });
    return { rubric: rubric.name, previous, now: { minimum: args.minimum, maximum: args.maximum } };
  },
});

/** Turns off generated questions for a round so every session gets the fixed rubric questions. */
export const disableGeneratedQuestions = internalMutation({
  args: { roundId: v.id("reviewRounds") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("reviewQuestionPolicies")
      .withIndex("by_round", (q) => q.eq("roundId", args.roundId))
      .unique();
    if (!config) return { changed: false, reason: "no policy row; generation was already off" };
    if (!config.policy.enabled) return { changed: false, reason: "already off" };
    await ctx.db.patch(config._id, {
      policy: { ...config.policy, enabled: false },
      version: config.version + 1,
      updatedAt: Date.now(),
    });
    return { changed: true, version: config.version + 1 };
  },
});

/** Evens out queued teams across a round's panels, moving from the back of the longer queues. */
export const rebalanceQueue = internalMutation({
  args: { roundId: v.id("reviewRounds"), actorEmail: v.string(), dryRun: v.boolean() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const actorPersonId = await requireActor(ctx, round.eventId, args.actorEmail);
    const panels = (
      await ctx.db
        .query("reviewPanels")
        .filter((q) => q.eq(q.field("roundId"), round._id))
        .collect()
    )
      .filter((panel) => panel.status !== "closed")
      .sort((a, b) => a.stableKey.localeCompare(b.stableKey, undefined, { numeric: true }));
    const queued = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_state_priority_queued", (q) => q.eq("roundId", round._id).eq("state", "queued"))
      .collect();
    const byPanel = new Map(panels.map((panel) => [panel._id, queued.filter((s) => s.panelId === panel._id).sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))]));
    const total = queued.length;
    const base = Math.floor(total / panels.length);
    const extra = total % panels.length;
    const target = new Map(panels.map((panel, index) => [panel._id, base + (index < extra ? 1 : 0)]));
    const moves: { team: Id<"teams">; from: string; to: string }[] = [];
    const donors = panels.filter((panel) => (byPanel.get(panel._id)?.length ?? 0) > (target.get(panel._id) ?? 0));
    const receivers = panels.filter((panel) => (byPanel.get(panel._id)?.length ?? 0) < (target.get(panel._id) ?? 0));
    let sequence = 0;
    for (const receiver of receivers) {
      while ((byPanel.get(receiver._id)?.length ?? 0) < (target.get(receiver._id) ?? 0)) {
        const donor = donors.find((panel) => (byPanel.get(panel._id)?.length ?? 0) > (target.get(panel._id) ?? 0));
        if (!donor) break;
        const state = byPanel.get(donor._id)?.pop();
        if (!state) break;
        byPanel.get(receiver._id)?.push(state);
        moves.push({ team: state.teamId, from: donor.name, to: receiver.name });
        if (!args.dryRun) {
          await patchTeamRoundState(ctx, state, {
            panelId: receiver._id,
            queuedAt: now + sequence,
            movedFromPanelId: donor._id,
            lastMovedAt: now,
            version: state.version + 1,
            updatedByPersonId: actorPersonId,
            updatedAt: now,
          });
        }
        sequence += 1;
      }
    }
    return {
      applied: !args.dryRun,
      total,
      moves: moves.length,
      perPanel: Object.fromEntries(panels.map((panel) => [panel.name, byPanel.get(panel._id)?.length ?? 0])),
    };
  },
});

/**
 * A round that ran outside the system cannot publish elimination decisions
 * (there is no close snapshot). Marking it all-advance lifts it out of the
 * later round's progression gate; the desk's queue already decides who is reviewed.
 */
export const allAdvanceProgression = internalMutation({
  args: { roundId: v.id("reviewRounds"), reason: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const policy = await ctx.db
      .query("reviewProgressions")
      .withIndex("by_event_round", (q) => q.eq("eventId", round.eventId).eq("roundId", round._id))
      .unique();
    if (!policy) throw new Error("The round has no progression policy.");
    if (policy.mode === "all_advance") return { changed: false, mode: policy.mode };
    await ctx.db.patch(policy._id, {
      mode: "all_advance",
      version: policy.version + 1,
      updatedAt: Date.now(),
      reason: args.reason,
    });
    return { changed: true, previous: policy.mode, version: policy.version + 1 };
  },
});

