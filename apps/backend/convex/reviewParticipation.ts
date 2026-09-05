import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation, storedOperationVersion } from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { cancelPendingReview } from "./lib/reviewCancellation";
import { maximumApplicantTeamsPerEvent, maximumReviewRoundsPerEvent } from "./lib/reviewLimits";
import { insertTeamRoundState, patchTeamRoundState } from "./lib/reviewQueueProjection";
import { normalizedText } from "./lib/strings";

const category = v.union(v.literal("competitor"), v.literal("oc"));

export const teams = query({
  args: { eventSlug: v.string() },
  returns: v.array(v.object({
    id: v.id("teams"), name: v.string(), status: v.string(), version: v.number(),
    category, memberCount: v.number(), canManage: v.boolean(),
  })),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id, eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.read", scopeType: "event",
    });
    const grantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id, eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish", scopeType: "event",
    });
    const page = await ctx.db.query("teams")
      .withIndex("by_event_name", q => q.eq("eventId", event._id))
      .filter(q => q.or(
        q.eq(q.field("competitionCategory"), "oc"),
        q.eq(q.field("status"), "admitted"), q.eq(q.field("status"), "confirmed"),
        q.eq(q.field("status"), "checked_in"), q.eq(q.field("status"), "active"),
      ))
      .take(maximumApplicantTeamsPerEvent + 1);
    if (page.length > maximumApplicantTeamsPerEvent) throw new Error("Applicant team limit exceeded.");
    return page.map(team => ({
      id: team._id, name: team.name, status: team.status, version: team.version,
      category: team.competitionCategory ?? ("competitor" as const), memberCount: team.activeMemberCount,
      canManage: grantIds.length > 0,
    }));
  },
});

async function skipPendingReview(ctx: MutationCtx, args: {
  round: Doc<"reviewRounds">; team: Doc<"teams">; state: Doc<"teamRoundStates"> | null;
  actorPersonId: Id<"people">; reason: string; now: number;
}) {
  const { round, team, state, actorPersonId, reason, now } = args;
  if (state && ["in_review", "completed", "withdrawn"].includes(state.state)) {
    throw new ConvexError({ code: "REVIEW_ALREADY_STARTED", message: "Skip a review before discussion starts. A completed or withdrawn review cannot be skipped." });
  }
  await cancelPendingReview(ctx, {
    eventId: round.eventId, roundId: round._id, teamId: team._id, actorPersonId, reason, now,
  });
  const version = (state?.version ?? 0) + 1;
  const fields = {
    state: "skipped" as const, skipReason: reason,
    callAttemptCount: 0,
    version, updatedByPersonId: actorPersonId, updatedAt: now,
  };
  if (state) {
    await patchTeamRoundState(ctx, state, {
      ...fields, panelId: undefined, queuedAt: undefined, calledAt: undefined,
      holdReason: undefined, stateBeforeHold: undefined, heldAt: undefined, missedAt: undefined, lastCallAttemptAt: undefined,
    });
  } else {
    await insertTeamRoundState(ctx, {
      eventId: round.eventId, roundId: round._id, teamId: team._id, priority: 0, ...fields,
    });
  }
  return version;
}

