import type { AdmissionExperienceBand, CriterionAssessment } from "./labels.ts";
import type { operationsIntelligenceProtocolVersion } from "./intelligenceProtocol.ts";

export const ideaIntelligenceIngressSignatureContext = "code2create.idea-intelligence.ingress.v1";
export const ideaIntelligenceReadSignatureContext = "code2create.idea-intelligence.read.v1";
export const ideaIntelligenceCallbackSignatureContext = "code2create.idea-intelligence.callback.v1";
export const ideaIntelligenceSubmissionTimeoutMs = 60 * 60 * 1_000;
export const ideaIntelligenceRecoveryLeaseMs = ideaIntelligenceSubmissionTimeoutMs + 5 * 60 * 1_000;

export const ideaIntelligenceSimilarityBands = ["moderate", "high", "very_high"] as const;
export type IdeaIntelligenceSimilarityBand = (typeof ideaIntelligenceSimilarityBands)[number];

export type IdeaIntelligenceDispatchRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  recommendationId: string;
  applicationId: string;
  eventId: string;
  modelId: string;
  promptVersion: string;
  schemaVersion: string;
  evaluationSuiteVersion: string;
  contentVersion: number;
};

export type IdeaIntelligenceInitialData = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  recommendationId: string;
  applicationId: string;
  eventId: string;
  modelId: string;
};

export type IdeaIntelligenceSource = {
  sourceRef: string;
  question?: string;
  answer?: string;
};

export type IdeaIntelligenceCriterion = {
  criterionKey: string;
  label: string;
  guidance: string;
};

export type IdeaIntelligenceProjection = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  recommendationId: string;
  applicationId: string;
  eventId: string;
  modelId: string;
  promptVersion: string;
  schemaVersion: string;
  evaluationSuiteVersion: string;
  contentVersion: number;
  sourceInputFingerprint: string;
  experienceBand: AdmissionExperienceBand;
  overallParticipantCapacity: number;
  sources: IdeaIntelligenceSource[];
  criteria: IdeaIntelligenceCriterion[];
};

export type IdeaIntelligenceSimilarityRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  operation: "find_similar_ideas";
  recommendationId: string;
  applicationId: string;
  eventId: string;
  contentVersion: number;
  sourceInputFingerprint: string;
  sourceRefs: string[];
  operationId: string;
};

export type IdeaIntelligenceSimilarityMatch = {
  comparisonRef: string;
  similarity: IdeaIntelligenceSimilarityBand;
  summary: string;
};

export type IdeaIntelligenceHistoricalSimilarityMatch = IdeaIntelligenceSimilarityMatch & {
  themeLabel: string;
  sourceYear: number;
};

export type IdeaIntelligenceSimilarityResult = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  recommendationId: string;
  applicationId: string;
  eventId: string;
  contentVersion: number;
  sourceInputFingerprint: string;
  sourceRefs: string[];
  historicalProjectCount: number;
  historicalMatches: IdeaIntelligenceHistoricalSimilarityMatch[];
  currentSubmissionMatches: IdeaIntelligenceSimilarityMatch[];
};

export type IdeaIntelligenceCriterionAssessment = {
  criterionKey: string;
  assessment: CriterionAssessment;
  sourceRefs: string[];
};

export type IdeaIntelligenceCentralProposalConsistency = {
  assessment: "consistent" | "contradictory";
  sourceRefs: string[];
};

export type IdeaIntelligenceAnalysis = {
  recommendation: "accept" | "waitlist" | "decline";
  centralProposalConsistency: IdeaIntelligenceCentralProposalConsistency;
  criterionAssessments: IdeaIntelligenceCriterionAssessment[];
  strengths: string[];
  concerns: string[];
  confidence: "low" | "medium" | "high";
  limitations: string[];
};

export type IdeaIntelligenceAnalysisPolicyViolation =
  | "shape_mismatch"
  | "criterion_mismatch"
  | "evidence_mismatch"
  | "recommendation_mismatch"
  | "prohibited_language";

