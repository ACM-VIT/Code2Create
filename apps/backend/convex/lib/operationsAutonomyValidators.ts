import {
  intelligenceRecommendationKinds,
  operationsAutonomyModes,
  operationsAutonomyReadTools,
  operationsAutonomyRunPhases,
  operationsAutonomyRunStates,
  operationsAutonomyTriggers,
  operationsHealthSignalKeys,
} from "@code2create/domain";
import { v } from "convex/values";

import {
  operationsHealthArea,
  operationsHealthSeverity,
  operationsHealthSnapshot,
} from "./operationsIntelligenceValidators";

export const operationsAutonomyMode = v.union(
  ...operationsAutonomyModes.map((value) => v.literal(value)),
);

export const operationsAutonomyTrigger = v.union(
  ...operationsAutonomyTriggers.map((value) => v.literal(value)),
);

export const operationsAutonomyReadTool = v.union(
  ...operationsAutonomyReadTools.map((value) => v.literal(value)),
);

export const operationsAutonomyRecommendationKind = v.union(
  ...intelligenceRecommendationKinds.map((value) => v.literal(value)),
);

export const operationsAutonomyRunState = v.union(
  ...operationsAutonomyRunStates.map((value) => v.literal(value)),
);

export const operationsAutonomyRunPhase = v.union(
  ...operationsAutonomyRunPhases.map((value) => v.literal(value)),
);

export const operationsAutonomySignalKey = v.union(
  ...operationsHealthSignalKeys.map((value) => v.literal(value)),
);

export const operationsAutonomyFailureCode = v.union(
  v.literal("provider_failed"),
  v.literal("tool_failed"),
  v.literal("policy_violation"),
  v.literal("callback_rejected"),
);

export const operationsAutonomyEscalationSeverity = v.union(
  v.literal("attention"),
  v.literal("critical"),
);

export const operationsAutonomyPolicyInput = v.object({
  enabled: v.boolean(),
  mode: operationsAutonomyMode,
  scheduleIntervalMinutes: v.number(),
  triggerSeverities: v.array(operationsHealthSeverity),
  triggerAreas: v.array(operationsHealthArea),
  escalationSeverity: operationsAutonomyEscalationSeverity,
  allowedReadTools: v.array(operationsAutonomyReadTool),
  allowedRecommendationKinds: v.array(operationsAutonomyRecommendationKind),
  accountableOwnerEventAccessSubjectId: v.id("eventAccessSubjects"),
  audience: v.literal("operations_dashboard"),
});

export const operationsAutonomySourceSnapshot = operationsHealthSnapshot;
