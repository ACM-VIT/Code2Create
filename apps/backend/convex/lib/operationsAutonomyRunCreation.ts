import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { operationsAutonomyAvailable } from "./operationsAutonomyAvailability";
import { requireValidAutonomyOwner } from "./operationsAutonomyPolicy";
import { operationsAutonomyLeaseDurationMs } from "./operationsAutonomyLedger";

export async function materializeOperationsAutonomyInboxRun(
  ctx: MutationCtx,
  item: Doc<"operationsAutonomyInbox">,
  now: number,
) {
  if (item.lifecycle.kind === "claimed") {
    const existing = await ctx.db.get(item.lifecycle.runId);
    if (!existing || existing.eventId !== item.eventId) {
      throw new Error("The autonomy inbox references an invalid run.");
    }
    return existing;
  }
  if (item.lifecycle.kind !== "pending") return null;
  const policy = await ctx.db.get(item.policyVersionId);
  if (!policy || policy.eventId !== item.eventId || policy.status !== "published") return null;
  const runId = await ctx.db.insert("operationsAutonomyRuns", {
    eventId: item.eventId,
    policyVersionId: policy._id,
    policyVersion: policy.version,
    policyChecksum: policy.checksum,
    trigger: item.trigger,
    mode: policy.mode,
    escalationSeverity: policy.escalationSeverity,
    allowedReadTools: policy.allowedReadTools,
    allowedRecommendationKinds: policy.allowedRecommendationKinds,
    sourceSnapshot: item.sourceSnapshot,
    sourceFactHighWatermarks: item.sourceFactHighWatermarks,
    sourceChecksum: item.sourceChecksum,
    operationKey: item.operationKey,
    admission: { kind: "not_accepted" },
    executor: { kind: "unknown" },
    lifecycle: { kind: "pending" },
    attemptCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("operationsAutonomyRunCheckpoints", {
    eventId: item.eventId,
    runId,
    sequence: 0,
    phase: "leased",
    toolCallsUsed: 0,
    delegationsUsed: 0,
    readBytesUsed: 0,
    recommendationsProposed: 0,
    observedSignalKeys: [],
    activeRead: { kind: "none" },
    updatedAt: now,
    version: 1,
  });
  await ctx.db.patch(item._id, {
    lifecycle: { kind: "claimed", runId },
    updatedAt: now,
  });
  const run = await ctx.db.get(runId);
  if (!run) throw new Error("The autonomy run could not be read after creation.");
  return run;
}

export async function activateOperationsAutonomyRun(
  ctx: MutationCtx,
  run: Doc<"operationsAutonomyRuns">,
  now: number,
) {
  if (run.lifecycle.kind !== "pending") return run.lifecycle.kind === "active";
  const [event, policy, state, active] = await Promise.all([
    ctx.db.get(run.eventId),
    ctx.db.get(run.policyVersionId),
    ctx.db
      .query("operationsAutonomyStates")
      .withIndex("by_policy", (index) => index.eq("policyVersionId", run.policyVersionId))
      .unique(),
    ctx.db
      .query("operationsAutonomyRuns")
      .withIndex("by_event_policy_lifecycle", (index) =>
        index
          .eq("eventId", run.eventId)
          .eq("policyVersionId", run.policyVersionId)
          .eq("lifecycle.kind", "active"),
      )
      .take(2),
  ]);
  if (active.length > 1) throw new Error("An event policy has multiple active autonomy runs.");
  if (active.length === 1) return false;
  if (
    !event ||
    !operationsAutonomyAvailable(event, now) ||
    !policy ||
    policy.status !== "published" ||
    !policy.enabled ||
    !state ||
    state.lifecycle.kind !== "active"
  ) return false;
  await requireValidAutonomyOwner(
    ctx,
    event._id,
    policy.accountableOwnerEventAccessSubjectId,
    policy.mode,
  );
  const leaseId = `lease:${run._id}:${run.attemptCount + 1}`;
  await ctx.db.patch(run._id, {
    lifecycle: {
      kind: "active",
      leaseId,
      leaseExpiresAt: now + operationsAutonomyLeaseDurationMs,
    },
    attemptCount: run.attemptCount + 1,
    updatedAt: now,
    version: run.version + 1,
  });
  await ctx.db.insert("operationsAutonomyRunSupervision", {
    eventId: run.eventId,
    runId: run._id,
    outboundAttempt: { kind: "idle" },
    lifecycle: {
      kind: "active",
      nextActionAt: now + operationsAutonomyLeaseDurationMs,
    },
    updatedAt: now,
  });
  await ctx.db.patch(state._id, {
    pendingWorkCount: Math.max(0, state.pendingWorkCount - 1),
    lastRunAt: now,
    updatedAt: now,
    version: state.version + 1,
  });
  await ctx.scheduler.runAfter(0, internal.operationsAutonomyActions.dispatchRun, {
    runId: run._id,
  });
  return true;
}

export async function cancelPendingOperationsAutonomyRun(
  ctx: MutationCtx,
  args: {
    run: Doc<"operationsAutonomyRuns">;
    inbox: Doc<"operationsAutonomyInbox">;
    state: Doc<"operationsAutonomyStates">;
    now: number;
  },
) {
  if (args.run.lifecycle.kind !== "pending" || args.inbox.lifecycle.kind !== "claimed") {
    throw new Error("Only one claimed pending autonomy run can be canceled before admission.");
  }
  await ctx.db.patch(args.run._id, {
    lifecycle: { kind: "canceled", reason: "event_not_live", completedAt: args.now },
    updatedAt: args.now,
    version: args.run.version + 1,
  });
  const checkpoint = await ctx.db
    .query("operationsAutonomyRunCheckpoints")
    .withIndex("by_run", (index) => index.eq("runId", args.run._id))
    .unique();
  if (!checkpoint) throw new Error("The pending autonomy run checkpoint is missing.");
  await ctx.db.patch(checkpoint._id, {
    phase: "terminal",
    activeRead: { kind: "none" },
    updatedAt: args.now,
    version: checkpoint.version + 1,
  });
  await ctx.db.patch(args.inbox._id, {
    lifecycle: { kind: "canceled", canceledAt: args.now },
    updatedAt: args.now,
  });
  await ctx.db.patch(args.state._id, {
    pendingWorkCount: Math.max(0, args.state.pendingWorkCount - 1),
    updatedAt: args.now,
    version: args.state.version + 1,
  });
}

export async function activateOldestPendingAutonomyRun(
  ctx: MutationCtx,
  eventId: Id<"events">,
  policyVersionId: Id<"operationsAutonomyPolicyVersions">,
  now: number,
) {
  const run = await ctx.db
    .query("operationsAutonomyRuns")
    .withIndex("by_event_policy_lifecycle", (index) =>
      index
        .eq("eventId", eventId)
        .eq("policyVersionId", policyVersionId)
        .eq("lifecycle.kind", "pending"),
    )
    .order("asc")
    .first();
  return run ? activateOperationsAutonomyRun(ctx, run, now) : false;
}
