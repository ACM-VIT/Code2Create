import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { maximumReviewRoundsPerEvent } from "./reviewLimits";

type Context = QueryCtx | MutationCtx;

export async function isProgressionPublished(
  ctx: Context,
  round: Doc<"reviewRounds">,
  policy: Doc<"reviewProgressions"> | null,
) {
  if (
    !policy?.closeSnapshotId ||
    round.status !== "closed" ||
    policy.closeSnapshotId !== round.activeCloseSnapshotId
  ) return false;
  if (!policy.scoreReference) return true;

  const aggregation = await ctx.db
    .query("reviewAggregationPolicies")
    .withIndex("by_event_status", (q) =>
      q.eq("eventId", round.eventId).eq("status", "published"),
    )
    .unique();
  if (aggregation?.version !== policy.scoreReference.policyVersion) return false;
  for (const ref of policy.scoreReference.rounds) {
    const source = await ctx.db.get(ref.roundId);
    if (
      !source ||
      source.status !== "closed" ||
      source.activeCloseSnapshotId !== ref.closeSnapshotId
    ) return false;
  }
  return true;
}

export async function earlierEliminationRounds(
  ctx: Context,
  round: Doc<"reviewRounds">,
) {
  const policies = await ctx.db
    .query("reviewProgressions")
    .withIndex("by_event_round", (q) => q.eq("eventId", round.eventId))
    .take(maximumReviewRoundsPerEvent + 1);
  if (policies.length > maximumReviewRoundsPerEvent)
    throw new Error("Review round limit exceeded.");
  const result = [];
  for (const policy of policies) {
    if (policy.mode !== "elimination") continue;
    const source = await ctx.db.get(policy.roundId);
    if (!source || source.eventId !== round.eventId)
      throw new Error("Progression round unavailable.");
    if (source.sequence < round.sequence)
      result.push({ policy, round: source });
  }
  return result.sort((a, b) => a.round.sequence - b.round.sequence);
}

export async function reviewProgressionBlocker(
  ctx: Context,
  round: Doc<"reviewRounds">,
  teamId: Id<"teams">,
) {
  for (const { policy, round: source } of await earlierEliminationRounds(
    ctx,
    round,
  )) {
    if (!(await isProgressionPublished(ctx, source, policy))) {
      return `Finish ${source.name} and publish its progression decisions first.`;
    }
    const decision = await ctx.db
      .query("reviewProgressionEntries")
      .withIndex("by_progression_team", (q) =>
        q.eq("progressionId", policy._id).eq("teamId", teamId),
      )
      .unique();
    if (!decision || decision.outcome !== "advance")
      return `This team has not advanced from ${source.name}.`;
  }
  return null;
}

export async function requireReviewProgression(
  ctx: Context,
  round: Doc<"reviewRounds">,
  teamId: Id<"teams">,
) {
  const message = await reviewProgressionBlocker(ctx, round, teamId);
  if (message) throw new ConvexError({ code: "TEAM_NOT_ADVANCED", message });
}

export async function requireProgressionEditable(
  ctx: Context,
  round: Doc<"reviewRounds">,
) {
  const rounds = await ctx.db
    .query("reviewRounds")
    .withIndex("by_event_status_start", (q) => q.eq("eventId", round.eventId))
    .take(maximumReviewRoundsPerEvent + 1);
  if (rounds.length > maximumReviewRoundsPerEvent)
    throw new Error("Review round limit exceeded.");
  for (const later of rounds.filter((r) => r.sequence > round.sequence)) {
    const state = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_state_priority_queued", (q) =>
        q.eq("roundId", later._id),
      )
      .filter((q) =>
        q.and(
          q.neq(q.field("state"), "unassigned"),
          q.neq(q.field("state"), "skipped"),
        ),
      )
      .first();
    const session = await ctx.db
      .query("reviewSessions")
      .withIndex("by_round_status_updated", (q) => q.eq("roundId", later._id))
      .first();
    if (["closing", "closed"].includes(later.status) || state || session) {
      throw new ConvexError({
        code: "NEXT_ROUND_STARTED",
        message: `${later.name} already has activity. Resolve it before changing who advances.`,
      });
    }
  }
}
