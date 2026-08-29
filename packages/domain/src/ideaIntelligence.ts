import type { AdmissionExperienceBand, ApplicationDecision, CriterionAssessment } from "./labels.ts";
import { operationsIntelligenceProtocolVersion } from "./intelligenceProtocol.ts";

export const ideaIntelligenceIngressSignatureContext =
  "code2create.idea-intelligence.ingress.v1";
export const ideaIntelligenceReadSignatureContext =
  "code2create.idea-intelligence.read.v1";
export const ideaIntelligenceCallbackSignatureContext =
  "code2create.idea-intelligence.callback.v1";

export type IdeaIntelligenceDispatchRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  recommendationId: string;
  applicationId: string;
  eventId: string;
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
  skipped?: boolean;
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
  recommendation: ApplicationDecision;
  criterionAssessments: IdeaIntelligenceCriterionAssessment[];
  strengths: string[];
  concerns: string[];
  proposedQuestions: string[];
  confidence: "low" | "medium" | "high";
  limitations: string[];
};

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
