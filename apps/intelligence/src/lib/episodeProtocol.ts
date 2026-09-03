import {
  operationsEpisodeExpectedStates,
  operationsEpisodeStates,
  operationsHealthAreas,
  operationsHealthSeverities,
  operationsHealthSignalKeys,
  operationsIntelligenceProtocolVersion,
} from "@code2create/domain";
import * as v from "valibot";

const bounded = (minimum: number, maximum: number) =>
  v.pipe(v.string(), v.trim(), v.minLength(minimum), v.maxLength(maximum));

export const operationsEpisodeInitialDataSchema = v.strictObject({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  episodeId: bounded(1, 200),
  eventId: bounded(1, 200),
});

export const operationsEpisodeDispatchRequestSchema = v.strictObject({
  ...operationsEpisodeInitialDataSchema.entries,
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const factSchema = v.strictObject({
  factKey: bounded(1, 240),
  signalKey: v.picklist(operationsHealthSignalKeys),
  area: v.picklist(operationsHealthAreas),
  severity: v.picklist(operationsHealthSeverities),
  title: bounded(1, 200),
  detail: bounded(1, 600),
  count: v.pipe(v.number(), v.integer(), v.minValue(0)),
  atLeast: v.boolean(),
  observedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export const operationsEpisodeProjectionSchema = v.strictObject({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  episodeId: bounded(1, 200),
  eventId: bounded(1, 200),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  correlationKey: bounded(1, 120),
  state: v.picklist(operationsEpisodeStates.filter((state) => state !== "resolved")),
  severity: v.picklist(operationsHealthSeverities),
  title: bounded(1, 200),
  summary: bounded(1, 1_000),
  owner: bounded(1, 120),
  nextAction: bounded(1, 400),
  firstObservedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  lastObservedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  relevanceScore: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  facts: v.pipe(v.array(factSchema), v.minLength(1), v.maxLength(16)),
});

const evidenceFactKeysSchema = v.pipe(v.array(bounded(1, 240)), v.minLength(1), v.maxLength(8));

export const operationsEpisodeAnalysisSchema = v.strictObject({
  summary: bounded(12, 600),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  suggestedAction: bounded(8, 300),
  hypotheses: v.pipe(
    v.array(
      v.strictObject({
        stance: v.picklist(["leading", "alternative", "rejected"]),
        statement: bounded(8, 400),
        confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
        evidenceFactKeys: evidenceFactKeysSchema,
      }),
    ),
    v.minLength(1),
    v.maxLength(3),
  ),
  predictions: v.pipe(
    v.array(
      v.strictObject({
        statement: bounded(8, 400),
        expectedState: v.picklist(operationsEpisodeExpectedStates),
        probability: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
        horizonAt: v.pipe(v.number(), v.integer(), v.minValue(1)),
        evidenceFactKeys: evidenceFactKeysSchema,
      }),
    ),
    v.maxLength(3),
  ),
  counterfactuals: v.pipe(
    v.array(
      v.strictObject({
        intervention: bounded(8, 300),
        expectedState: v.picklist(operationsEpisodeExpectedStates),
        probability: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
        rationale: bounded(8, 400),
        evidenceFactKeys: evidenceFactKeysSchema,
      }),
    ),
    v.maxLength(3),
  ),
});

export const operationsEpisodeStateDataSchema = v.strictObject({
  episodeId: bounded(1, 200),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  phase: v.picklist(["hydrating", "analyzing", "publishing", "complete"]),
  state: v.picklist(operationsEpisodeStates.filter((state) => state !== "resolved")),
  severity: v.picklist(operationsHealthSeverities),
  relevanceScore: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
});

export const operationsEpisodeHypothesesDataSchema = v.strictObject({
  episodeId: bounded(1, 200),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  items: operationsEpisodeAnalysisSchema.entries.hypotheses,
});

export const operationsEpisodePredictionsDataSchema = v.strictObject({
  episodeId: bounded(1, 200),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  items: operationsEpisodeAnalysisSchema.entries.predictions,
});

export const operationsEpisodeCounterfactualsDataSchema = v.strictObject({
  episodeId: bounded(1, 200),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  items: operationsEpisodeAnalysisSchema.entries.counterfactuals,
});

export type OperationsEpisodeInitialData = v.InferOutput<typeof operationsEpisodeInitialDataSchema>;
export type OperationsEpisodeProjection = v.InferOutput<typeof operationsEpisodeProjectionSchema>;
export type OperationsEpisodeAnalysis = v.InferOutput<typeof operationsEpisodeAnalysisSchema>;