export function ideaIntelligenceAnalysisPolicyViolation(args: {
  analysis: IdeaIntelligenceAnalysis;
  criterionKeys: readonly string[];
  sourceRefs: readonly string[];
}): IdeaIntelligenceAnalysisPolicyViolation | null {
  const boundedList = (
    values: readonly string[],
    maximumItems: number,
    minimumLength: number,
    maximumLength: number,
  ) =>
    values.length <= maximumItems &&
    values.every((value) => {
      const normalized = value.trim();
      return normalized.length >= minimumLength && normalized.length <= maximumLength;
    });
  if (
    args.analysis.criterionAssessments.length < 1 ||
    args.analysis.criterionAssessments.length > 12 ||
    !boundedList(args.analysis.strengths, 3, 3, 180) ||
    !boundedList(args.analysis.concerns, 3, 3, 180) ||
    !boundedList(args.analysis.limitations, 3, 3, 180)
  ) {
    return "shape_mismatch";
  }

  const expectedCriteria = new Set(args.criterionKeys);
  const actualCriteria = new Set(
    args.analysis.criterionAssessments.map((assessment) => assessment.criterionKey),
  );
  if (
    actualCriteria.size !== args.analysis.criterionAssessments.length ||
    actualCriteria.size !== expectedCriteria.size ||
    [...expectedCriteria].some((key) => !actualCriteria.has(key))
  ) {
    return "criterion_mismatch";
  }

  const availableSources = new Set(args.sourceRefs);
  if (
    args.analysis.centralProposalConsistency.sourceRefs.length < 1 ||
    args.analysis.centralProposalConsistency.sourceRefs.length > 2 ||
    new Set(args.analysis.centralProposalConsistency.sourceRefs).size !==
      args.analysis.centralProposalConsistency.sourceRefs.length ||
    args.analysis.centralProposalConsistency.sourceRefs.some(
      (sourceRef) => !availableSources.has(sourceRef),
    ) ||
    (args.analysis.centralProposalConsistency.assessment === "contradictory" &&
      args.analysis.centralProposalConsistency.sourceRefs.length !== 2) ||
    args.analysis.criterionAssessments.some(
      (assessment) =>
        assessment.sourceRefs.length < 1 ||
        assessment.sourceRefs.length > 2 ||
        new Set(assessment.sourceRefs).size !== assessment.sourceRefs.length ||
        assessment.sourceRefs.some((sourceRef) => !availableSources.has(sourceRef)),
    )
  ) {
    return "evidence_mismatch";
  }

  const partlyMeetsCount = args.analysis.criterionAssessments.filter(
    (assessment) => assessment.assessment === "partly_meets",
  ).length;
  const notYetClearCount = args.analysis.criterionAssessments.filter(
    (assessment) => assessment.assessment === "not_yet_clear",
  ).length;
  const expectedRecommendation =
    args.analysis.centralProposalConsistency.assessment === "contradictory" ||
    notYetClearCount > 0 ||
    partlyMeetsCount > 1
      ? "decline"
      : partlyMeetsCount === 1
        ? "waitlist"
        : "accept";
  if (
    args.analysis.recommendation !== expectedRecommendation ||
    (expectedRecommendation !== "accept" && args.analysis.concerns.length === 0)
  ) {
    return "recommendation_mismatch";
  }

  const prohibitedLanguage =
    /\b(score|scored|points?|ranking|winner|judging|judge score|prestige)\b/iu;
  if (
    [
      ...args.analysis.strengths,
      ...args.analysis.concerns,
      ...args.analysis.limitations,
    ].some((text) => prohibitedLanguage.test(text))
  ) {
    return "prohibited_language";
  }
  return null;
}

export type IdeaIntelligenceCallback = IdeaIntelligenceAnalysis & {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  recommendationId: string;
  applicationId: string;
  contentVersion: number;
  sourceInputFingerprint: string;
  operationId: string;
  agentVersion: string;
  model: string;
  completedAt: number;
};
