import type { OperationsHealthArea, OperationsHealthSeverity } from "./operationsHealth.ts";
import type { IntelligenceRecommendationKind } from "./intelligenceRecommendations.ts";

/** A scheduled autonomy run is distinct from an operator's private copilot turn. */
export const operationsAutonomyTriggers = ["manual", "schedule", "signal"] as const;
export type OperationsAutonomyTrigger = (typeof operationsAutonomyTriggers)[number];

export const operationsAutonomyModes = ["observe", "recommend"] as const;
export type OperationsAutonomyMode = (typeof operationsAutonomyModes)[number];

/** The schedule controls when work begins; it never limits how much work a run may do. */
export const operationsAutonomyScheduleIntervalMinutes = {
  minimum: 1,
  maximum: 60,
} as const;

/** Recommendation history is conversation-private and is never an autonomous read. */
export const operationsAutonomyReadTools = [
  "operations_health",
  "operations_attention",
  "review_rounds",
  "review_exceptions",
  "attendance_counts",
  "support_load",
  "intake_jobs",
  "admission_jobs",
  "participant_deliveries",
  "integration_jobs",
  "round_export_jobs",
  "synesthesia_operations",
  "incident_readiness",
  "attendance_operations",
] as const;
export type OperationsAutonomyReadTool = (typeof operationsAutonomyReadTools)[number];

export type OperationsAutonomyPolicyConfiguration = {
  enabled: boolean;
  mode: OperationsAutonomyMode;
  scheduleIntervalMinutes: number;
  triggerSeverities: OperationsHealthSeverity[];
  triggerAreas: OperationsHealthArea[];
  escalationSeverity: Exclude<OperationsHealthSeverity, "watch">;
  allowedReadTools: OperationsAutonomyReadTool[];
  allowedRecommendationKinds: IntelligenceRecommendationKind[];
  accountableOwnerEventAccessSubjectId: string;
  audience: "operations_dashboard";
};

export type OperationsAutonomyFrozenPolicy = {
  policyVersionId: string;
  policyVersion: number;
  policyChecksum: string;
  mode: OperationsAutonomyMode;
  escalationSeverity: Exclude<OperationsHealthSeverity, "watch">;
  allowedReadTools: OperationsAutonomyReadTool[];
  allowedRecommendationKinds: IntelligenceRecommendationKind[];
};
