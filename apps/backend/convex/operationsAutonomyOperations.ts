import {
  operationsIntelligenceProtocolVersion,
  type OperationsAutonomyWorkReceipt,
  type OperationsAutonomyWorkRequest,
} from "@code2create/domain";
import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { cancelAutonomyRun } from "./lib/operationsAutonomyCancellation";
import {
  autonomyOperationFingerprint,
  nextAutonomySequence,
  patchAutonomyCheckpoint,
  requireAutonomyBoundary,
} from "./lib/operationsAutonomyLedger";
import { operationsHealthArea } from "./lib/operationsIntelligenceValidators";

const workRequest = v.object({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  runId: v.string(),
  policyVersionId: v.string(),
  policyChecksum: v.string(),
  sourceChecksum: v.string(),
  operationId: v.string(),
  operation: v.union(
    v.object({ kind: v.literal("model") }),
    v.object({ kind: v.literal("delegation"), area: operationsHealthArea }),
  ),
});

export const authorizeWork = internalMutation({
  args: { request: workRequest, now: v.number() },
  returns: v.union(
    v.object({ state: v.literal("accepted"), responseJson: v.string() }),
    v.object({ state: v.literal("rejected"), code: v.literal("authority_revoked") }),
  ),
  handler: async (ctx, args) => {
    const request: OperationsAutonomyWorkRequest = args.request;
    const fingerprint = autonomyOperationFingerprint(request);
    const boundary = await requireAutonomyBoundary(ctx, {
      ...request,
      kind: "work",
      fingerprint,
      now: args.now,
    });
    if (boundary.state === "replay") {
      if (boundary.prior.kind !== "work") {
        throw new Error("The autonomy work receipt is corrupt.");
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
    const sequence = await nextAutonomySequence(ctx, boundary.checkpoint);
    const receipt: OperationsAutonomyWorkReceipt = { state: "accepted", sequence };
    const responseJson = JSON.stringify(receipt);
    await ctx.db.insert("operationsAutonomyOperationReceipts", {
      eventId: boundary.run.eventId,
      runId: boundary.run._id,
      operationId: boundary.operationId,
      sequence,
      fingerprint,
      kind: "work",
      responseJson,
      createdAt: args.now,
    });
    await patchAutonomyCheckpoint(ctx, boundary.checkpoint, {
      sequence,
      ...(request.operation.kind === "delegation"
        ? { delegationsUsed: boundary.checkpoint.delegationsUsed + 1 }
        : {}),
      now: args.now,
    });
    return { state: "accepted" as const, responseJson };
  },
});
