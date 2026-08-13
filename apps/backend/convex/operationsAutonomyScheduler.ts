import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { cancelAutonomyRun } from "./lib/operationsAutonomyCancellation";
import { enqueueOperationsAutonomySchedule } from "./lib/operationsAutonomyInbox";
import { operationsAutonomyLeaseDurationMs } from "./lib/operationsAutonomyLedger";
import {
  activateOperationsAutonomyRun,
  cancelPendingOperationsAutonomyRun,
  materializeOperationsAutonomyInboxRun,
} from "./lib/operationsAutonomyRunCreation";
import { autonomyRunIsTerminal, requireCurrentAutonomyAuthority } from "./lib/operationsAutonomyRuntime";
import { cancelPendingAutonomyInboxPage } from "./lib/operationsAutonomyRevocation";

const maximumStatesPerTick = 8;
const maximumScheduleSlotsPerStatePass = 16;
const maximumQueueRowsPerTick = 16;
const maximumSupervisionRowsPerTick = 16;
const retryDelayMs = 5_000;

export const dueStates = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.id("operationsAutonomyStates")),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("operationsAutonomyStates")
      .withIndex("by_lifecycle_next_evaluation", (index) =>
        index.eq("lifecycle.kind", "active").lte("nextEvaluationAt", args.now),
      )
      .take(maximumStatesPerTick);
    return rows.map((row) => row._id);
  },
});

export const enqueueDueSchedules = internalMutation({
  args: { stateId: v.id("operationsAutonomyStates"), now: v.number() },
  returns: v.object({ enqueued: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const state = await ctx.db.get(args.stateId);
    if (!state || state.lifecycle.kind !== "active") return { enqueued: 0, hasMore: false };
    const [event, policy, source] = await Promise.all([
      ctx.db.get(state.eventId),
      ctx.db.get(state.policyVersionId),
      ctx.db
        .query("operationsHealthSnapshots")
        .withIndex("by_event", (index) => index.eq("eventId", state.eventId))
        .unique(),
    ]);
    if (!event || event.status !== "live" || !policy || !policy.enabled || !source) {
      await ctx.db.patch(state._id, {
        lastEvaluatedAt: args.now,
        nextEvaluationAt: args.now + retryDelayMs,
        cycle: state.cycle + 1,
        updatedAt: args.now,
        version: state.version + 1,
      });
      return { enqueued: 0, hasMore: false };
    }
    const intervalMs = policy.scheduleIntervalMinutes * 60_000;
    const currentSlot = Math.floor(args.now / intervalMs) * intervalMs;
    let slot = state.lastScheduleSlot === undefined
      ? currentSlot
      : state.lastScheduleSlot + intervalMs;
    let enqueued = 0;
    let lastSlot = state.lastScheduleSlot;
    while (slot <= currentSlot && enqueued < maximumScheduleSlotsPerStatePass) {
      const prior = await ctx.db
        .query("operationsAutonomyInbox")
        .withIndex("by_event_operation_key", (index) =>
          index
            .eq("eventId", event._id)
            .eq("operationKey", `schedule:${policy._id}:${slot}`),
        )
        .unique();
      await enqueueOperationsAutonomySchedule(ctx, {
        eventId: event._id,
        policy,
        snapshot: source.snapshot,
        scheduledFor: slot,
        now: args.now,
      });
      if (!prior) enqueued += 1;
      lastSlot = slot;
      slot += intervalMs;
    }
    const refreshed = await ctx.db.get(state._id);
    if (!refreshed || refreshed.lifecycle.kind !== "active") {
      return { enqueued, hasMore: false };
    }
    const hasMore = slot <= currentSlot;
    await ctx.db.patch(state._id, {
      lastEvaluatedAt: args.now,
      ...(lastSlot !== undefined ? { lastScheduleSlot: lastSlot } : {}),
      nextEvaluationAt: hasMore ? args.now : slot,
      cycle: refreshed.cycle + 1,
      updatedAt: args.now,
      version: refreshed.version + 1,
    });
    return { enqueued, hasMore };
  },
});

export const pendingInboxCandidates = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.id("operationsAutonomyInbox")),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("operationsAutonomyInbox")
      .withIndex("by_lifecycle_next_attempt_at", (index) =>
        index.eq("lifecycle.kind", "pending").lte("nextAttemptAt", args.now),
      )
      .order("asc")
      .take(maximumQueueRowsPerTick);
    return rows.map((row) => row._id);
  },
});

