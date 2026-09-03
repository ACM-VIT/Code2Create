import { operationsIntelligenceProtocolVersion } from "./intelligenceProtocol.ts";

// Distinct contexts prevent signed bodies replaying across routes.
export const operationsIntelligenceReadSignatureContext =
  "code2create.operations-intelligence.read.v1";

/** Fixed read names accepted at the redacted intelligence boundary. */
export const operationsIntelligenceReadNames = [
  "operations_health",
  "operations_attention",
  "review_rounds",
  "review_exceptions",
  "attendance_counts",
  "floor_mapping_progress",
  "support_load",
  "recommendation_history",
] as const;
export type OperationsIntelligenceReadName = (typeof operationsIntelligenceReadNames)[number];

export type OperationsIntelligenceReadRequest =
  | {
      protocolVersion: typeof operationsIntelligenceProtocolVersion;
      read: Exclude<OperationsIntelligenceReadName, "recommendation_history">;
      eventSlug: string;
    }
  | {
      protocolVersion: typeof operationsIntelligenceProtocolVersion;
      read: "recommendation_history";
      eventSlug: string;
      conversationId: string;
    };

/** Admission reads use a separate route because their redaction contract differs. */
export const admissionIntelligenceReadNames = [
  "admission_cohort",
  "admission_submission_search",
] as const;
export type AdmissionIntelligenceReadName = (typeof admissionIntelligenceReadNames)[number];

export const admissionIntelligenceReadSignatureContext =
  "code2create.admission-intelligence.read.v1";

/** Parameters select within fixed projections; they are not a query language. */
export type AdmissionIntelligenceReadRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  read: AdmissionIntelligenceReadName;
  eventSlug: string;
  capacityPeople?: number;
  query?: string;
  limit?: number;
};
