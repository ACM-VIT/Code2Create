import {
  operationsAutonomyRunPhases,
  operationsHealthSignalKeys,
  operationsIntelligenceProtocolVersion,
  type OperationsAutonomyCallback,
  type OperationsAutonomyCallbackReceipt,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { cancelAutonomyRun } from "./lib/operationsAutonomyCancellation";
import { ensureOperationsAutonomyContinuation } from "./lib/operationsAutonomyContinuation";
import {
  autonomyOperationFingerprint,
  nextAutonomySequence,
  patchAutonomyCheckpoint,
  requireAutonomyBoundary,
} from "./lib/operationsAutonomyLedger";

const signalKey = v.union(...operationsHealthSignalKeys.map((value) => v.literal(value)));
const callbackBase = {
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  runId: v.string(),
  policyVersionId: v.string(),
  policyChecksum: v.string(),
  sourceChecksum: v.string(),
  operationId: v.string(),
  agentVersion: v.string(),
  model: v.string(),
  observedSignalKeys: v.array(signalKey),
};

export const autonomyCallback = v.union(
  v.object({
    ...callbackBase,
    status: v.literal("running"),
    phase: v.union(
      ...operationsAutonomyRunPhases
        .filter((phase) => phase !== "terminal")
        .map((phase) => v.literal(phase)),
    ),
  }),
  v.object({
    ...callbackBase,
    status: v.union(v.literal("succeeded"), v.literal("no_op"), v.literal("escalated")),
    phase: v.literal("terminal"),
  }),
  v.object({
    ...callbackBase,
    status: v.literal("failed"),
    phase: v.literal("terminal"),
    failureCode: v.union(
      v.literal("provider_failed"),
      v.literal("tool_failed"),
      v.literal("policy_violation"),
      v.literal("callback_rejected"),
    ),
  }),
);

type RunPhase = (typeof operationsAutonomyRunPhases)[number];
const phases = (...values: RunPhase[]): ReadonlySet<RunPhase> => new Set(values);
const allowedPhaseTransitions: Record<RunPhase, ReadonlySet<RunPhase>> = {
  leased: phases("leased", "accepted", "planning"),
  accepted: phases("accepted", "planning"),
  planning: phases("planning", "reading", "continuing", "finalizing"),
  reading: phases("reading", "investigating", "continuing", "finalizing"),
  investigating: phases("investigating", "criticizing", "continuing", "finalizing"),
  criticizing: phases("criticizing", "proposing", "continuing", "finalizing"),
  proposing: phases("proposing", "continuing", "finalizing"),
  continuing: phases(
    "continuing",
    "reading",
    "investigating",
    "criticizing",
    "proposing",
    "finalizing",
  ),
  finalizing: phases("finalizing", "continuing", "terminal"),
  terminal: phases("terminal"),
};

function nextObservedKeys(current: readonly string[], incoming: readonly string[]) {
  const merged = new Set(current);
  for (const key of incoming) merged.add(key);
  return operationsHealthSignalKeys.filter((key) => merged.has(key));
}

export const applyCallback = internalMutation({
  args: { callback: autonomyCallback, now: v.number() },
  returns: v.union(
    v.object({ state: v.literal("accepted"), responseJson: v.string() }),
    v.object({ state: v.literal("rejected"), code: v.literal("authority_revoked") }),
  ),
  handler: async (ctx, args) => {
    const callback: OperationsAutonomyCallback = args.callback;
    const fingerprint = autonomyOperationFingerprint(callback);
    const boundary = await requireAutonomyBoundary(ctx, {
      ...callback,
      kind: "callback",
      fingerprint,
      now: args.now,
    });
    if (boundary.state === "replay") {
      if (boundary.prior.kind !== "callback") {
        throw new Error("The autonomy callback receipt is corrupt.");
      }
      return { state: "accepted" as const, responseJson: boundary.prior.responseJson };
    }
    if (boundary.state === "revoked") {
      await cancelAutonomyRun(ctx, {
        runId: boundary.run._id,
        reason: boundary.reason,
        now: args.now,
      });
      return { state: "rejected" as const, code: "authority_revoked" as const };
    }
    if (boundary.run.executor.kind === "known") {
      if (
        boundary.run.executor.agentVersion !== callback.agentVersion ||
        boundary.run.executor.model !== callback.model
      )
        throw new ConvexError({
          code: "OPERATIONS_AUTONOMY_EXECUTOR_CONFLICT",
          message: "The autonomy executor identity changed during the run.",
        });
    } else {
      await ctx.db.patch(boundary.run._id, {
        executor: { kind: "known", agentVersion: callback.agentVersion, model: callback.model },
        updatedAt: args.now,
        version: boundary.run.version + 1,
      });
    }
    if (
      callback.status !== "failed" &&
      !allowedPhaseTransitions[boundary.checkpoint.phase].has(callback.phase)
    ) {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_PHASE_INVALID",
        message: "The autonomy callback attempted to move its phase backward.",
      });
    }
    if (
      callback.status !== "running" &&
      callback.status !== "failed" &&
      boundary.checkpoint.phase !== "finalizing"
    ) {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_TERMINAL_INVALID",
        message: "A successful autonomy run may settle only after finalization.",
      });
    }
    const sequence = await nextAutonomySequence(ctx, boundary.checkpoint);
    const runState = callback.status === "running" ? ("running" as const) : callback.status;
    const receipt: OperationsAutonomyCallbackReceipt = {
      state: "accepted",
      sequence,
      runState,
    };
    const responseJson = JSON.stringify(receipt);
    await ctx.db.insert("operationsAutonomyOperationReceipts", {
      eventId: boundary.run.eventId,
      runId: boundary.run._id,
      operationId: boundary.operationId,
      sequence,
      fingerprint,
      kind: "callback",
      runState,
      responseJson,
      createdAt: args.now,
    });
    const observedSignalKeys = nextObservedKeys(
      boundary.checkpoint.observedSignalKeys,
      callback.observedSignalKeys,
    );
    if (callback.status === "running") {
      await patchAutonomyCheckpoint(ctx, boundary.checkpoint, {
        sequence,
        phase: callback.phase,
        observedSignalKeys,
        now: args.now,
      });
      if (callback.phase === "continuing") {
        await ensureOperationsAutonomyContinuation(ctx, {
          runId: boundary.run._id,
          eventId: boundary.run.eventId,
          causedByOperationId: boundary.operationId,
          ...(boundary.run.admission.kind === "accepted"
            ? { priorSubmissionId: boundary.run.admission.currentSubmissionId }
            : {}),
          now: args.now,
        });
      }
      return { state: "accepted" as const, responseJson };
    }
    await ctx.db.patch(boundary.run._id, {
      lifecycle:
        callback.status === "failed"
          ? { kind: "failed", failureCode: callback.failureCode, completedAt: args.now }
          : { kind: callback.status, completedAt: args.now },
      updatedAt: args.now,
      version: boundary.run.version + (boundary.run.executor.kind === "unknown" ? 2 : 1),
    });
    await patchAutonomyCheckpoint(ctx, boundary.checkpoint, {
      sequence,
      phase: "terminal",
      observedSignalKeys,
      activeRead: { kind: "none" },
      now: args.now,
    });
    const supervision = await ctx.db
      .query("operationsAutonomyRunSupervision")
      .withIndex("by_run", (index) => index.eq("runId", boundary.run._id))
      .unique();
    if (supervision) {
      await ctx.db.patch(supervision._id, {
        lifecycle: { kind: "terminal" },
        updatedAt: args.now,
      });
    }
    return { state: "accepted" as const, responseJson };
  },
});
