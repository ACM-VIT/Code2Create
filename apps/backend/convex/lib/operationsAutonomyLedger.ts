import type { OperationsAutonomyReadTool } from "@code2create/domain";
import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { operationFingerprint } from "./operations";
import {
  autonomyRunIsTerminal,
  readToolAllowed,
  requireCurrentAutonomyAuthority,
} from "./operationsAutonomyRuntime";
import { normalizedText } from "./strings";

export const operationsAutonomyLeaseDurationMs = 90_000;
const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;

export function autonomyBoundaryError(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

export function autonomyOperationFingerprint(value: object) {
  return operationFingerprint([JSON.stringify(value)]);
}

export function normalizeAutonomyOperationId(value: string) {
  const operationId = normalizedText(value, "Operation ID", 8, 200);
  if (!operationIdPattern.test(operationId)) {
    autonomyBoundaryError(
      "OPERATIONS_AUTONOMY_OPERATION_INVALID",
      "The operation ID is invalid.",
    );
  }
  return operationId;
}

export async function autonomyRunAndCheckpoint(
  ctx: QueryCtx | MutationCtx,
  runIdText: string,
) {
  const runId = ctx.db.normalizeId("operationsAutonomyRuns", runIdText);
  const run = runId ? await ctx.db.get(runId) : null;
  if (!run) {
    autonomyBoundaryError(
      "OPERATIONS_AUTONOMY_RUN_NOT_FOUND",
      "The autonomy run does not exist.",
    );
  }
  const checkpoint = await ctx.db
    .query("operationsAutonomyRunCheckpoints")
    .withIndex("by_run", (index) => index.eq("runId", run._id))
    .unique();
  if (!checkpoint || checkpoint.eventId !== run.eventId) {
    throw new Error("The autonomy run checkpoint is missing or corrupt.");
  }
  return { run, checkpoint };
}

export function exactAutonomyRunIdentity(
  run: Doc<"operationsAutonomyRuns">,
  request: {
    policyVersionId: string;
    policyChecksum: string;
    sourceChecksum: string;
  },
) {
  return request.policyVersionId === run.policyVersionId &&
    request.policyChecksum === run.policyChecksum &&
    request.sourceChecksum === run.sourceChecksum;
}

export async function existingAutonomyOperationReceipt(
  ctx: QueryCtx | MutationCtx,
  args: {
    runId: Id<"operationsAutonomyRuns">;
    operationId: string;
    kind: Doc<"operationsAutonomyOperationReceipts">["kind"];
    fingerprint: string;
  },
) {
  const receipt = await ctx.db
    .query("operationsAutonomyOperationReceipts")
    .withIndex("by_run_operation", (index) =>
      index.eq("runId", args.runId).eq("operationId", args.operationId),
    )
    .unique();
  if (!receipt) return null;
  if (receipt.kind !== args.kind || receipt.fingerprint !== args.fingerprint) {
    autonomyBoundaryError(
      "OPERATIONS_AUTONOMY_OPERATION_CONFLICT",
      "That autonomy operation ID was already used for another request.",
    );
  }
  return receipt;
}

export async function requireAutonomyBoundary(
  ctx: MutationCtx,
  args: {
    runId: string;
    policyVersionId: string;
    policyChecksum: string;
    sourceChecksum: string;
    operationId: string;
    kind: Doc<"operationsAutonomyOperationReceipts">["kind"];
    fingerprint: string;
    now: number;
  },
) {
  const { run, checkpoint } = await autonomyRunAndCheckpoint(ctx, args.runId);
  if (!exactAutonomyRunIdentity(run, args)) {
    autonomyBoundaryError(
      "OPERATIONS_AUTONOMY_RUN_MISMATCH",
      "The autonomy run identity is stale.",
    );
  }
  const operationId = normalizeAutonomyOperationId(args.operationId);
  const prior = await existingAutonomyOperationReceipt(ctx, {
    runId: run._id,
    operationId,
    kind: args.kind,
    fingerprint: args.fingerprint,
  });
  if (prior) return { state: "replay" as const, prior, run, checkpoint };
  if (autonomyRunIsTerminal(run)) {
    autonomyBoundaryError(
      "OPERATIONS_AUTONOMY_RUN_TERMINAL",
      "The autonomy run is already terminal.",
    );
  }
  const authority = await requireCurrentAutonomyAuthority(ctx, run, args.now);
  if (authority.state !== "active") {
    return { state: "revoked" as const, reason: authority.reason, run, checkpoint };
  }
  if (run.lifecycle.kind !== "active") {
    autonomyBoundaryError(
      "OPERATIONS_AUTONOMY_NOT_ACTIVE",
      "The autonomy run is not active.",
    );
  }
  await ctx.db.patch(run._id, {
    lifecycle: {
      kind: "active",
      leaseId: run.lifecycle.leaseId,
      leaseExpiresAt: args.now + operationsAutonomyLeaseDurationMs,
    },
    updatedAt: args.now,
    version: run.version + 1,
  });
  const supervision = await ctx.db
    .query("operationsAutonomyRunSupervision")
    .withIndex("by_run", (index) => index.eq("runId", run._id))
    .unique();
  if (supervision?.lifecycle.kind === "active") {
    await ctx.db.patch(supervision._id, {
      lifecycle: {
        kind: "active",
        nextActionAt: args.now + operationsAutonomyLeaseDurationMs,
      },
      updatedAt: args.now,
    });
  }
  return { state: "new" as const, run, checkpoint, operationId, authority };
}

export async function nextAutonomySequence(
  ctx: MutationCtx,
  checkpoint: Doc<"operationsAutonomyRunCheckpoints">,
) {
  const sequence = checkpoint.sequence + 1;
  const collision = await ctx.db
    .query("operationsAutonomyOperationReceipts")
    .withIndex("by_run_sequence", (index) =>
      index.eq("runId", checkpoint.runId).eq("sequence", sequence),
    )
    .unique();
  if (collision) throw new Error("The autonomy operation sequence is corrupt.");
  return sequence;
}

export async function patchAutonomyCheckpoint(
  ctx: MutationCtx,
  checkpoint: Doc<"operationsAutonomyRunCheckpoints">,
  args: {
    sequence: number;
    phase?: Doc<"operationsAutonomyRunCheckpoints">["phase"];
    toolCallsUsed?: number;
    delegationsUsed?: number;
    readBytesUsed?: number;
    recommendationsProposed?: number;
    observedSignalKeys?: Doc<"operationsAutonomyRunCheckpoints">["observedSignalKeys"];
    activeRead?: Doc<"operationsAutonomyRunCheckpoints">["activeRead"];
    now: number;
  },
) {
  await ctx.db.patch(checkpoint._id, {
    sequence: args.sequence,
    ...(args.phase !== undefined ? { phase: args.phase } : {}),
    ...(args.toolCallsUsed !== undefined ? { toolCallsUsed: args.toolCallsUsed } : {}),
    ...(args.delegationsUsed !== undefined ? { delegationsUsed: args.delegationsUsed } : {}),
    ...(args.readBytesUsed !== undefined ? { readBytesUsed: args.readBytesUsed } : {}),
    ...(args.recommendationsProposed !== undefined
      ? { recommendationsProposed: args.recommendationsProposed }
      : {}),
    ...(args.observedSignalKeys !== undefined
      ? { observedSignalKeys: args.observedSignalKeys }
      : {}),
    ...(args.activeRead !== undefined ? { activeRead: args.activeRead } : {}),
    updatedAt: args.now,
    version: checkpoint.version + 1,
  });
}

export function assertAutonomyReadAllowed(
  run: Doc<"operationsAutonomyRuns">,
  read: OperationsAutonomyReadTool,
) {
  if (!readToolAllowed(run, read)) {
    autonomyBoundaryError(
      "OPERATIONS_AUTONOMY_READ_DENIED",
      "That read is not authorized by the frozen autonomy policy.",
    );
  }
}