export const pendingCancellationPolicies = internalQuery({
  args: {},
  returns: v.array(v.id("operationsAutonomyPolicyVersions")),
  handler: async (ctx) => {
    const states = await ctx.db
      .query("operationsAutonomyStates")
      .filter((query) => query.neq(query.field("pendingCancellationAt"), undefined))
      .take(maximumStatesPerTick);
    return states.map((state) => state.policyVersionId);
  },
});

export const cancelPendingInboxPage = internalMutation({
  args: { policyVersionId: v.id("operationsAutonomyPolicyVersions"), now: v.number() },
  returns: v.boolean(),
  handler: (ctx, args) => cancelPendingAutonomyInboxPage(ctx, args),
});

export const materializeInbox = internalMutation({
  args: { inboxId: v.id("operationsAutonomyInbox"), now: v.number() },
  returns: v.union(v.null(), v.id("operationsAutonomyRuns")),
  handler: async (ctx, args) => {
    const inbox = await ctx.db.get(args.inboxId);
    if (!inbox || inbox.lifecycle.kind !== "pending") return null;
    const state = await ctx.db
      .query("operationsAutonomyStates")
      .withIndex("by_policy", (index) => index.eq("policyVersionId", inbox.policyVersionId))
      .unique();
    if (!state || state.lifecycle.kind !== "active") return null;
    const event = await ctx.db.get(inbox.eventId);
    if (!event || event.status !== "live") {
      const run = await materializeOperationsAutonomyInboxRun(ctx, inbox, args.now);
      if (!run) return null;
      const claimedInbox = await ctx.db.get(inbox._id);
      if (!claimedInbox) throw new Error("The claimed autonomy inbox disappeared.");
      await cancelPendingOperationsAutonomyRun(ctx, {
        run,
        inbox: claimedInbox,
        state,
        now: args.now,
      });
      return run._id;
    }
    const [activeRun, pendingRun] = await Promise.all([
      ctx.db
        .query("operationsAutonomyRuns")
        .withIndex("by_event_policy_lifecycle", (index) =>
          index
            .eq("eventId", inbox.eventId)
            .eq("policyVersionId", inbox.policyVersionId)
            .eq("lifecycle.kind", "active"),
        )
        .first(),
      ctx.db
        .query("operationsAutonomyRuns")
        .withIndex("by_event_policy_lifecycle", (index) =>
          index
            .eq("eventId", inbox.eventId)
            .eq("policyVersionId", inbox.policyVersionId)
            .eq("lifecycle.kind", "pending"),
        )
        .first(),
    ]);
    if (activeRun || pendingRun) {
      await ctx.db.patch(inbox._id, {
        nextAttemptAt: args.now + retryDelayMs,
        updatedAt: args.now,
      });
      return null;
    }
    const run = await materializeOperationsAutonomyInboxRun(ctx, inbox, args.now);
    if (!run) return null;
    const activated = await activateOperationsAutonomyRun(ctx, run, args.now);
    if (!activated) {
      const currentEvent = await ctx.db.get(inbox.eventId);
      if (!currentEvent || currentEvent.status !== "live") {
        const currentState = await ctx.db.get(state._id);
        const currentInbox = await ctx.db.get(inbox._id);
        if (!currentState || !currentInbox) throw new Error("The autonomy queue owner disappeared.");
        await cancelPendingOperationsAutonomyRun(ctx, {
          run,
          inbox: currentInbox,
          state: currentState,
          now: args.now,
        });
      }
    }
    return run._id;
  },
});

export const pendingRunCandidates = internalQuery({
  args: {},
  returns: v.array(v.id("operationsAutonomyRuns")),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("operationsAutonomyRuns")
      .withIndex("by_lifecycle_created_at", (index) => index.eq("lifecycle.kind", "pending"))
      .order("asc")
      .take(maximumQueueRowsPerTick);
    return rows.map((row) => row._id);
  },
});

