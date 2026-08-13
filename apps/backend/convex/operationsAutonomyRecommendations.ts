import {
  operationsIntelligenceProtocolVersion,
  type OperationsAutonomyRecommendationReceipt,
  type OperationsAutonomyRecommendationRequest,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { insertIntelligenceRecommendation } from "./intelligenceRecommendations";
import { cancelAutonomyRun } from "./lib/operationsAutonomyCancellation";
import {
  autonomyOperationFingerprint,
  nextAutonomySequence,
  patchAutonomyCheckpoint,
  requireAutonomyBoundary,
} from "./lib/operationsAutonomyLedger";
import { operationsAutonomyRecommendationEvidenceSeal } from "./lib/intelligenceRecommendationValidators";
import {
  requiredRecommendationTarget,
  requireGroundedAutonomyCitation,
  requireGroundedRecommendationTarget,
} from "./lib/operationsAutonomyRecommendationGrounding";
import { supportCaseCategory } from "./values";

export const autonomyRecommendationRequest = v.object({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  runId: v.string(),
  policyVersionId: v.string(),
  policyChecksum: v.string(),
  sourceChecksum: v.string(),
  operationId: v.string(),
  proposalKey: v.string(),
  eventSlug: v.string(),
  agentVersion: v.string(),
  model: v.string(),
  statement: v.string(),
  reasoning: v.string(),
  evidenceSet: operationsAutonomyRecommendationEvidenceSeal,
  targetCitationIdentity: v.optional(v.string()),
  arguments: v.union(
    v.object({
      kind: v.literal("hold_review_team"),
      teamRoundStateId: v.string(),
      expectedTeamRoundStateVersion: v.number(),
      reason: v.string(),
    }),
    v.object({
      kind: v.literal("page_reserve_reviewer"),
      missingPanelMemberId: v.string(),
      expectedPanelVersion: v.number(),
      reason: v.string(),
    }),
    v.object({
      kind: v.literal("open_support_case"),
      category: supportCaseCategory,
      description: v.string(),
      roundId: v.optional(v.string()),
      teamId: v.optional(v.string()),
    }),
    v.object({
      kind: v.literal("dismiss_attention_item"),
      itemId: v.string(),
      expectedItemVersion: v.number(),
      reason: v.string(),
    }),
  ),
});

function sameSeal(
  left: OperationsAutonomyRecommendationRequest["evidenceSet"],
  right: OperationsAutonomyRecommendationRequest["evidenceSet"],
) {
  return left.evidenceSetId === right.evidenceSetId &&
    left.rootHash === right.rootHash &&
    left.leafCount === right.leafCount &&
    left.chunkCount === right.chunkCount &&
    left.sealedSequence === right.sealedSequence;
}

export const proposeRecommendation = internalMutation({
  args: { request: autonomyRecommendationRequest, now: v.number() },
  returns: v.union(
    v.object({ state: v.literal("accepted"), responseJson: v.string() }),
    v.object({ state: v.literal("rejected"), code: v.literal("authority_revoked") }),
  ),
  handler: async (ctx, args) => {
    const request: OperationsAutonomyRecommendationRequest = args.request;
    const fingerprint = autonomyOperationFingerprint(request);
    const boundary = await requireAutonomyBoundary(ctx, {
      ...request,
      kind: "proposal",
      fingerprint,
      now: args.now,
    });
    if (boundary.state === "replay") {
      if (boundary.prior.kind !== "proposal") {
        throw new Error("The autonomy proposal receipt is corrupt.");
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
    if (
      boundary.run.mode !== "recommend" ||
      !boundary.run.allowedRecommendationKinds.includes(request.arguments.kind) ||
      request.eventSlug !== boundary.authority.event.slug
    ) {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_RECOMMENDATION_DENIED",
        message: "That recommendation is not authorized by the frozen autonomy policy.",
      });
    }
    if (boundary.run.executor.kind === "known") {
      if (
        boundary.run.executor.agentVersion !== request.agentVersion ||
        boundary.run.executor.model !== request.model
      ) throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_EXECUTOR_CONFLICT",
        message: "The autonomy executor identity changed during the run.",
      });
    } else {
      await ctx.db.patch(boundary.run._id, {
        executor: { kind: "known", agentVersion: request.agentVersion, model: request.model },
        updatedAt: args.now,
        version: boundary.run.version + 1,
      });
    }
    const evidenceSet = await ctx.db
      .query("operationsAutonomyRecommendationEvidenceSets")
      .withIndex("by_run_set", (index) =>
        index
          .eq("runId", boundary.run._id)
          .eq("evidenceSetId", request.evidenceSet.evidenceSetId),
      )
      .unique();
    const terminalReceipt = await ctx.db
      .query("operationsAutonomyOperationReceipts")
      .withIndex("by_run_sequence", (index) =>
        index
          .eq("runId", boundary.run._id)
          .eq("sequence", request.evidenceSet.sealedSequence),
      )
      .unique();
    const terminalChunk = await ctx.db
      .query("operationsAutonomyRecommendationEvidenceChunks")
      .withIndex("by_run_set_page", (index) =>
        index
          .eq("runId", boundary.run._id)
          .eq("evidenceSetId", request.evidenceSet.evidenceSetId)
          .eq("pageIndex", request.evidenceSet.chunkCount - 1),
      )
      .unique();
    if (
      !evidenceSet ||
      evidenceSet.proposalKey !== request.proposalKey ||
      evidenceSet.lifecycle.kind !== "sealed" ||
      !sameSeal(evidenceSet.lifecycle.seal, request.evidenceSet) ||
      !terminalReceipt ||
      terminalReceipt.kind !== "recommendation_support" ||
      terminalReceipt.evidenceSetId !== request.evidenceSet.evidenceSetId ||
      terminalReceipt.pageHash !== request.evidenceSet.rootHash ||
      !terminalChunk ||
      !terminalChunk.isDone ||
      terminalChunk.pageHash !== request.evidenceSet.rootHash
    ) {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_EVIDENCE_SEAL_INVALID",
        message: "The recommendation does not reference the exact current sealed evidence set.",
      });
    }
    const requiredTarget = requiredRecommendationTarget(request.arguments);
    if (requiredTarget !== null && request.targetCitationIdentity === undefined) {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_TARGET_UNGROUNDED",
        message: "The recommendation must designate its exact target evidence leaf.",
      });
    }
    if (request.targetCitationIdentity !== undefined) {
      const targetLeaf = await ctx.db
        .query("operationsAutonomyRecommendationEvidenceLeaves")
        .withIndex("by_run_set_identity", (index) =>
          index
            .eq("runId", boundary.run._id)
            .eq("evidenceSetId", request.evidenceSet.evidenceSetId)
            .eq("identity", request.targetCitationIdentity ?? ""),
        )
        .unique();
      if (!targetLeaf) {
        throw new ConvexError({
          code: "OPERATIONS_AUTONOMY_TARGET_UNGROUNDED",
          message: "The designated target evidence leaf is absent from the sealed set.",
        });
      }
      await requireGroundedAutonomyCitation(ctx, {
        runId: boundary.run._id,
        citation: targetLeaf.citation,
      });
      await requireGroundedRecommendationTarget(ctx, {
        runId: boundary.run._id,
        citation: targetLeaf.citation,
        recommendation: request.arguments,
      });
    }
    const result = await insertIntelligenceRecommendation(ctx, {
      event: boundary.authority.event,
      provenance: {
        kind: "autonomy",
        runId: boundary.run._id,
        evidenceSet: request.evidenceSet,
      },
      proposal: {
        proposalKey: request.proposalKey,
        agentVersion: request.agentVersion,
        model: request.model,
        statement: request.statement,
        reasoning: request.reasoning,
        arguments: request.arguments,
      },
      now: args.now,
    });
    if (result.state !== "accepted" && result.state !== "already_exists") {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_RECOMMENDATION_REJECTED",
        message: `The recommendation was rejected: ${result.state}.`,
      });
    }
    const sequence = await nextAutonomySequence(ctx, boundary.checkpoint);
    const receipt: OperationsAutonomyRecommendationReceipt = {
      state: "accepted",
      sequence,
      recommendationId: result.recommendationId,
    };
    const responseJson = JSON.stringify(receipt);
    await ctx.db.insert("operationsAutonomyOperationReceipts", {
      eventId: boundary.run.eventId,
      runId: boundary.run._id,
      operationId: boundary.operationId,
      sequence,
      fingerprint,
      kind: "proposal",
      recommendationId: result.recommendationId,
      responseJson,
      createdAt: args.now,
    });
    await patchAutonomyCheckpoint(ctx, boundary.checkpoint, {
      sequence,
      toolCallsUsed: boundary.checkpoint.toolCallsUsed + 1,
      recommendationsProposed: boundary.checkpoint.recommendationsProposed + 1,
      now: args.now,
    });
    return { state: "accepted" as const, responseJson };
  },
});
