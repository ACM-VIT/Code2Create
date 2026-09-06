import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { writeAuditEvent } from "./lib/audit";
import { callQueuedTeam } from "./reviewOperations";
import { checkPanelStaffing } from "./reviewStaffing";
import { activeRoundPause } from "./lib/reviewRoundPauses";
import { nextQueuedTeam } from "./lib/reviewQueueProjection";
import { notifyReviewTeam } from "./lib/reviewTeamNotices";
import { defaultReviewScoringBufferSeconds, maximumReviewPanelsPerRound } from "./lib/reviewLimits";

const policyFields = {
  routingPreference: v.union(
    v.literal("skills_then_wait"),
    v.literal("shortest_wait"),
  ),
  automaticCallUp: v.boolean(),
  teamHeadsUpSeconds: v.number(),
  voiceCalls: v.boolean(),
  scoringBufferSeconds: v.number(),
};
export const settings = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.object({
    version: v.number(),
    canConfigure: v.boolean(),
    ...policyFields,
    panels: v.array(
      v.object({
        name: v.string(),
        status: v.string(),
        checkedAt: v.optional(v.number()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.read",
      scopeType: "round",
      scopeId: args.roundId,
    });
    const round = await ctx.db.get(args.roundId);
    if (!round || round.eventId !== event._id)
      throw new ConvexError({
        code: "ROUND_NOT_FOUND",
        message: "Round unavailable.",
      });
    const [policy, grants, panels] = await Promise.all([
      ctx.db
        .query("reviewQueuePolicies")
        .withIndex("by_round", (q) => q.eq("roundId", round._id))
        .unique(),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "review.configuration.publish",
        scopeType: "event",
      }),
      ctx.db
        .query("reviewPanels")
        .withIndex("by_round_status", (q) => q.eq("roundId", round._id))
        .take(maximumReviewPanelsPerRound + 1),
    ]);
    if (panels.length > maximumReviewPanelsPerRound)
      throw new Error("Panel limit exceeded.");
    return {
      version: policy?.version ?? 0,
      canConfigure:
        grants.length > 0 && ["published", "open"].includes(round.status),
      routingPreference: policy?.routingPreference ?? "skills_then_wait",
      automaticCallUp: policy?.automaticCallUp ?? false,
      teamHeadsUpSeconds: policy?.teamHeadsUpSeconds ?? 300,
      voiceCalls: policy?.voiceCalls ?? false,
      scoringBufferSeconds: policy?.scoringBufferSeconds ?? defaultReviewScoringBufferSeconds,
      panels: await Promise.all(
        panels.map(async (panel) => {
          const check = await ctx.db
            .query("reviewQueuePanelChecks")
            .withIndex("by_round_panel", (q) =>
              q.eq("roundId", round._id).eq("panelId", panel._id),
            )
            .unique();
          return {
            name: panel.name,
            status: check?.status ?? "Waiting for queue setup",
            ...(check ? { checkedAt: check.checkedAt } : {}),
          };
        }),
      ),
    };
  },
});
export const configure = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    expectedVersion: v.number(),
    ...policyFields,
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 3, 300);
    const requestFingerprint = operationFingerprint([
      args.roundId,
      args.expectedVersion,
      args.routingPreference,
      args.automaticCallUp,
      args.teamHeadsUpSeconds,
      args.voiceCalls,
      args.scoringBufferSeconds,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.configure",
      requestFingerprint,
    });
    if (prior)
      return {
        version: storedOperationVersion(prior.resultJson, "queue settings"),
      };
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
    });
    const round = await ctx.db.get(args.roundId);
    if (
      !round ||
      round.eventId !== event._id ||
      !["published", "open"].includes(round.status)
    )
      throw new ConvexError({
        code: "ROUND_NOT_AVAILABLE",
        message: "This round cannot be configured.",
      });
    const current = await ctx.db
      .query("reviewQueuePolicies")
      .withIndex("by_round", (q) => q.eq("roundId", round._id))
      .unique();
    if ((current?.version ?? 0) !== args.expectedVersion)
      throw new ConvexError({
        code: "QUEUE_POLICY_CHANGED",
        message: "Queue settings changed. Refresh before saving.",
      });
    for (const seconds of [args.teamHeadsUpSeconds, args.scoringBufferSeconds])
      if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 1800)
        throw new ConvexError({
          code: "INVALID_QUEUE_TIMING",
          message: "Queue timing must be whole seconds from 0 to 1800.",
        });
    if (args.automaticCallUp)
      await requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "review.prepare",
        scopeType: "round",
        scopeId: round._id,
      });
    if (args.voiceCalls)
      await requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "communications.delivery.manage",
        scopeType: "event",
      });
    const version = args.expectedVersion + 1;
    const now = Date.now();
    const fields = {
      routingPreference: args.routingPreference,
      automaticCallUp: args.automaticCallUp,
      teamHeadsUpSeconds: args.teamHeadsUpSeconds,
      voiceCalls: args.voiceCalls,
      scoringBufferSeconds: args.scoringBufferSeconds,
      operatorPersonId: person._id,
      version,
      updatedAt: now,
    };
    if (current) await ctx.db.patch(current._id, fields);
    else
      await ctx.db.insert("reviewQueuePolicies", {
        eventId: event._id,
        roundId: round._id,
        ...fields,
      });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.configure",
      requestFingerprint,
      targetType: "review_round",
      targetId: round._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.configuration.publish",
      grantIds,
      scopeType: "event",
      action: "review.queue_configured",
      targetType: "review_round",
      targetId: round._id,
      nextSummary: JSON.stringify(fields),
      reason,
    });
    return { version };
  },
});
async function recordPanelCheck(
  ctx: MutationCtx,
  panelId: Id<"reviewPanels">,
  status: string,
) {
  const panel = await ctx.db.get(panelId);
  if (!panel) return;
  const prior = await ctx.db
    .query("reviewQueuePanelChecks")
    .withIndex("by_round_panel", (q) =>
      q.eq("roundId", panel.roundId).eq("panelId", panel._id),
    )
    .unique();
  const fields = { status, checkedAt: Date.now() };
  if (prior) await ctx.db.patch(prior._id, fields);
  else
    await ctx.db.insert("reviewQueuePanelChecks", {
      roundId: panel.roundId,
      panelId,
      ...fields,
    });
}
export const report = internalMutation({
  args: { panelId: v.id("reviewPanels"), status: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordPanelCheck(ctx, args.panelId, args.status);
    return null;
  },
});
export const run = internalAction({
  args: { panelId: v.id("reviewPanels") },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(internal.reviewQueueAutomation.advance, args);
    } catch (error) {
      // The failed transition rolls back before its readable blocker is recorded.
      if (!(error instanceof ConvexError)) throw error;
      const data: unknown = error.data;
      const status =
        typeof data === "object" &&
        data !== null &&
        "message" in data &&
        typeof data.message === "string"
          ? data.message.slice(0, 300)
          : "Queue action needs operations attention";
      await ctx.runMutation(internal.reviewQueueAutomation.report, {
        ...args,
        status,
      });
    }
    return null;
  },
});
export const dispatch = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rounds = await ctx.db
      .query("reviewRounds")
      .withIndex("by_status_start", (q) => q.eq("status", "open"))
      .paginate({ cursor: args.cursor ?? null, numItems: 20 });
    for (const round of rounds.page) {
      const policy = await ctx.db
        .query("reviewQueuePolicies")
        .withIndex("by_round", (q) => q.eq("roundId", round._id))
        .unique();
      if (!policy?.automaticCallUp) continue;
      const panels = await ctx.db
        .query("reviewPanels")
        .withIndex("by_round_status", (q) => q.eq("roundId", round._id))
        .take(maximumReviewPanelsPerRound + 1);
      if (panels.length > maximumReviewPanelsPerRound)
        throw new Error("Panel limit exceeded.");
      for (const panel of panels)
        await ctx.scheduler.runAfter(0, internal.reviewQueueAutomation.run, {
          panelId: panel._id,
        });
    }
    if (!rounds.isDone)
      await ctx.scheduler.runAfter(0, internal.reviewQueueAutomation.dispatch, {
        cursor: rounds.continueCursor,
      });
    return null;
  },
});
export const advance = internalMutation({
  args: { panelId: v.id("reviewPanels") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await checkPanelStaffing(ctx, args);
    const panel = await ctx.db.get(args.panelId);
    if (!panel) return null;
    const [round, policy] = await Promise.all([
      ctx.db.get(panel.roundId),
      ctx.db
        .query("reviewQueuePolicies")
        .withIndex("by_round", (q) => q.eq("roundId", panel.roundId))
        .unique(),
    ]);
    const now = Date.now();
    let status = "Automatic call-up disabled";
    if (!round || !policy?.automaticCallUp) {
      await recordPanelCheck(ctx, panel._id, status);
      return null;
    }
    if (
      round.status !== "open" ||
      now < round.startsAt ||
      now >= round.endsAt ||
      (await activeRoundPause(ctx, round._id))
    ) {
      await recordPanelCheck(
        ctx,
        panel._id,
        "Round paused or outside review hours",
      );
      return null;
    }
    if (panel.status !== "ready") {
      await recordPanelCheck(ctx, panel._id, "Waiting for panel staffing");
      return null;
    }
    const operator = await requireEventSubject(
      ctx,
      round.eventId,
      policy.operatorPersonId,
    );
    await requirePermission(ctx, {
      eventId: round.eventId,
      eventAccessSubjectId: operator._id,
      permissionKey: "review.prepare",
      scopeType: "panel",
      scopeId: panel._id,
    });
    const [queued, live] = await Promise.all([
      nextQueuedTeam(ctx, panel._id),
      Promise.all(
        (["awaiting_presence", "active", "scoring"] as const).map((state) =>
          ctx.db
            .query("reviewSessions")
            .withIndex("by_panel_status", (q) =>
              q.eq("panelId", panel._id).eq("status", state),
            )
            .unique(),
        ),
      ),
    ]);
    const current = live.find((row) => row !== null);
    if (current) {
      status =
        current.status === "scoring"
          ? "Reviewers are finishing scorecards"
          : current.status === "active"
            ? "Review discussion in progress"
            : "Waiting for team and reviewer arrival";
      if (
        queued &&
        policy.teamHeadsUpSeconds > 0 &&
        current.plannedEndAt !== undefined &&
        now >= current.plannedEndAt - policy.teamHeadsUpSeconds * 1000
      )
        await notifyReviewTeam(ctx, queued, "up_next", now);
    } else if (queued) {
      const event = await ctx.db.get(round.eventId);
      if (!event) throw new Error("Review event missing.");
      await callQueuedTeam(
        ctx,
        {
          eventSlug: event.slug,
          roundId: round._id,
          panelId: panel._id,
          teamId: queued.teamId,
          expectedTeamRoundVersion: queued.version,
          reason: "Automatic next-team call-up",
          clientOperationId: `auto-call:${queued._id}:${queued.version}`,
        },
        policy.operatorPersonId,
      );
      status = "Next team called";
    } else status = "Queue empty";
    await recordPanelCheck(ctx, panel._id, status);
    return null;
  },
});
