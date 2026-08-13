import type { OperationsAutonomyCancellationReason } from "@code2create/domain";

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const terminalKinds = new Set([
  "succeeded",
  "no_op",
  "escalated",
  "failed",
  "canceled",
]);

export async function cancelAutonomyRun(
  ctx: MutationCtx,
  args: {
    runId: Id<"operationsAutonomyRuns">;
    reason: OperationsAutonomyCancellationReason;
    now: number;
  },
) {
  const run = await ctx.db.get(args.runId);
  if (!run || terminalKinds.has(run.lifecycle.kind)) return false;
  await ctx.db.patch(run._id, {
    lifecycle: { kind: "canceled", reason: args.reason, completedAt: args.now },
    updatedAt: args.now,
    version: run.version + 1,
  });
  const checkpoint = await ctx.db
    .query("operationsAutonomyRunCheckpoints")
    .withIndex("by_run", (index) => index.eq("runId", run._id))
    .unique();
  if (checkpoint) {
    await ctx.db.patch(checkpoint._id, {
      phase: "terminal",
      activeRead: { kind: "none" },
      updatedAt: args.now,
      version: checkpoint.version + 1,
    });
  }
  const inbox = await ctx.db
    .query("operationsAutonomyInbox")
    .withIndex("by_event_operation_key", (index) =>
      index.eq("eventId", run.eventId).eq("operationKey", run.operationKey),
    )
    .unique();
  if (inbox && inbox.lifecycle.kind !== "canceled") {
    await ctx.db.patch(inbox._id, {
      lifecycle: { kind: "canceled", canceledAt: args.now },
      updatedAt: args.now,
    });
  }
  const supervision = await ctx.db
    .query("operationsAutonomyRunSupervision")
    .withIndex("by_run", (index) => index.eq("runId", run._id))
    .unique();
  if (run.lifecycle.kind === "pending") return true;
  const operationId = `abort:${run._id}:${args.reason}`;
  const abortAt =
    supervision?.outboundAttempt.kind === "in_flight"
      ? supervision.outboundAttempt.expiresAt
      : args.now;
  if (supervision) {
    await ctx.db.patch(supervision._id, {
      lifecycle: {
        kind: "abort_pending",
        nextActionAt: abortAt,
        reason: args.reason,
        operationId,
        attemptCount: 0,
      },
      updatedAt: args.now,
    });
  }
  if (supervision?.outboundAttempt.kind !== "in_flight") {
    await ctx.scheduler.runAfter(0, internal.operationsAutonomyActions.abortRun, {
      runId: run._id,
      reason: args.reason,
      operationId,
    });
  }
  return true;
}
