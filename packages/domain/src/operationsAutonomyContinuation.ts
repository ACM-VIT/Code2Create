import type { operationsIntelligenceProtocolVersion } from "./intelligenceProtocol.ts";
import type { OperationsAutonomyTurnReceipt } from "./operationsAutonomyProtocol.ts";

/** A new durable Worker submission resumes one run after an infrastructure slice settles. */
export const operationsAutonomyContinuationSignatureContext =
  "code2create.operations-autonomy.continuation.v1";

export type OperationsAutonomyContinuationRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  runId: string;
  /** Stable callback identity that caused the backend-owned continuation work item. */
  operationId: string;
  /** The preceding Flue submission must have settled before another submission is dispatched. */
  priorSubmissionId: string;
  /** Stable idempotency key allocated and persisted by Convex. */
  workItemId: string;
};

export type OperationsAutonomyContinuationReceipt = OperationsAutonomyTurnReceipt;
