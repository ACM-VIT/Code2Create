import {
  operationsAutonomyAdmissionSignatureMaximumAgeMs,
  operationsIntelligenceProtocolVersion,
  type OperationsAutonomyDispatchRequest,
} from "@code2create/domain";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { cancelAutonomyRun } from "./lib/operationsAutonomyCancellation";
import { ensureOperationsAutonomyContinuation } from "./lib/operationsAutonomyContinuation";
import { operationsAutonomyLeaseDurationMs } from "./lib/operationsAutonomyLedger";
import { requireCurrentAutonomyAuthority } from "./lib/operationsAutonomyRuntime";
import {
  operationsAutonomyEscalationSeverity,
  operationsAutonomyMode,
  operationsAutonomyReadTool,
  operationsAutonomyRecommendationKind,
  operationsAutonomySourceSnapshot,
  operationsAutonomyTrigger,
} from "./lib/operationsAutonomyValidators";

const retryDelayMs = 5_000;
const workerAdmissionDeadlineMs = 10_000;
const transportUncertaintyMarginMs = 20_000;
export const operationsAutonomyOutboundAttemptLifetimeMs =
  operationsAutonomyAdmissionSignatureMaximumAgeMs +
  workerAdmissionDeadlineMs +
  transportUncertaintyMarginMs;

const dispatchPayload = v.object({
  attemptId: v.string(),
  signedAt: v.number(),
  request: v.object({
    protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
    runId: v.string(),
    eventSlug: v.string(),
    trigger: operationsAutonomyTrigger,
    policy: v.object({
      policyVersionId: v.string(),
      policyVersion: v.number(),
      policyChecksum: v.string(),
      mode: operationsAutonomyMode,
      escalationSeverity: operationsAutonomyEscalationSeverity,
      allowedReadTools: v.array(operationsAutonomyReadTool),
      allowedRecommendationKinds: v.array(operationsAutonomyRecommendationKind),
    }),
    source: v.object({ sourceChecksum: v.string(), snapshot: operationsAutonomySourceSnapshot }),
  }),
});

export const prepareDispatch = internalMutation({
  args: { runId: v.id("operationsAutonomyRuns"), now: v.number() },
  returns: v.union(v.null(), dispatchPayload),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.lifecycle.kind !== "active" || run.admission.kind === "accepted") return null;
    const supervision = await ctx.db
      .query("operationsAutonomyRunSupervision")
      .withIndex("by_run", (index) => index.eq("runId", run._id))
      .unique();
    if (!supervision || supervision.lifecycle.kind !== "active") return null;
    if (
      supervision.outboundAttempt.kind === "in_flight" &&
      supervision.outboundAttempt.expiresAt > args.now
    )
      return null;
    const authority = await requireCurrentAutonomyAuthority(ctx, run, args.now);
    if (authority.state !== "active") {
      await cancelAutonomyRun(ctx, { runId: run._id, reason: authority.reason, now: args.now });
      return null;
    }
    const request: OperationsAutonomyDispatchRequest = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      trigger: run.trigger.kind,
      runId: run._id,
      eventSlug: authority.event.slug,
      policy: {
        policyVersionId: run.policyVersionId,
        policyVersion: run.policyVersion,
        policyChecksum: run.policyChecksum,
        mode: run.mode,
        escalationSeverity: run.escalationSeverity,
        allowedReadTools: run.allowedReadTools,
        allowedRecommendationKinds: run.allowedRecommendationKinds,
      },
      source: { sourceChecksum: run.sourceChecksum, snapshot: run.sourceSnapshot },
    };
    const attemptId = `dispatch:${run._id}:${args.now}`;
    await ctx.db.patch(supervision._id, {
      outboundAttempt: {
        kind: "in_flight",
        attemptId,
        operation: "dispatch",
        signedAt: args.now,
        startedAt: args.now,
        expiresAt: args.now + operationsAutonomyOutboundAttemptLifetimeMs,
      },
      updatedAt: args.now,
    });
    return { attemptId, signedAt: args.now, request };
  },
});

