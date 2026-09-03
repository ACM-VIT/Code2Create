import type {
  AdmissionIntelligenceReadName,
  OperationsIntelligenceReadName,
} from "./intelligenceReads.ts";
import type { OperationsAutonomyReadTool } from "./operationsAutonomyPolicy.ts";
import type { SupportCaseCategory } from "./labels.ts";

/** Proposal kinds map to mutations executed under the approving operator's grants. */
export const intelligenceRecommendationKinds = [
  "hold_review_team",
  "page_reserve_reviewer",
  "open_support_case",
  "dismiss_attention_item",
] as const;
export type IntelligenceRecommendationKind = (typeof intelligenceRecommendationKinds)[number];

/** Exact command shapes; there is no generic autonomous action payload. */
export type IntelligenceRecommendationArguments =
  | {
      kind: "hold_review_team";
      teamRoundStateId: string;
      expectedTeamRoundStateVersion: number;
      reason: string;
    }
  | {
      kind: "page_reserve_reviewer";
      missingPanelMemberId: string;
      expectedPanelVersion: number;
      reason: string;
    }
  | {
      kind: "open_support_case";
      category: SupportCaseCategory;
      description: string;
      roundId?: string;
      teamId?: string;
    }
  | {
      kind: "dismiss_attention_item";
      itemId: string;
      expectedItemVersion: number;
      reason: string;
    };

export const intelligenceRecommendationStatuses = [
  "proposed",
  "approved",
  "rejected",
  "superseded",
] as const;
export type IntelligenceRecommendationStatus = (typeof intelligenceRecommendationStatuses)[number];

/** Evidence required for every recommendation. */
export type IntelligenceRecommendationCitation = {
  read: OperationsIntelligenceReadName | AdmissionIntelligenceReadName;
  generatedAt: number;
  keys: string[];
};

/** Autonomous evidence is bound to one exact stored read-page receipt. */
export type OperationsAutonomyRecommendationCitation = Omit<
  IntelligenceRecommendationCitation,
  "read"
> & {
  read: OperationsAutonomyReadTool;
  operationId: string;
  snapshot: string;
};
