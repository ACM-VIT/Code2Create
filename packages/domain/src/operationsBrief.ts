import { operationsIntelligenceProtocolVersion } from "./intelligenceProtocol.ts";
import type {
  OperationsHealthSignalKey,
  OperationsHealthSnapshot,
} from "./operationsHealth.ts";

export const operationsIntelligenceIngressSignatureContext =
  "code2create.operations-intelligence.ingress.v1";
export const operationsIntelligenceCallbackSignatureContext =
  "code2create.operations-intelligence.callback.v1";

export const operationsBriefPrioritySeverities = ["critical", "attention", "watch"] as const;
export type OperationsBriefPrioritySeverity =
  (typeof operationsBriefPrioritySeverities)[number];

export type OperationsBriefPriority = {
  severity: OperationsBriefPrioritySeverity;
  title: string;
  why: string;
  owner: string;
  nextAction: string;
  signalKeys: OperationsHealthSignalKey[];
};

export type OperationsIntelligenceRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  briefId: string;
  sourceChecksum: string;
  snapshot: OperationsHealthSnapshot;
};

type OperationsIntelligenceCallbackBase = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  briefId: string;
  sourceChecksum: string;
  agentVersion: string;
  model: string;
  completedAt: number;
};

export type OperationsIntelligenceSuccess = OperationsIntelligenceCallbackBase & {
  status: "succeeded";
  headline: string;
  summary: string;
  priorities: OperationsBriefPriority[];
};

export type OperationsIntelligenceFailure = OperationsIntelligenceCallbackBase & {
  status: "failed";
  failureCode: "model_did_not_publish" | "callback_rejected";
};

export type OperationsIntelligenceCallback =
  | OperationsIntelligenceSuccess
  | OperationsIntelligenceFailure;