async function settleOutboundAttempt(
  ctx: MutationCtx,
  args: {
    runId: Id<"operationsAutonomyRuns">;
    attemptId: string;
    now: number;
  },
) {
  const supervision = await ctx.db
    .query("operationsAutonomyRunSupervision")
    .withIndex("by_run", (index) => index.eq("runId", args.runId))
    .unique();
  if (!supervision) return false;
  const matches =
    supervision.outboundAttempt.kind === "in_flight" &&
    supervision.outboundAttempt.attemptId === args.attemptId;
  if (!matches) return false;
  const abort = supervision.lifecycle.kind === "abort_pending" ? supervision.lifecycle : null;
  await ctx.db.patch(supervision._id, {
    outboundAttempt: { kind: "idle" },
    ...(abort ? { lifecycle: { ...abort, nextActionAt: args.now } } : {}),
    updatedAt: args.now,
  });
  if (abort) {
    await ctx.scheduler.runAfter(0, internal.operationsAutonomyActions.abortRun, {
      runId: args.runId,
      reason: abort.reason,
      operationId: abort.operationId,
    });
  }
  return true;
}

async function retainAmbiguousOutboundAttempt(
  ctx: MutationCtx,
  args: {
    runId: Id<"operationsAutonomyRuns">;
    attemptId: string;
    now: number;
  },
) {
  const supervision = await ctx.db
    .query("operationsAutonomyRunSupervision")
    .withIndex("by_run", (index) => index.eq("runId", args.runId))
    .unique();
  if (
    !supervision ||
    supervision.outboundAttempt.kind !== "in_flight" ||
    supervision.outboundAttempt.attemptId !== args.attemptId
  )
    return null;
  const expiresAt = supervision.outboundAttempt.expiresAt;
  await ctx.db.patch(supervision._id, {
    lifecycle:
      supervision.lifecycle.kind === "terminal"
        ? supervision.lifecycle
        : { ...supervision.lifecycle, nextActionAt: expiresAt },
    updatedAt: args.now,
  });
  return expiresAt;
}

