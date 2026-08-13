import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { autonomyOperationFingerprint } from "./operationsAutonomyLedger";

export function operationsAutonomyContinuationWorkItemId(args: {
  runId: Id<"operationsAutonomyRuns">;
  priorSubmissionId: string;
}) {
  return `work:${autonomyOperationFingerprint(args)}`;
}

export async function ensureOperationsAutonomyContinuation(
  ctx: MutationCtx,
  args: {
    runId: Id<"operationsAutonomyRuns">;
    eventId: Id<"events">;
    causedByOperationId: string;
    priorSubmissionId?: string;
    now: number;
  },
) {
  const workItemId = operationsAutonomyContinuationWorkItemId({
    runId: args.runId,
    priorSubmissionId: args.priorSubmissionId ?? "awaiting-admission",
  });
  const existing = args.priorSubmissionId === undefined
    ? await ctx.db
        .query("operationsAutonomyContinuations")
        .withIndex("by_run_work_item", (index) =>
          index.eq("runId", args.runId).eq("workItemId", workItemId),
        )
        .unique()
    : await ctx.db
        .query("operationsAutonomyContinuations")
        .withIndex("by_run_prior_submission", (index) =>
          index.eq("runId", args.runId).eq("priorSubmissionId", args.priorSubmissionId),
        )
        .unique();
  if (existing) return existing._id;

  const continuationId = await ctx.db.insert("operationsAutonomyContinuations", {
    eventId: args.eventId,
    runId: args.runId,
    workItemId,
    causedByOperationId: args.causedByOperationId,
    ...(args.priorSubmissionId === undefined
      ? {}
      : { priorSubmissionId: args.priorSubmissionId }),
    lifecycle: args.priorSubmissionId === undefined
      ? { kind: "awaiting_prior" as const }
      : { kind: "pending" as const, nextAttemptAt: args.now },
    attemptCount: 0,
    createdAt: args.now,
    updatedAt: args.now,
  });
  if (args.priorSubmissionId !== undefined) {
    await ctx.scheduler.runAfter(0, internal.operationsAutonomyActions.continueRun, {
      continuationId,
    });
  }
  return continuationId;
}