export const activatePendingRun = internalMutation({
  args: { runId: v.id("operationsAutonomyRuns"), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    return run ? activateOperationsAutonomyRun(ctx, run, args.now) : false;
  },
});

export const supervisionCandidates = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.id("operationsAutonomyRunSupervision")),
  handler: async (ctx, args) => {
    const [active, aborting] = await Promise.all([
      ctx.db
        .query("operationsAutonomyRunSupervision")
        .withIndex("by_lifecycle_next_action_at", (index) =>
          index.eq("lifecycle.kind", "active").lte("lifecycle.nextActionAt", args.now),
        )
        .take(maximumSupervisionRowsPerTick),
      ctx.db
        .query("operationsAutonomyRunSupervision")
        .withIndex("by_lifecycle_next_action_at", (index) =>
          index.eq("lifecycle.kind", "abort_pending").lte("lifecycle.nextActionAt", args.now),
        )
        .take(maximumSupervisionRowsPerTick),
    ]);
    return [...aborting, ...active]
      .toSorted((left, right) => {
        const leftAt = left.lifecycle.kind === "terminal" ? Number.MAX_SAFE_INTEGER : left.lifecycle.nextActionAt;
        const rightAt = right.lifecycle.kind === "terminal" ? Number.MAX_SAFE_INTEGER : right.lifecycle.nextActionAt;
        return leftAt - rightAt;
      })
      .slice(0, maximumSupervisionRowsPerTick)
      .map((row) => row._id);
  },
});

export const reconcileSupervision = internalMutation({
  args: { supervisionId: v.id("operationsAutonomyRunSupervision"), now: v.number() },
  returns: v.union(v.literal("unchanged"), v.literal("abort"), v.literal("dispatch"), v.literal("continue")),
  handler: async (ctx, args) => {
    const supervision = await ctx.db.get(args.supervisionId);
    if (!supervision || supervision.lifecycle.kind === "terminal") return "unchanged";
    const run = await ctx.db.get(supervision.runId);
    if (supervision.lifecycle.kind === "abort_pending") {
      if (
        supervision.outboundAttempt.kind === "in_flight" &&
        supervision.outboundAttempt.expiresAt > args.now
      ) {
        await ctx.db.patch(supervision._id, {
          lifecycle: {
            ...supervision.lifecycle,
            nextActionAt: supervision.outboundAttempt.expiresAt,
          },
          updatedAt: args.now,
        });
        return "unchanged";
      }
      await ctx.db.patch(supervision._id, {
        outboundAttempt: { kind: "idle" },
        lifecycle: {
          ...supervision.lifecycle,
          nextActionAt: args.now + retryDelayMs,
          attemptCount: supervision.lifecycle.attemptCount + 1,
        },
        updatedAt: args.now,
      });
      await ctx.scheduler.runAfter(0, internal.operationsAutonomyActions.abortRun, {
        runId: supervision.runId,
        reason: supervision.lifecycle.reason,
        operationId: supervision.lifecycle.operationId,
      });
      return "abort";
    }
    if (!run || autonomyRunIsTerminal(run)) {
      await ctx.db.patch(supervision._id, { lifecycle: { kind: "terminal" }, updatedAt: args.now });
      return "unchanged";
    }
    const authority = await requireCurrentAutonomyAuthority(ctx, run, args.now);
    if (authority.state !== "active") {
      await cancelAutonomyRun(ctx, { runId: run._id, reason: authority.reason, now: args.now });
      return "abort";
    }
    if (run.lifecycle.kind !== "active") return "unchanged";
    await ctx.db.patch(supervision._id, {
      lifecycle: {
        kind: "active",
        nextActionAt: args.now + operationsAutonomyLeaseDurationMs,
      },
      updatedAt: args.now,
    });
    if (run.admission.kind === "not_accepted") {
      await ctx.scheduler.runAfter(0, internal.operationsAutonomyActions.dispatchRun, {
        runId: run._id,
      });
      return "dispatch";
    }
    await ctx.scheduler.runAfter(0, internal.operationsAutonomyDispatch.recoverRun, {
      runId: run._id,
      causedByOperationId: `lease-recovery:${run.lifecycle.leaseId}`,
      priorSubmissionId: run.admission.currentSubmissionId,
    });
    return "continue";
  },
});
