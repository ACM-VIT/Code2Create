import { v } from "convex/values";

import {
  operationsHealthArea,
  operationsHealthSeverity,
  operationsHealthSignalKey,
} from "./operationsIntelligenceValidators";

export const operationsEpisodeLifecycle = v.union(v.literal("active"), v.literal("terminal"));

export const operationsEpisodeState = v.union(
  v.literal("forming"),
  v.literal("active"),
  v.literal("escalating"),
  v.literal("recovering"),
  v.literal("resolved"),
);

export const operationsEpisodeExpectedState = v.union(
  v.literal("active"),
  v.literal("escalating"),
  v.literal("recovering"),
  v.literal("resolved"),
);

export const operationsEpisodeAnalysisState = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({
    kind: v.literal("dispatching"),
    revision: v.number(),
    attemptId: v.string(),
    startedAt: v.number(),
  }),
  v.object({
    kind: v.literal("accepted"),
    revision: v.number(),
    submissionId: v.string(),
    acceptedAt: v.number(),
  }),
  v.object({ kind: v.literal("ready"), revision: v.number() }),
  v.object({ kind: v.literal("failed"), revision: v.number() }),
);

export const operationsIntelligenceFact = v.object({
  eventId: v.id("events"),
  factKey: v.string(),
  source: v.literal("operations_health"),
  correlationKey: v.string(),
  signalKey: operationsHealthSignalKey,
  area: operationsHealthArea,
  severity: operationsHealthSeverity,
  title: v.string(),
  detail: v.string(),
  owner: v.string(),
  nextAction: v.string(),
  count: v.number(),
  atLeast: v.boolean(),
  occurredAt: v.number(),
  observedAt: v.number(),
  checksum: v.string(),
});

export const operationsEpisodeHypothesisStance = v.union(
  v.literal("leading"),
  v.literal("alternative"),
  v.literal("rejected"),
);

export const operationsEpisodePredictionOutcome = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({
    kind: v.union(v.literal("confirmed"), v.literal("disconfirmed"), v.literal("expired")),
    actualState: operationsEpisodeExpectedState,
    resolvedAt: v.number(),
    brierScore: v.number(),
  }),
);
