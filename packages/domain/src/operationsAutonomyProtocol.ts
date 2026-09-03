import type { operationsIntelligenceProtocolVersion } from "./intelligenceProtocol.ts";
import type { OperationsHealthArea, OperationsHealthSnapshot } from "./operationsHealth.ts";
import type { IntelligenceRecommendationArguments } from "./intelligenceRecommendations.ts";
import type {
  OperationsAutonomyFrozenPolicy,
  OperationsAutonomyReadTool,
  OperationsAutonomyTrigger,
} from "./operationsAutonomyPolicy.ts";
import type {
  OperationsAutonomyDeepReadTool,
  OperationsAutonomyReadDataByTool,
} from "./operationsAutonomyReadData.ts";
import type { OperationsAutonomyRecommendationEvidenceSeal } from "./operationsAutonomyRecommendationEvidence.ts";

export const operationsAutonomyIngressSignatureContext =
  "code2create.operations-autonomy.ingress.v1";
export const operationsAutonomyReadSignatureContext = "code2create.operations-autonomy.read.v1";
export const operationsAutonomyWorkSignatureContext = "code2create.operations-autonomy.work.v1";
export const operationsAutonomyRecommendationSignatureContext =
  "code2create.operations-autonomy.recommendation.v1";
export const operationsAutonomyStreamTicketSignatureContext =
  "code2create.operations-autonomy.stream-ticket.v1";

/**
 * Initial and continuation admission are short-lived effects. Convex keeps an
 * outbound attempt pending beyond this window before it can confirm shutdown.
 */
export const operationsAutonomyAdmissionSignatureMaximumAgeMs = 30_000;

export function operationsAutopilotInstanceId(args: { runId: string }) {
  return args.runId;
}

export type OperationsAutonomyDispatchRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  trigger: OperationsAutonomyTrigger;
  runId: string;
  eventSlug: string;
  policy: OperationsAutonomyFrozenPolicy;
  source: {
    sourceChecksum: string;
    snapshot: OperationsHealthSnapshot;
  };
};

export type OperationsAutonomyRunIdentity = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  runId: string;
  policyVersionId: string;
  policyChecksum: string;
  sourceChecksum: string;
  /** Stable durable operation identity; Convex allocates the sequence. */
  operationId: string;
};

export type OperationsAutonomyReadRequest = OperationsAutonomyRunIdentity & {
  read: OperationsAutonomyReadTool;
  /** Opaque continuation returned by the preceding page of this traversal. */
  cursor?: string;
};

/** Every model and investigator boundary rechecks current effect authority and kill state. */
export type OperationsAutonomyWorkRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  runId: string;
  policyVersionId: string;
  policyChecksum: string;
  sourceChecksum: string;
  operationId: string;
  operation: { kind: "model" } | { kind: "delegation"; area: OperationsHealthArea };
};

export type OperationsAutonomyWorkReceipt = {
  state: "accepted";
  sequence: number;
};

type OperationsAutonomyReadReceiptBase = {
  state: "accepted";
  sequence: number;
  page: {
    /** Opaque continuation for the next page; absent when this traversal is complete. */
    cursor?: string;
    isDone: boolean;
    /** Stable identity shared by every page in one backend-owned traversal. */
    snapshot: string;
  };
};

export type OperationsAutonomyDeepReadReceipt = {
  [Read in OperationsAutonomyDeepReadTool]: OperationsAutonomyReadReceiptBase & {
    read: Read;
    data: OperationsAutonomyReadDataByTool[Read];
  };
}[OperationsAutonomyDeepReadTool];

export type OperationsAutonomyReadReceipt =
  | OperationsAutonomyDeepReadReceipt
  | (OperationsAutonomyReadReceiptBase & {
      read: Exclude<OperationsAutonomyReadTool, OperationsAutonomyDeepReadTool>;
      data: unknown;
    });

export type OperationsAutonomyRecommendationRequest = OperationsAutonomyRunIdentity & {
  proposalKey: string;
  eventSlug: string;
  agentVersion: string;
  model: string;
  statement: string;
  reasoning: string;
  evidenceSet: OperationsAutonomyRecommendationEvidenceSeal;
  /** Required when the proposed effect names a concrete row/version target. */
  targetCitationIdentity?: string;
  arguments: IntelligenceRecommendationArguments;
};

export type OperationsAutonomyRecommendationReceipt = {
  state: "accepted";
  sequence: number;
  recommendationId: string;
};

export type OperationsAutonomyTurnReceipt = {
  state: "accepted";
  runId: string;
  instanceId: string;
  submissionId: string;
  acceptedAt: string;
  uid: string;
};
