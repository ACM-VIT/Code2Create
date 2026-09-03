import {
  operationsAutonomyRecommendationEvidenceLeafIdentityParts,
  type IntelligenceRecommendationArguments,
  type OperationsAutonomyRecommendationCitation,
} from "@code2create/domain";
import { ConvexError } from "convex/values";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { operationFingerprint } from "./operations";

function groundingError(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function keysShareCitationRow(rows: string[][], keys: readonly string[]) {
  return rows.some((row) => keys.every((key) => row.includes(key)));
}

export function autonomyRecommendationCitationIdentity(
  citation: OperationsAutonomyRecommendationCitation,
) {
  return operationFingerprint([
    ...operationsAutonomyRecommendationEvidenceLeafIdentityParts(citation),
  ]);
}

export function requireCanonicalAutonomyCitation(
  citation: OperationsAutonomyRecommendationCitation,
) {
  if (
    citation.keys.length < 1 ||
    citation.keys.length > 16 ||
    citation.keys.some((key) => key.length < 1 || key.length > 200)
  ) {
    groundingError(
      "OPERATIONS_AUTONOMY_CITATION_INVALID",
      "A recommendation evidence citation has invalid row keys.",
    );
  }
  for (let index = 1; index < citation.keys.length; index += 1) {
    const prior = citation.keys[index - 1];
    const current = citation.keys[index];
    if (prior === undefined || current === undefined || prior >= current) {
      groundingError(
        "OPERATIONS_AUTONOMY_CITATION_NONCANONICAL",
        "Recommendation evidence keys must be unique and canonically ordered.",
      );
    }
  }
  return autonomyRecommendationCitationIdentity(citation);
}

export async function requireGroundedAutonomyCitation(
  ctx: QueryCtx | MutationCtx,
  args: {
    runId: Id<"operationsAutonomyRuns">;
    citation: OperationsAutonomyRecommendationCitation;
  },
) {
  const receipt = await ctx.db
    .query("operationsAutonomyOperationReceipts")
    .withIndex("by_run_operation", (index) =>
      index.eq("runId", args.runId).eq("operationId", args.citation.operationId),
    )
    .unique();
  if (
    !receipt ||
    receipt.kind !== "read" ||
    receipt.state !== "completed" ||
    receipt.read !== args.citation.read ||
    receipt.generatedAt !== args.citation.generatedAt ||
    receipt.traversalSnapshot !== args.citation.snapshot ||
    !keysShareCitationRow(receipt.citationRows, args.citation.keys)
  ) {
    groundingError(
      "OPERATIONS_AUTONOMY_CITATION_INVALID",
      "A recommendation evidence citation is not grounded in its exact stored read page and row.",
    );
  }
  return receipt;
}

export function requiredRecommendationTarget(recommendation: IntelligenceRecommendationArguments) {
  switch (recommendation.kind) {
    case "hold_review_team":
      return {
        read: "review_exceptions" as const,
        keys: [
          recommendation.teamRoundStateId,
          String(recommendation.expectedTeamRoundStateVersion),
        ].sort(),
      };
    case "page_reserve_reviewer":
      return {
        read: "review_exceptions" as const,
        keys: [
          recommendation.missingPanelMemberId,
          String(recommendation.expectedPanelVersion),
        ].sort(),
      };
    case "dismiss_attention_item":
      return {
        read: "operations_attention" as const,
        keys: [recommendation.itemId, String(recommendation.expectedItemVersion)].sort(),
      };
    case "open_support_case": {
      const keys = [recommendation.roundId, recommendation.teamId]
        .filter((value): value is string => value !== undefined)
        .sort();
      return keys.length === 0 ? null : { read: null, keys };
    }
  }
}

export async function requireGroundedRecommendationTarget(
  ctx: QueryCtx | MutationCtx,
  args: {
    runId: Id<"operationsAutonomyRuns">;
    citation: OperationsAutonomyRecommendationCitation;
    recommendation: IntelligenceRecommendationArguments;
  },
) {
  const required = requiredRecommendationTarget(args.recommendation);
  if (required === null) return;
  if (
    (required.read !== null && args.citation.read !== required.read) ||
    !required.keys.every((key) => args.citation.keys.includes(key))
  ) {
    groundingError(
      "OPERATIONS_AUTONOMY_TARGET_UNGROUNDED",
      "The designated evidence leaf does not cite the recommendation's exact target and version.",
    );
  }
  const receipt = await requireGroundedAutonomyCitation(ctx, {
    runId: args.runId,
    citation: args.citation,
  });
  if (!keysShareCitationRow(receipt.citationRows, required.keys)) {
    groundingError(
      "OPERATIONS_AUTONOMY_TARGET_UNGROUNDED",
      "The recommendation target and frozen version do not share one cited source row.",
    );
  }
}
