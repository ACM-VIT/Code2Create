import type { ToolStep } from "@flue/runtime";
import * as v from "valibot";

import type { AutonomyRunState } from "./autonomyContext.ts";
import { autonomyLifecycleDataSchema, type OperationsAutonomyInput } from "./autonomyProtocol.ts";
import type { AutonomyProgress } from "./autonomyTraversal.ts";
import { autonomyOperationId } from "./autonomyOperationId.ts";
import { deliverAutonomyCallback, type AutonomyBindings } from "./autonomyTransport.ts";

export type AutonomyLifecycleEvent = v.InferOutput<typeof autonomyLifecycleDataSchema>;
export type AutonomyLifecycleWriter = (event: AutonomyLifecycleEvent) => void;
export type AutonomyActiveProgress = Extract<
  AutonomyProgress,
  { stage: "reading" | "investigating" | "reducing" | "finalizing" }
>;

export function observedKeys(progress: AutonomyActiveProgress) {
  return progress.observedSignals.map((signal) => signal.key);
}

function severityRank(value: "critical" | "attention" | "watch") {
  return value === "critical" ? 3 : value === "attention" ? 2 : 1;
}

export function autonomyTerminalStatus(
  input: OperationsAutonomyInput,
  progress: AutonomyActiveProgress,
) {
  if (progress.recommendationCount > 0) return "succeeded" as const;
  if (progress.observedSignals.length === 0) return "no_op" as const;
  const threshold = severityRank(input.policy.escalationSeverity);
  return progress.observedSignals.some((signal) => severityRank(signal.severity) >= threshold)
    ? ("escalated" as const)
    : ("succeeded" as const);
}

export function lifecycleDuration(startedAt: number) {
  return Math.max(0, Date.now() - startedAt);
}

export function callbackOperationId(workItemId: string, phase: string) {
  return autonomyOperationId("callback", [workItemId, phase]);
}

export async function deliverRunningCheckpoint(args: {
  state: AutonomyRunState;
  workItemId: string;
  phase:
    | "planning"
    | "reading"
    | "investigating"
    | "criticizing"
    | "proposing"
    | "continuing"
    | "finalizing";
  observedSignalKeys: ReturnType<typeof observedKeys>;
  agentVersion: string;
  model: string;
  bindings: AutonomyBindings;
  step: ToolStep;
  signal?: AbortSignal;
}) {
  return args.step.do(`callback:${args.phase}`, async () =>
    deliverAutonomyCallback({
      state: args.state,
      operationId: await callbackOperationId(args.workItemId, args.phase),
      content: {
        status: "running",
        phase: args.phase,
        observedSignalKeys: args.observedSignalKeys,
      },
      agentVersion: args.agentVersion,
      model: args.model,
      bindings: args.bindings,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    }),
  );
}
