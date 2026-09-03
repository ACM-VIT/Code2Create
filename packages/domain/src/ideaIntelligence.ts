import type { AdmissionExperienceBand, CriterionAssessment } from "./labels.ts";
import { operationsIntelligenceProtocolVersion } from "./intelligenceProtocol.ts";

export const ideaIntelligenceIngressSignatureContext = "code2create.idea-intelligence.ingress.v1";
export const ideaIntelligenceReadSignatureContext = "code2create.idea-intelligence.read.v1";
export const ideaIntelligenceCallbackSignatureContext = "code2create.idea-intelligence.callback.v1";
export const ideaIntelligenceRecoveryLeaseMs = 70 * 60 * 1_000;

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
  applicationId: string;
  eventId: string;
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
  sources: IdeaIntelligenceSource[];
  criteria: IdeaIntelligenceCriterion[];
};

export type IdeaIntelligenceCriterionAssessment = {
  criterionKey: string;
  assessment: CriterionAssessment;
  sourceRefs: string[];
};

export type IdeaIntelligenceAnalysis = {
  recommendation: "accept" | "waitlist" | "decline" | "needs_information";
  criterionAssessments: IdeaIntelligenceCriterionAssessment[];
  strengths: string[];
  concerns: string[];
  proposedQuestions: string[];
  confidence: "low" | "medium" | "high";
  limitations: string[];
};

export type IdeaIntelligenceAnalysisPolicyViolation =
  | "shape_mismatch"
  | "criterion_mismatch"
  | "evidence_mismatch"
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
    !boundedList(args.analysis.proposedQuestions, 2, 8, 180) ||
    !boundedList(args.analysis.limitations, 3, 3, 180)
  )
    return "shape_mismatch";

  const expectedCriteria = new Set(args.criterionKeys);
  const actualCriteria = new Set(
    args.analysis.criterionAssessments.map((assessment) => assessment.criterionKey),
  );
  if (
    actualCriteria.size !== args.analysis.criterionAssessments.length ||
    actualCriteria.size !== expectedCriteria.size ||
    [...expectedCriteria].some((key) => !actualCriteria.has(key))
  )
    return "criterion_mismatch";

  const availableSources = new Set(args.sourceRefs);
  if (
    args.analysis.criterionAssessments.some(
      (assessment) =>
        assessment.sourceRefs.length < 1 ||
        assessment.sourceRefs.length > 2 ||
        new Set(assessment.sourceRefs).size !== assessment.sourceRefs.length ||
        assessment.sourceRefs.some((sourceRef) => !availableSources.has(sourceRef)),
    )
  )
    return "evidence_mismatch";

  const prohibitedLanguage =
    /\b(score|scored|points?|ranking|winner|judging|judge score|prestige)\b/iu;
  if (
    [
      ...args.analysis.strengths,
      ...args.analysis.concerns,
      ...args.analysis.proposedQuestions,
      ...args.analysis.limitations,
    ].some((text) => prohibitedLanguage.test(text))
  )
    return "prohibited_language";
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
