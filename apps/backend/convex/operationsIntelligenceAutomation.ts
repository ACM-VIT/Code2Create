import type { OperationsHealthSnapshot } from "@code2create/domain";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { operationFingerprint } from "./lib/operations";
import {
  localDateKey,
  operationsIntelligencePolicyFromDocument,
} from "./lib/operationsIntelligencePolicy";
import { operationsHealthSnapshot } from "./lib/operationsIntelligenceValidators";
import { intelligenceWorkpool } from "./workpools";

const evaluationIntervalMs = 60_000;
const maximumDueStatesPerPass = 4;
const agentCompletionWindowMs = 10 * 60 * 1_000;

function isActiveBrief(state: Doc<"operationsIntelligenceBriefs">["state"]) {
  return state === "pending" || state === "dispatching" || state === "accepted";
}

function triggerFingerprint(
  policyVersionId: Doc<"operationsIntelligencePolicyVersions">["_id"],
  snapshot: OperationsHealthSnapshot,
  policy: ReturnType<typeof operationsIntelligencePolicyFromDocument>,
) {
  const signals = snapshot.signals
    .filter(
      (signal) =>
        policy.triggerSeverities.includes(signal.severity) &&
        policy.triggerAreas.includes(signal.area),
    )
    .map((signal) => ({
      key: signal.key,
      severity: signal.severity,
      count: signal.count,
      atLeast: signal.atLeast,
      oldestAt: signal.oldestAt ?? null,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    signals,
    fingerprint:
      signals.length > 0
        ? operationFingerprint([policyVersionId, JSON.stringify(signals)])
        : null,
  };
}

export const dueStates = internalQuery({
  args: { now: v.number() },
  returns: v.array(
    v.object({
      stateId: v.id("operationsIntelligenceAutomationStates"),
      version: v.number(),
      eventId: v.id("events"),
    }),
  ),
  handler: async (ctx, args) => {
    const states = await ctx.db
      .query("operationsIntelligenceAutomationStates")
      .withIndex("by_state_next_evaluation", (index) =>
        index.eq("state", "active").lte("nextEvaluationAt", args.now),
      )
      .take(maximumDueStatesPerPass);
    return states.map((state) => ({
      stateId: state._id,
      version: state.version,
      eventId: state.eventId,
    }));
  },
});

export const evaluateDue = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.runQuery(internal.operationsIntelligenceAutomation.dueStates, { now });
    for (const state of due) {
      const snapshot = await ctx.runQuery(internal.operationsHealth.internalOverview, {
        eventId: state.eventId,
      });
      await ctx.runMutation(internal.operationsIntelligenceAutomation.evaluateSnapshot, {
        stateId: state.stateId,
        expectedVersion: state.version,
        snapshot,
        now,
      });
    }
    return null;
  },
});

