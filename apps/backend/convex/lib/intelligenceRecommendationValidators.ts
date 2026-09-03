import { v } from "convex/values";

import { supportCaseCategory } from "../values";
import { operationsAutonomyReadTool } from "./operationsAutonomyValidators";

export const intelligenceReadName = v.union(
  v.literal("operations_health"),
  v.literal("operations_attention"),
  v.literal("review_rounds"),
  v.literal("review_exceptions"),
  v.literal("attendance_counts"),
  v.literal("support_load"),
  v.literal("recommendation_history"),
  v.literal("admission_cohort"),
  v.literal("admission_submission_search"),
);

export const intelligenceRecommendationStatus = v.union(
  v.literal("proposed"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("superseded"),
);

export const intelligenceRecommendationCitation = v.object({
  read: intelligenceReadName,
  generatedAt: v.number(),
  keys: v.array(v.string()),
});

export const operationsAutonomyRecommendationCitation = v.object({
  read: operationsAutonomyReadTool,
  generatedAt: v.number(),
  keys: v.array(v.string()),
  operationId: v.string(),
  snapshot: v.string(),
});

export const operationsAutonomyRecommendationEvidenceSeal = v.object({
  evidenceSetId: v.string(),
  rootHash: v.string(),
  leafCount: v.number(),
  chunkCount: v.number(),
  sealedSequence: v.number(),
});

/**
 * The kind lives inside the arguments union so an argument set can never
 * detach from the kind that gives it meaning. Every arm names the target of
 * one existing operator mutation; there is no free-form arm.
 */
export const intelligenceRecommendationArguments = v.union(
  v.object({
    kind: v.literal("hold_review_team"),
    teamRoundStateId: v.id("teamRoundStates"),
    expectedTeamRoundStateVersion: v.number(),
    reason: v.string(),
  }),
  v.object({
    kind: v.literal("page_reserve_reviewer"),
    missingPanelMemberId: v.id("reviewPanelMembers"),
    expectedPanelVersion: v.number(),
    reason: v.string(),
  }),
  v.object({
    kind: v.literal("open_support_case"),
    category: supportCaseCategory,
    description: v.string(),
    roundId: v.optional(v.id("reviewRounds")),
    teamId: v.optional(v.id("teams")),
  }),
  v.object({
    kind: v.literal("dismiss_attention_item"),
    itemId: v.id("operationsAttentionItems"),
    expectedItemVersion: v.number(),
    reason: v.string(),
  }),
  v.object({
    kind: v.literal("set_admission_minimum_human_reviews"),
    minimumHumanReviews: v.number(),
    releaseVersion: v.string(),
    expectedEventVersion: v.number(),
    expectedBasePolicyId: v.id("admissionPolicyVersions"),
    expectedBasePolicyChecksum: v.string(),
    expectedBaseModelConfigId: v.union(v.null(), v.id("admissionModelConfigVersions")),
    expectedBaseModelChecksum: v.union(v.null(), v.string()),
    baseStatus: v.union(v.literal("draft"), v.literal("published")),
    reason: v.string(),
  }),
);