export const setCategory = mutation({
  args: {
    eventSlug: v.string(), teamId: v.id("teams"), category, expectedVersion: v.number(),
    reason: v.string(), clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id, eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish", scopeType: "event",
    });
    const reason = normalizedText(args.reason, "Reason", 5, 500);
    const requestFingerprint = operationFingerprint([args.teamId, args.category, args.expectedVersion, reason]);
    const operation = {
      eventId: event._id, actorPersonId: person._id, clientOperationId: args.clientOperationId,
      commandName: "review.team.category", requestFingerprint,
    };
    const prior = await findOperation(ctx, operation);
    if (prior) return { version: storedOperationVersion(prior.resultJson, "team category") };
    const team = await ctx.db.get(args.teamId);
    if (!team || team.eventId !== event._id) throw new ConvexError({ code: "TEAM_NOT_FOUND", message: "Team not found in this event." });
    if (team.version !== args.expectedVersion) throw new ConvexError({ code: "TEAM_CHANGED", message: "The team changed. Refresh before saving." });
    const now = Date.now();
    if (args.category === "oc" && team.competitionCategory !== "oc") {
      const rounds = await ctx.db.query("reviewRounds")
        .withIndex("by_event_status_start", q => q.eq("eventId", event._id))
        .take(maximumReviewRoundsPerEvent + 1);
      if (rounds.length > maximumReviewRoundsPerEvent) throw new Error("Review round limit exceeded.");
      for (const round of rounds) {
        const state = await ctx.db.query("teamRoundStates")
          .withIndex("by_round_team", q => q.eq("roundId", round._id).eq("teamId", team._id)).unique();
        if (!state || state.state === "skipped" || state.state === "withdrawn") continue;
        if (round.status === "closing" || round.status === "closed") throw new ConvexError({ code: "ROUND_CLOSED", message: "This team has a closed review. Resolve its result before changing competition eligibility." });
        await skipPendingReview(ctx, { round, team, state, actorPersonId: person._id, reason: `OC team: ${reason}`, now });
      }
    }
    const version = team.version + 1;
    await ctx.db.patch(team._id, { competitionCategory: args.category === "oc" ? "oc" : undefined, version, updatedAt: now });
    await recordOperation(ctx, { ...operation, targetType: "team", targetId: team._id, resultJson: String(version), createdAt: now });
    await writeAuditEvent(ctx, {
      eventId: event._id, actorPersonId: person._id, permissionKey: "review.configuration.publish", grantIds,
      scopeType: "event", action: "review.team_category_changed", targetType: "team", targetId: team._id,
      previousSummary: JSON.stringify({ category: team.competitionCategory ?? "competitor", version: team.version }),
      nextSummary: JSON.stringify({ category: args.category, version }), reason,
    });
    return { version };
  },
});

export const setSkipped = mutation({
  args: {
    eventSlug: v.string(), roundId: v.id("reviewRounds"), teamId: v.id("teams"),
    skipped: v.boolean(), expectedVersion: v.number(), reason: v.string(), clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id, eventAccessSubjectId: subject._id, permissionKey: "round.manage", scopeType: "round", scopeId: args.roundId,
    });
    const reason = normalizedText(args.reason, "Reason", 5, 500);
    const requestFingerprint = operationFingerprint([args.roundId, args.teamId, args.skipped, args.expectedVersion, reason]);
    const operation = {
      eventId: event._id, actorPersonId: person._id, clientOperationId: args.clientOperationId,
      commandName: "review.team.skip", requestFingerprint,
    };
    const prior = await findOperation(ctx, operation);
    if (prior) return { version: storedOperationVersion(prior.resultJson, "review skip") };
    const [round, team, state] = await Promise.all([
      ctx.db.get(args.roundId), ctx.db.get(args.teamId),
      ctx.db.query("teamRoundStates").withIndex("by_round_team", q => q.eq("roundId", args.roundId).eq("teamId", args.teamId)).unique(),
    ]);
    if (!round || !team || round.eventId !== event._id || team.eventId !== event._id) throw new ConvexError({ code: "TEAM_NOT_FOUND", message: "Team or round not found in this event." });
    if (!["published", "open"].includes(round.status)) throw new ConvexError({ code: "ROUND_NOT_OPEN", message: "Reviews can be skipped or restored while the round is published or open." });
    if ((state?.version ?? 0) !== args.expectedVersion) throw new ConvexError({ code: "QUEUE_STATE_CHANGED", message: "The review changed. Refresh before saving." });
    const now = Date.now();
    let version: number;
    if (args.skipped) {
      version = await skipPendingReview(ctx, { round, team, state, actorPersonId: person._id, reason, now });
    } else {
      if (!state || state.state !== "skipped" || team.competitionCategory === "oc") throw new ConvexError({ code: "REVIEW_NOT_RESTORABLE", message: "Only a skipped competitor can return to the review desk. Change OC eligibility first if needed." });
      version = state.version + 1;
      await patchTeamRoundState(ctx, state, { state: "unassigned", skipReason: undefined, version, updatedByPersonId: person._id, updatedAt: now });
    }
    await recordOperation(ctx, { ...operation, targetType: "team", targetId: team._id, resultJson: String(version), createdAt: now });
    await writeAuditEvent(ctx, {
      eventId: event._id, actorPersonId: person._id, permissionKey: "round.manage", grantIds, scopeType: "round", scopeId: round._id,
      action: args.skipped ? "review.team_skipped" : "review.team_restored", targetType: "team", targetId: team._id,
      previousSummary: JSON.stringify({ state: state?.state ?? "unassigned", version: state?.version ?? 0 }),
      nextSummary: JSON.stringify({ state: args.skipped ? "skipped" : "unassigned", version }), reason,
    });
    return { version };
  },
});
