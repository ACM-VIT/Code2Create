import { operationsIntelligenceProtocolVersion } from "./intelligenceProtocol.ts";
import type { OperationsHealthSignalKey } from "./operationsHealth.ts";

export const operationsAutonomyCallbackSignatureContext =
  "code2create.operations-autonomy.callback.v1";
export const operationsAutonomyAbortSignatureContext = "code2create.operations-autonomy.abort.v1";

export const operationsAutonomyRunStates = [
  "pending",
  "leased",
  "accepted",
  "running",
  "succeeded",
  "no_op",
  "escalated",
  "failed",
  "canceled",
] as const;
export type OperationsAutonomyRunState = (typeof operationsAutonomyRunStates)[number];

export const operationsAutonomyRunPhases = [
  "leased",
  "accepted",
  "planning",
  "reading",
  "investigating",
  "criticizing",
  "proposing",
  "continuing",
  "finalizing",
  "terminal",
] as const;
export type OperationsAutonomyRunPhase = (typeof operationsAutonomyRunPhases)[number];

/** The complete public lifecycle vocabulary; payloads never carry prompts or results. */
export const operationsAutonomyPublicLifecycleOperations = [
  "plan_operations",
  "read_operations_data",
  "investigate_area",
  "critique_plan",
  "propose_recommendation",
] as const;
export type OperationsAutonomyPublicLifecycleOperation =
  (typeof operationsAutonomyPublicLifecycleOperations)[number];

export const operationsAutonomyPublicLifecycleRoles = [
  "controller",
  "planner",
  "investigator",
  "critic",
  "reader",
  "publisher",
] as const;
export type OperationsAutonomyPublicLifecycleRole =
  (typeof operationsAutonomyPublicLifecycleRoles)[number];

export const operationsAutonomyPublicLifecycleStatuses = [
  "started",
  "completed",
  "failed",
] as const;
export type OperationsAutonomyPublicLifecycleStatus =
  (typeof operationsAutonomyPublicLifecycleStatuses)[number];

export const operationsAutonomyCallbackStatuses = [
  "running",
  "succeeded",
  "no_op",
  "escalated",
  "failed",
] as const;
export type OperationsAutonomyCallbackStatus = (typeof operationsAutonomyCallbackStatuses)[number];

type OperationsAutonomyCallbackBase = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  runId: string;
  policyVersionId: string;
  policyChecksum: string;
  sourceChecksum: string;
  /** Stable phase identity; retries receive the stored authoritative receipt. */
  operationId: string;
  agentVersion: string;
  model: string;
  observedSignalKeys: OperationsHealthSignalKey[];
};

export type OperationsAutonomyCallback = OperationsAutonomyCallbackBase &
  (
    | {
        status: "running";
        phase: Exclude<OperationsAutonomyRunPhase, "terminal">;
      }
    | {
        status: Exclude<OperationsAutonomyCallbackStatus, "running" | "failed">;
        phase: "terminal";
      }
    | {
        status: "failed";
        phase: "terminal";
        failureCode: "provider_failed" | "tool_failed" | "policy_violation" | "callback_rejected";
      }
  );

export type OperationsAutonomyCallbackReceipt = {
  state: "accepted";
  sequence: number;
  runState: OperationsAutonomyRunState;
};

export const operationsAutonomyCancellationReasons = [
  "kill_switch",
  "policy_superseded",
  "owner_revoked",
  "event_not_live",
] as const;
export type OperationsAutonomyCancellationReason =
  (typeof operationsAutonomyCancellationReasons)[number];

export type OperationsAutonomyAbortRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  runId: string;
  reason: OperationsAutonomyCancellationReason;
  operationId: string;
};