export const evaluateSnapshot = internalMutation({
  args: {
    stateId: v.id("operationsIntelligenceAutomationStates"),
    expectedVersion: v.number(),
    snapshot: operationsHealthSnapshot,
    now: v.number(),
  },
  returns: v.union(
    v.literal("stale"),
    v.literal("quiet"),
    v.literal("unchanged"),
    v.literal("cooldown"),
    v.literal("budget_exhausted"),
    v.literal("brief_in_progress"),
    v.literal("triggered"),
  ),
  handler: async (ctx, args) => {
    const state = await ctx.db.get(args.stateId);
    if (
      !state ||
      state.state !== "active" ||
      state.version !== args.expectedVersion ||
      state.nextEvaluationAt > args.now
    ) {
      return "stale";
    }
    const [policy, event] = await Promise.all([
      ctx.db.get(state.policyVersionId),
      ctx.db.get(state.eventId),
    ]);
    if (
      !policy ||
      !event ||
      policy.eventId !== event._id ||
      policy.status !== "published" ||
      event.publishedOperationsIntelligencePolicyId !== policy._id
    ) {
      throw new Error("The active intelligence automation policy is invalid.");
    }
    const normalizedPolicy = operationsIntelligencePolicyFromDocument(policy);
    if (!normalizedPolicy.enabled) {
      throw new Error("An active intelligence automation state has a disabled policy.");
    }
    const localBudgetDate = localDateKey(args.now, event.timezone);
    const briefsStartedToday =
      state.localBudgetDate === localBudgetDate ? state.briefsStartedToday : 0;
    const trigger = triggerFingerprint(policy._id, args.snapshot, normalizedPolicy);
    const basePatch = {
      nextEvaluationAt: args.now + evaluationIntervalMs,
      lastEvaluatedAt: args.now,
      localBudgetDate,
      briefsStartedToday,
      updatedAt: args.now,
      version: state.version + 1,
    };
    if (!trigger.fingerprint) {
      await ctx.db.patch(state._id, {
        ...basePatch,
        ...(state.lastTriggerFingerprint
          ? { lastTriggerFingerprint: undefined, cycle: state.cycle + 1 }
          : {}),
      });
      return "quiet";
    }
    if (state.lastTriggerFingerprint === trigger.fingerprint) {
      await ctx.db.patch(state._id, basePatch);
      return "unchanged";
    }
    if (
      state.lastTriggerAt !== undefined &&
      args.now < state.lastTriggerAt + normalizedPolicy.cooldownMinutes * 60_000
    ) {
      await ctx.db.patch(state._id, basePatch);
      return "cooldown";
    }
    if (briefsStartedToday >= normalizedPolicy.maximumBriefsPerLocalDay) {
      await ctx.db.patch(state._id, basePatch);
      return "budget_exhausted";
    }
    const latestBrief = await ctx.db
      .query("operationsIntelligenceBriefs")
      .withIndex("by_event_requested", (index) => index.eq("eventId", event._id))
      .order("desc")
      .first();
    if (latestBrief && isActiveBrief(latestBrief.state)) {
      await ctx.db.patch(state._id, basePatch);
      return "brief_in_progress";
    }
    const sourceChecksum = operationFingerprint([JSON.stringify(args.snapshot)]);
    const relevanceExpiresAt =
      args.now + normalizedPolicy.relevanceMinutes * 60_000;
    const signalId = await ctx.db.insert("operationsIntelligenceSignals", {
      eventId: event._id,
      policyVersionId: policy._id,
      automationStateId: state._id,
      cycle: state.cycle,
      triggerFingerprint: trigger.fingerprint,
      sourceSnapshot: args.snapshot,
      sourceChecksum,
      state: "pending",
      observedAt: args.now,
      expiresAt: relevanceExpiresAt,
    });
    const briefId = await ctx.db.insert("operationsIntelligenceBriefs", {
      eventId: event._id,
      origin: "automation",
      automationPolicyVersionId: policy._id,
      automationSignalId: signalId,
      relevanceExpiresAt,
      state: "pending",
      sourceSnapshot: args.snapshot,
      sourceChecksum,
      requestedAt: args.now,
      updatedAt: args.now,
      version: 1,
    });
    const workId = await intelligenceWorkpool.enqueueAction(
      ctx,
      internal.operationsIntelligenceActions.dispatchBrief,
      { briefId },
      {
        retry: true,
        onComplete: internal.operationsIntelligence.generationFinished,
        context: briefId,
      },
    );
    await ctx.db.patch(briefId, { workId });
    await ctx.db.patch(signalId, { state: "claimed", briefId });
    await ctx.db.patch(state._id, {
      ...basePatch,
      lastTriggerAt: args.now,
      lastTriggerFingerprint: trigger.fingerprint,
      briefsStartedToday: briefsStartedToday + 1,
    });
    await ctx.scheduler.runAfter(
      agentCompletionWindowMs,
      internal.operationsIntelligence.expire,
      { briefId },
    );
    await ctx.scheduler.runAfter(
      normalizedPolicy.relevanceMinutes * 60_000,
      internal.operationsIntelligenceAutomation.expireSignal,
      { signalId },
    );
    return "triggered";
  },
});

export async function settleAutomationSignal(
  ctx: MutationCtx,
  brief: Doc<"operationsIntelligenceBriefs">,
  result: "succeeded" | "failed",
  now: number,
) {
  if (!brief.automationSignalId) return;
  const signal = await ctx.db.get(brief.automationSignalId);
  if (
    !signal ||
    signal.briefId !== brief._id ||
    signal.eventId !== brief.eventId ||
    signal.state === "expired" ||
    signal.state === "succeeded" ||
    signal.state === "failed"
  ) {
    return;
  }
  await ctx.db.patch(signal._id, { state: result, settledAt: now });
}

export const expireSignal = internalMutation({
  args: { signalId: v.id("operationsIntelligenceSignals") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const signal = await ctx.db.get(args.signalId);
    if (!signal || signal.state === "expired") return null;
    const now = Date.now();
    if (now < signal.expiresAt) {
      await ctx.scheduler.runAfter(
        signal.expiresAt - now,
        internal.operationsIntelligenceAutomation.expireSignal,
        args,
      );
      return null;
    }
    await ctx.db.patch(signal._id, { state: "expired", settledAt: now });
    return null;
  },
});