async function releaseAwaitingContinuation(
  ctx: MutationCtx,
  runId: Id<"operationsAutonomyRuns">,
  priorSubmissionId: string,
  now: number,
) {
  const waiting = await ctx.db
    .query("operationsAutonomyContinuations")
    .withIndex("by_run_lifecycle_created_at", (index) =>
      index.eq("runId", runId).eq("lifecycle.kind", "awaiting_prior"),
    )
    .order("asc")
    .first();
  if (!waiting) return;
  await ctx.db.patch(waiting._id, {
    priorSubmissionId,
    lifecycle: { kind: "pending", nextAttemptAt: now },
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.operationsAutonomyActions.continueRun, {
    continuationId: waiting._id,
  });
}

export const recordDispatchReceipt = internalMutation({
  args: {
    runId: v.id("operationsAutonomyRuns"),
    attemptId: v.string(),
    submissionId: v.string(),
    acceptedAt: v.number(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const settled = await settleOutboundAttempt(ctx, args);
    const run = await ctx.db.get(args.runId);
    if (!run) return false;
    if (run.admission.kind === "accepted") {
      if (
        run.admission.submissionId !== args.submissionId ||
        run.admission.acceptedAt !== args.acceptedAt
      )
        throw new Error("The autonomy admission receipt conflicts with the stored receipt.");
      return true;
    }
    if (!settled || run.lifecycle.kind !== "active") return false;
    await ctx.db.patch(run._id, {
      admission: {
        kind: "accepted",
        submissionId: args.submissionId,
        currentSubmissionId: args.submissionId,
        acceptedAt: args.acceptedAt,
      },
      lifecycle: {
        kind: "active",
        leaseId: run.lifecycle.leaseId,
        leaseExpiresAt: args.now + operationsAutonomyLeaseDurationMs,
      },
      updatedAt: args.now,
      version: run.version + 1,
    });
    await releaseAwaitingContinuation(ctx, run._id, args.submissionId, args.now);
    return true;
  },
});

export const recordDispatchFailure = internalMutation({
  args: { runId: v.id("operationsAutonomyRuns"), attemptId: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const retryAt = await retainAmbiguousOutboundAttempt(ctx, args);
    if (retryAt === null) return null;
    const run = await ctx.db.get(args.runId);
    if (!run || run.lifecycle.kind !== "active" || run.admission.kind === "accepted") return null;
    const supervision = await ctx.db
      .query("operationsAutonomyRunSupervision")
      .withIndex("by_run", (index) => index.eq("runId", run._id))
      .unique();
    if (supervision?.lifecycle.kind === "active") {
      await ctx.db.patch(supervision._id, {
        lifecycle: { kind: "active", nextActionAt: retryAt },
        updatedAt: args.now,
      });
    }
    return null;
  },
});

export const prepareContinuation = internalMutation({
  args: { continuationId: v.id("operationsAutonomyContinuations"), now: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      runId: v.id("operationsAutonomyRuns"),
      operationId: v.string(),
      priorSubmissionId: v.string(),
      workItemId: v.string(),
      attemptId: v.string(),
      signedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const continuation = await ctx.db.get(args.continuationId);
    if (
      !continuation ||
      continuation.lifecycle.kind !== "pending" ||
      continuation.priorSubmissionId === undefined
    )
      return null;
    const run = await ctx.db.get(continuation.runId);
    if (!run || run.lifecycle.kind !== "active") {
      await ctx.db.patch(continuation._id, {
        lifecycle: { kind: "canceled", canceledAt: args.now },
        updatedAt: args.now,
      });
      return null;
    }
    const supervision = await ctx.db
      .query("operationsAutonomyRunSupervision")
      .withIndex("by_run", (index) => index.eq("runId", run._id))
      .unique();
    if (!supervision || supervision.lifecycle.kind !== "active") return null;
    if (
      supervision.outboundAttempt.kind === "in_flight" &&
      supervision.outboundAttempt.expiresAt > args.now
    )
      return null;
    const authority = await requireCurrentAutonomyAuthority(ctx, run, args.now);
    if (authority.state !== "active") {
      await cancelAutonomyRun(ctx, { runId: run._id, reason: authority.reason, now: args.now });
      return null;
    }
    const attemptId = `continuation:${continuation._id}:${continuation.attemptCount + 1}`;
    await ctx.db.patch(supervision._id, {
      outboundAttempt: {
        kind: "in_flight",
        attemptId,
        operation: "continuation",
        signedAt: args.now,
        startedAt: args.now,
        expiresAt: args.now + operationsAutonomyOutboundAttemptLifetimeMs,
      },
      updatedAt: args.now,
    });
    return {
      runId: run._id,
      operationId: continuation.causedByOperationId,
      priorSubmissionId: continuation.priorSubmissionId,
      workItemId: continuation.workItemId,
      attemptId,
      signedAt: args.now,
    };
  },
});

export const recordContinuationReceipt = internalMutation({
  args: {
    continuationId: v.id("operationsAutonomyContinuations"),
    attemptId: v.string(),
    submissionId: v.string(),
    acceptedAt: v.number(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const continuation = await ctx.db.get(args.continuationId);
    if (!continuation) return false;
    if (continuation.lifecycle.kind === "accepted") {
      if (
        continuation.lifecycle.submissionId !== args.submissionId ||
        continuation.lifecycle.acceptedAt !== args.acceptedAt
      )
        throw new Error("The autonomy continuation receipt conflicts with the stored receipt.");
      return true;
    }
    if (continuation.lifecycle.kind !== "pending" || continuation.priorSubmissionId === undefined) {
      return false;
    }
    const settled = await settleOutboundAttempt(ctx, {
      runId: continuation.runId,
      attemptId: args.attemptId,
      now: args.now,
    });
    if (!settled) return false;
    const priorSubmissionId = continuation.priorSubmissionId;
    const run = await ctx.db.get(continuation.runId);
    if (
      !run ||
      run.lifecycle.kind !== "active" ||
      run.admission.kind !== "accepted" ||
      run.admission.currentSubmissionId !== priorSubmissionId
    ) {
      await ctx.db.patch(continuation._id, {
        lifecycle: { kind: "canceled", canceledAt: args.now },
        updatedAt: args.now,
      });
      return false;
    }
    await ctx.db.patch(continuation._id, {
      lifecycle: {
        kind: "accepted",
        submissionId: args.submissionId,
        acceptedAt: args.acceptedAt,
      },
      updatedAt: args.now,
    });
    await ctx.db.patch(run._id, {
      admission: { ...run.admission, currentSubmissionId: args.submissionId },
      updatedAt: args.now,
      version: run.version + 1,
    });
    await releaseAwaitingContinuation(ctx, continuation.runId, args.submissionId, args.now);
    return true;
  },
});

export const recordContinuationFailure = internalMutation({
  args: {
    continuationId: v.id("operationsAutonomyContinuations"),
    attemptId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const continuation = await ctx.db.get(args.continuationId);
    if (!continuation) return null;
    const retryAt = await retainAmbiguousOutboundAttempt(ctx, {
      runId: continuation.runId,
      attemptId: args.attemptId,
      now: args.now,
    });
    if (retryAt === null || continuation.lifecycle.kind !== "pending") return null;
    const run = await ctx.db.get(continuation.runId);
    if (!run || run.lifecycle.kind !== "active") {
      await ctx.db.patch(continuation._id, {
        lifecycle: { kind: "canceled", canceledAt: args.now },
        updatedAt: args.now,
      });
      return null;
    }
    await ctx.db.patch(continuation._id, {
      lifecycle: {
        kind: "pending",
        nextAttemptAt: retryAt,
      },
      attemptCount: continuation.attemptCount + 1,
      updatedAt: args.now,
    });
    return null;
  },
});

export const dueContinuations = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.id("operationsAutonomyContinuations")),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("operationsAutonomyContinuations")
      .withIndex("by_lifecycle_next_attempt", (index) =>
        index.eq("lifecycle.kind", "pending").lte("lifecycle.nextAttemptAt", args.now),
      )
      .take(16);
    return rows.map((row) => row._id);
  },
});

