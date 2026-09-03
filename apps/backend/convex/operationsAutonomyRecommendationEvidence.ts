import {
  operationsAutonomyRecommendationEvidenceChunkMaximumCitations,
  operationsIntelligenceProtocolVersion,
  type OperationsAutonomyRecommendationEvidenceChunkReceipt,
  type OperationsAutonomyRecommendationEvidenceChunkRequest,
  type OperationsAutonomyRecommendationEvidenceSeal,
} from "@code2create/domain";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { internalMutation, query } from "./_generated/server";
import { cancelAutonomyRun } from "./lib/operationsAutonomyCancellation";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  operationsAutonomyRecommendationCitation,
  operationsAutonomyRecommendationEvidenceSeal,
} from "./lib/intelligenceRecommendationValidators";
import {
  autonomyOperationFingerprint,
  nextAutonomySequence,
  patchAutonomyCheckpoint,
  requireAutonomyBoundary,
} from "./lib/operationsAutonomyLedger";
import { operationFingerprint } from "./lib/operations";
import {
  requireCanonicalAutonomyCitation,
  requireGroundedAutonomyCitation,
} from "./lib/operationsAutonomyRecommendationGrounding";
import { normalizedText } from "./lib/strings";
import { requirePermission } from "./lib/permissions";

const digestPattern = /^[a-f0-9]{64}$/u;
const evidenceIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;
const maximumEvidencePageSize = 20;

const recommendationEvidenceLeafView = v.object({
  ordinal: v.number(),
  identity: v.string(),
  citation: operationsAutonomyRecommendationCitation,
  evidenceSet: operationsAutonomyRecommendationEvidenceSeal,
});

const recommendationEvidenceObservationView = v.object({
  id: v.id("intelligenceRecommendationAutonomyObservations"),
  runId: v.id("operationsAutonomyRuns"),
  evidenceSet: operationsAutonomyRecommendationEvidenceSeal,
  statement: v.string(),
  reasoning: v.string(),
  agentVersion: v.string(),
  model: v.string(),
  observedAt: v.number(),
});

export const autonomyRecommendationEvidenceChunkRequest = v.object({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  runId: v.string(),
  policyVersionId: v.string(),
  policyChecksum: v.string(),
  sourceChecksum: v.string(),
  operationId: v.string(),
  proposalKey: v.string(),
  evidenceSetId: v.string(),
  pageIndex: v.number(),
  previousPageHash: v.optional(v.string()),
  citations: v.array(operationsAutonomyRecommendationCitation),
  isDone: v.boolean(),
});

