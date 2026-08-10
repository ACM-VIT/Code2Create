import { v } from "convex/values";

import { supportCaseCategory } from "../values";

export const intelligenceReadName = v.union(
  v.literal("operations_health"),
  v.literal("operations_attention"),
  v.literal("review_rounds"),
  v.literal("review_exceptions"),
  v.literal("attendance_counts"),
  v.literal("floor_mapping_progress"),
  v.literal("support_load"),
  v.literal("recommendation_history"),
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

/**
 * The kind lives inside the arguments union so an argument set can never
 * detach from the kind that gives it meaning. Every arm names the target of
 * one existing operator mutation; there is no free-form arm.
 */
export const intelligenceRecommendationArguments = v.union(
  v.object({
    kind: v.literal("hold_review_team"),
    teamRoundStateId: v.id("teamRoundStates"),
    reason: v.string(),
  }),
  v.object({
    kind: v.literal("page_reserve_reviewer"),
    missingPanelMemberId: v.id("reviewPanelMembers"),
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
    reason: v.string(),
  }),
);