export const recoverRun = internalMutation({
  args: {
    runId: v.id("operationsAutonomyRuns"),
    causedByOperationId: v.string(),
    priorSubmissionId: v.string(),
  },
  returns: v.union(v.null(), v.id("operationsAutonomyContinuations")),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.lifecycle.kind !== "active") return null;
    if (
      run.admission.kind !== "accepted" ||
      run.admission.currentSubmissionId !== args.priorSubmissionId
    )
      return null;
    const now = Date.now();
    return ensureOperationsAutonomyContinuation(ctx, {
      eventId: run.eventId,
      runId: run._id,
      causedByOperationId: args.causedByOperationId,
      priorSubmissionId: args.priorSubmissionId,
      now,
    });
  },
});

export const acknowledgeAbort = internalMutation({
  args: {
    runId: v.id("operationsAutonomyRuns"),
    operationId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const supervision = await ctx.db
      .query("operationsAutonomyRunSupervision")
      .withIndex("by_run", (index) => index.eq("runId", args.runId))
      .unique();
    if (!supervision) return false;
    if (supervision.lifecycle.kind === "terminal") return true;
    if (
      supervision.lifecycle.kind !== "abort_pending" ||
      supervision.lifecycle.operationId !== args.operationId
    )
      return false;
    if (supervision.outboundAttempt.kind !== "idle") return false;
    await ctx.db.patch(supervision._id, { lifecycle: { kind: "terminal" }, updatedAt: args.now });
    return true;
  },
});

export const recordAbortFailure = internalMutation({
  args: {
    runId: v.id("operationsAutonomyRuns"),
    operationId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const supervision = await ctx.db
      .query("operationsAutonomyRunSupervision")
      .withIndex("by_run", (index) => index.eq("runId", args.runId))
      .unique();
    if (
      supervision?.lifecycle.kind !== "abort_pending" ||
      supervision.lifecycle.operationId !== args.operationId
    )
      return null;
    await ctx.db.patch(supervision._id, {
      lifecycle: {
        ...supervision.lifecycle,
        nextActionAt: args.now + retryDelayMs,
        attemptCount: supervision.lifecycle.attemptCount + 1,
      },
      updatedAt: args.now,
    });
    return null;
  },
});