function evidenceError(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function normalizedEvidenceIdentity(value: string, label: string) {
  const normalized = normalizedText(value, label, 8, 200);
  if (normalized !== value || !evidenceIdentityPattern.test(normalized)) {
    evidenceError(
      "OPERATIONS_AUTONOMY_EVIDENCE_ID_INVALID",
      `${label} is not a canonical evidence identity.`,
    );
  }
  return normalized;
}

function exactOptional(left: string | undefined, right: string | undefined) {
  return left === right;
}

export const appendRecommendationEvidence = internalMutation({
  args: { request: autonomyRecommendationEvidenceChunkRequest, now: v.number() },
  returns: v.union(
    v.object({ state: v.literal("accepted"), responseJson: v.string() }),
    v.object({ state: v.literal("rejected"), code: v.literal("authority_revoked") }),
  ),
  handler: async (ctx, args) => {
    const request: OperationsAutonomyRecommendationEvidenceChunkRequest = args.request;
    const fingerprint = autonomyOperationFingerprint(request);
    const boundary = await requireAutonomyBoundary(ctx, {
      ...request,
      kind: "recommendation_support",
      fingerprint,
      now: args.now,
    });
    if (boundary.state === "replay") {
      if (boundary.prior.kind !== "recommendation_support") {
        throw new Error("The recommendation evidence receipt is corrupt.");
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
    if (boundary.run.mode !== "recommend") {
      evidenceError(
        "OPERATIONS_AUTONOMY_RECOMMENDATION_DENIED",
        "Observe-only autonomy cannot publish recommendation evidence.",
      );
    }
    const proposalKey = normalizedEvidenceIdentity(request.proposalKey, "Proposal key");
    const evidenceSetId = normalizedEvidenceIdentity(request.evidenceSetId, "Evidence set ID");
    if (
      !Number.isSafeInteger(request.pageIndex) ||
      request.pageIndex < 0 ||
      request.citations.length < 1 ||
      request.citations.length > operationsAutonomyRecommendationEvidenceChunkMaximumCitations ||
      (request.previousPageHash !== undefined && !digestPattern.test(request.previousPageHash))
    ) {
      evidenceError(
        "OPERATIONS_AUTONOMY_EVIDENCE_CHUNK_INVALID",
        "The recommendation evidence chunk shape is invalid.",
      );
    }

    const identities: string[] = [];
    for (const citation of request.citations) {
      const identity = requireCanonicalAutonomyCitation(citation);
      await requireGroundedAutonomyCitation(ctx, { runId: boundary.run._id, citation });
      identities.push(identity);
    }
    for (let index = 1; index < identities.length; index += 1) {
      const prior = identities[index - 1];
      const current = identities[index];
      if (prior === undefined || current === undefined || prior >= current) {
        evidenceError(
          "OPERATIONS_AUTONOMY_EVIDENCE_ORDER_INVALID",
          "Evidence leaves must be unique and canonically ordered.",
        );
      }
    }

    const existingSet = await ctx.db
      .query("operationsAutonomyRecommendationEvidenceSets")
      .withIndex("by_run_set", (index) =>
        index.eq("runId", boundary.run._id).eq("evidenceSetId", evidenceSetId),
      )
      .unique();
    const expectedPageIndex =
      existingSet?.lifecycle.kind === "open" ? existingSet.lifecycle.nextPageIndex : 0;
    const expectedPreviousPageHash =
      existingSet?.lifecycle.kind === "open" ? existingSet.lifecycle.lastPageHash : undefined;
    if (
      (existingSet !== null && existingSet.proposalKey !== proposalKey) ||
      existingSet?.lifecycle.kind === "sealed" ||
      request.pageIndex !== expectedPageIndex ||
      !exactOptional(request.previousPageHash, expectedPreviousPageHash)
    ) {
      evidenceError(
        "OPERATIONS_AUTONOMY_EVIDENCE_CHAIN_CONFLICT",
        "The recommendation evidence chunk does not extend the exact current chain.",
      );
    }
    const priorLastLeaf =
      existingSet?.lifecycle.kind === "open" ? existingSet.lifecycle.lastLeafIdentity : undefined;
    const firstIdentity = identities[0];
    const lastIdentity = identities[identities.length - 1];
    if (
      firstIdentity === undefined ||
      lastIdentity === undefined ||
      (priorLastLeaf !== undefined && firstIdentity <= priorLastLeaf)
    ) {
      evidenceError(
        "OPERATIONS_AUTONOMY_EVIDENCE_ORDER_INVALID",
        "The evidence chunk does not extend the canonical leaf order.",
      );
    }
    for (const identity of identities) {
      const duplicate = await ctx.db
        .query("operationsAutonomyRecommendationEvidenceLeaves")
        .withIndex("by_run_set_identity", (index) =>
          index
            .eq("runId", boundary.run._id)
            .eq("evidenceSetId", evidenceSetId)
            .eq("identity", identity),
        )
        .unique();
      if (duplicate) {
        evidenceError(
          "OPERATIONS_AUTONOMY_EVIDENCE_DUPLICATE",
          "An evidence leaf was already appended to this set.",
        );
      }
    }
    const pageCollision = await ctx.db
      .query("operationsAutonomyRecommendationEvidenceChunks")
      .withIndex("by_run_set_page", (index) =>
        index
          .eq("runId", boundary.run._id)
          .eq("evidenceSetId", evidenceSetId)
          .eq("pageIndex", request.pageIndex),
      )
      .unique();
    if (pageCollision) {
      evidenceError(
        "OPERATIONS_AUTONOMY_EVIDENCE_CHAIN_CONFLICT",
        "That evidence page index is already committed.",
      );
    }

    const priorLeafCount =
      existingSet?.lifecycle.kind === "open" ? existingSet.lifecycle.leafCount : 0;
    const priorChunkCount =
      existingSet?.lifecycle.kind === "open" ? existingSet.lifecycle.chunkCount : 0;
    const pageHash = operationFingerprint([
      "operations-autonomy-recommendation-evidence-page-v1",
      evidenceSetId,
      proposalKey,
      request.pageIndex,
      request.previousPageHash ?? null,
      JSON.stringify(identities),
      request.isDone,
    ]);
    const sequence = await nextAutonomySequence(ctx, boundary.checkpoint);
    const leafCount = priorLeafCount + identities.length;
    const chunkCount = priorChunkCount + 1;
    const seal: OperationsAutonomyRecommendationEvidenceSeal | undefined = request.isDone
      ? {
          evidenceSetId,
          rootHash: pageHash,
          leafCount,
          chunkCount,
          sealedSequence: sequence,
        }
      : undefined;
    const receipt: OperationsAutonomyRecommendationEvidenceChunkReceipt = {
      state: "accepted",
      sequence,
      evidenceSetId,
      pageIndex: request.pageIndex,
      pageHash,
      isDone: request.isDone,
      ...(seal === undefined ? {} : { seal }),
    };
    const responseJson = JSON.stringify(receipt);

    if (existingSet === null) {
      await ctx.db.insert("operationsAutonomyRecommendationEvidenceSets", {
        eventId: boundary.run.eventId,
        runId: boundary.run._id,
        proposalKey,
        evidenceSetId,
        lifecycle:
          seal === undefined
            ? {
                kind: "open",
                nextPageIndex: 1,
                lastPageHash: pageHash,
                lastLeafIdentity: lastIdentity,
                leafCount,
                chunkCount,
              }
            : { kind: "sealed", seal },
        createdAt: args.now,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.patch(existingSet._id, {
        lifecycle:
          seal === undefined
            ? {
                kind: "open",
                nextPageIndex: request.pageIndex + 1,
                lastPageHash: pageHash,
                lastLeafIdentity: lastIdentity,
                leafCount,
                chunkCount,
              }
            : { kind: "sealed", seal },
        updatedAt: args.now,
      });
    }
    await ctx.db.insert("operationsAutonomyRecommendationEvidenceChunks", {
      eventId: boundary.run.eventId,
      runId: boundary.run._id,
      evidenceSetId,
      pageIndex: request.pageIndex,
      ...(request.previousPageHash === undefined
        ? {}
        : { previousPageHash: request.previousPageHash }),
      pageHash,
      firstOrdinal: priorLeafCount,
      leafCount: identities.length,
      isDone: request.isDone,
      createdAt: args.now,
    });
    for (let index = 0; index < request.citations.length; index += 1) {
      const citation = request.citations[index];
      const identity = identities[index];
      if (citation === undefined || identity === undefined) {
        throw new Error("The canonical evidence leaf list is corrupt.");
      }
      await ctx.db.insert("operationsAutonomyRecommendationEvidenceLeaves", {
        eventId: boundary.run.eventId,
        runId: boundary.run._id,
        evidenceSetId,
        ordinal: priorLeafCount + index,
        identity,
        citation,
        createdAt: args.now,
      });
    }
    await ctx.db.insert("operationsAutonomyOperationReceipts", {
      eventId: boundary.run.eventId,
      runId: boundary.run._id,
      operationId: boundary.operationId,
      sequence,
      fingerprint,
      kind: "recommendation_support",
      evidenceSetId,
      pageIndex: request.pageIndex,
      pageHash,
      responseJson,
      createdAt: args.now,
    });
    await patchAutonomyCheckpoint(ctx, boundary.checkpoint, {
      sequence,
      now: args.now,
    });
    return { state: "accepted" as const, responseJson };
  },
});

/** Complete immutable autonomy evidence, ordered by the sealed set ordinal. */
export const observations = query({
  args: {
    eventSlug: v.string(),
    recommendationId: v.id("intelligenceRecommendations"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(recommendationEvidenceObservationView),
  handler: async (ctx, args) => {
    if (
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > maximumEvidencePageSize
    ) {
      throw new ConvexError({
        code: "INVALID_PAGE_SIZE",
        message: `Recommendation observation pages must contain between 1 and ${maximumEvidencePageSize} rows.`,
      });
    }
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "operations.intelligence.read",
      scopeType: "event",
    });
    const recommendation = await ctx.db.get(args.recommendationId);
    if (!recommendation || recommendation.eventId !== event._id) {
      throw new ConvexError({
        code: "RECOMMENDATION_EVIDENCE_NOT_FOUND",
        message: "That autonomous recommendation does not exist.",
      });
    }
    const result = await ctx.db
      .query("intelligenceRecommendationAutonomyObservations")
      .withIndex("by_recommendation_observed_at", (index) =>
        index.eq("recommendationId", recommendation._id),
      )
      .order("asc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((observation) => ({
        id: observation._id,
        runId: observation.runId,
        evidenceSet: observation.evidenceSet,
        statement: observation.statement,
        reasoning: observation.reasoning,
        agentVersion: observation.agentVersion,
        model: observation.model,
        observedAt: observation.observedAt,
      })),
    };
  },
});

export const page = query({
  args: {
    eventSlug: v.string(),
    recommendationId: v.id("intelligenceRecommendations"),
    observationId: v.id("intelligenceRecommendationAutonomyObservations"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(recommendationEvidenceLeafView),
  handler: async (ctx, args) => {
    if (
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > maximumEvidencePageSize
    ) {
      throw new ConvexError({
        code: "INVALID_PAGE_SIZE",
        message: `Recommendation evidence pages must contain between 1 and ${maximumEvidencePageSize} leaves.`,
      });
    }
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "operations.intelligence.read",
      scopeType: "event",
    });
    const [recommendation, observation] = await Promise.all([
      ctx.db.get(args.recommendationId),
      ctx.db.get(args.observationId),
    ]);
    if (
      !recommendation ||
      recommendation.eventId !== event._id ||
      !observation ||
      observation.eventId !== event._id ||
      observation.recommendationId !== recommendation._id
    ) {
      throw new ConvexError({
        code: "RECOMMENDATION_EVIDENCE_NOT_FOUND",
        message: "That autonomous recommendation evidence set does not exist.",
      });
    }
    const seal = observation.evidenceSet;
    const result = await ctx.db
      .query("operationsAutonomyRecommendationEvidenceLeaves")
      .withIndex("by_run_set_ordinal", (index) =>
        index.eq("runId", observation.runId).eq("evidenceSetId", seal.evidenceSetId),
      )
      .order("asc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((leaf) => ({
        ordinal: leaf.ordinal,
        identity: leaf.identity,
        citation: leaf.citation,
        evidenceSet: seal,
      })),
    };
  },
});
