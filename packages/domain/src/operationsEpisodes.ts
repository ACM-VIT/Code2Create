import type {
  OperationsHealthArea,
  OperationsHealthSeverity,
  OperationsHealthSignalKey,
} from "./operationsHealth.ts";
import { operationsIntelligenceProtocolVersion } from "./intelligenceProtocol.ts";

export const operationsEpisodeIngressSignatureContext =
  "code2create.operations-episode.ingress.v1";
export const operationsEpisodeReadSignatureContext =
  "code2create.operations-episode.read.v1";
export const operationsEpisodeCallbackSignatureContext =
  "code2create.operations-episode.callback.v1";

export const operationsEpisodeStates = [
  "forming",
  "active",
  "escalating",
  "recovering",
  "resolved",
] as const;
export type OperationsEpisodeState = (typeof operationsEpisodeStates)[number];

export const operationsEpisodeExpectedStates = [
  "active",
  "escalating",
  "recovering",
  "resolved",
] as const;
export type OperationsEpisodeExpectedState =
  (typeof operationsEpisodeExpectedStates)[number];

export type OperationsEpisodeDispatchRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  episodeId: string;
  eventId: string;
  revision: number;
};

export type OperationsEpisodeReadRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  episodeId: string;
  operationId: string;
};

export type OperationsEpisodeFactProjection = {
  factKey: string;
  signalKey: OperationsHealthSignalKey;
  area: OperationsHealthArea;
  severity: OperationsHealthSeverity;
  title: string;
  detail: string;
  count: number;
  atLeast: boolean;
  observedAt: number;
};

export type OperationsEpisodeProjection = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  episodeId: string;
  eventId: string;
  revision: number;
  correlationKey: string;
  state: Exclude<OperationsEpisodeState, "resolved">;
  severity: OperationsHealthSeverity;
  title: string;
  summary: string;
  owner: string;
  nextAction: string;
  firstObservedAt: number;
  lastObservedAt: number;
  relevanceScore: number;
  confidence: number;
  facts: OperationsEpisodeFactProjection[];
};

export type OperationsEpisodeHypothesisInput = {
  stance: "leading" | "alternative" | "rejected";
  statement: string;
  confidence: number;
  evidenceFactKeys: string[];
};

export type OperationsEpisodePredictionInput = {
  statement: string;
  expectedState: OperationsEpisodeExpectedState;
  probability: number;
  horizonAt: number;
  evidenceFactKeys: string[];
};

export type OperationsEpisodeCounterfactualInput = {
  intervention: string;
  expectedState: OperationsEpisodeExpectedState;
  probability: number;
  rationale: string;
  evidenceFactKeys: string[];
};

export type OperationsEpisodeAnalysisCallback = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  episodeId: string;
  revision: number;
  operationId: string;
  summary: string;
  confidence: number;
  suggestedAction: string;
  hypotheses: OperationsEpisodeHypothesisInput[];
  predictions: OperationsEpisodePredictionInput[];
  counterfactuals: OperationsEpisodeCounterfactualInput[];
  agentVersion: string;
  model: string;
  completedAt: number;
};
