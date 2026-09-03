import { applicationDecisions, operationsIntelligenceProtocolVersion } from "@code2create/domain";
import * as v from "valibot";

const bounded = (minimum: number, maximum: number) =>
  v.pipe(v.string(), v.trim(), v.minLength(minimum), v.maxLength(maximum));

const identifier = bounded(1, 200);

export const ideaIntelligenceInitialDataSchema = v.strictObject({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  applicationId: identifier,
  eventId: identifier,
});

export const ideaIntelligenceDispatchSchema = v.strictObject({
  ...ideaIntelligenceInitialDataSchema.entries,
  recommendationId: identifier,
  modelId: bounded(1, 120),
  promptVersion: bounded(1, 80),
  schemaVersion: bounded(1, 80),
  evaluationSuiteVersion: bounded(1, 80),
  contentVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const sourceSchema = v.strictObject({
  sourceRef: bounded(1, 80),
  question: v.optional(bounded(1, 400)),
  answer: v.optional(bounded(1, 4_000)),
});

const criterionSchema = v.strictObject({
  criterionKey: bounded(1, 80),
  label: bounded(1, 160),
  guidance: bounded(1, 1_000),
});

export const ideaIntelligenceProjectionSchema = v.strictObject({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  recommendationId: identifier,
  applicationId: identifier,
  eventId: identifier,
  modelId: bounded(1, 120),
  promptVersion: bounded(1, 80),
  schemaVersion: bounded(1, 80),
  evaluationSuiteVersion: bounded(1, 80),
  contentVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  sourceInputFingerprint: bounded(1, 240),
  experienceBand: v.picklist([
    "first_year",
    "early_year",
    "later_year",
    "postgraduate_or_professional",
    "mixed_or_external",
  ]),
  sources: v.pipe(v.array(sourceSchema), v.minLength(1), v.maxLength(16)),
  criteria: v.pipe(v.array(criterionSchema), v.minLength(1), v.maxLength(12)),
});

const sourceRefsSchema = v.pipe(v.array(bounded(1, 80)), v.minLength(1), v.maxLength(2));

export const ideaIntelligenceAnalysisSchema = v.strictObject({
  recommendation: v.picklist(applicationDecisions),
  criterionAssessments: v.pipe(
    v.array(
      v.strictObject({
        criterionKey: bounded(1, 80),
        assessment: v.picklist(["meets", "partly_meets", "not_yet_clear"]),
        sourceRefs: sourceRefsSchema,
      }),
    ),
    v.minLength(1),
    v.maxLength(12),
  ),
  strengths: v.pipe(v.array(bounded(3, 180)), v.maxLength(3)),
  concerns: v.pipe(v.array(bounded(3, 180)), v.maxLength(3)),
  proposedQuestions: v.pipe(v.array(bounded(8, 180)), v.maxLength(2)),
  confidence: v.picklist(["low", "medium", "high"]),
  limitations: v.pipe(v.array(bounded(3, 180)), v.maxLength(3)),
});

export const ideaIntelligenceStateDataSchema = v.strictObject({
  applicationId: identifier,
  recommendationId: identifier,
  contentVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  phase: v.picklist(["hydrating", "analyzing", "publishing", "complete"]),
});

export const ideaIntelligenceAnalysisDataSchema = v.strictObject({
  applicationId: identifier,
  recommendationId: identifier,
  contentVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  analysis: ideaIntelligenceAnalysisSchema,
});

export type IdeaIntelligenceInitialData = v.InferOutput<typeof ideaIntelligenceInitialDataSchema>;
export type IdeaIntelligenceProjection = v.InferOutput<typeof ideaIntelligenceProjectionSchema>;
export type IdeaIntelligenceAnalysis = v.InferOutput<typeof ideaIntelligenceAnalysisSchema>;
