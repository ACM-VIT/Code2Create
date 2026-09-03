"use agent";

import {
  intelligenceAgentDefinition,
  operationsAutopilotSystemPromptSections,
  operationsIntelligenceProtocolVersion,
} from "@code2create/domain";
import {
  defineTool,
  useAgentFinish,
  useDataWriter,
  useDelivery,
  useInitialData,
  useModel,
  usePersistentState,
  useTool,
} from "@flue/runtime";
import { extend } from "@flue/runtime/cloudflare";
import { env } from "cloudflare:workers";
import * as v from "valibot";

import {
  autonomyLifecycleDataSchema,
  operationsAutonomyDispatchRequestSchema,
  type OperationsAutonomyInput,
} from "../lib/autonomyProtocol.ts";
import { autonomyRunState, clearAutonomyRun } from "../lib/autonomyContext.ts";
import { AutonomyServiceRefusalError, deliverAutonomyCallback } from "../lib/autonomyTransport.ts";
import {
  autonomyProgressSchema,
  initialAutonomyProgress,
  type AutonomyProgress,
} from "../lib/autonomyTraversal.ts";
import { runAutonomyWorkItem } from "../lib/autonomyOrchestration.ts";
import type { AutonomyLifecycleEvent } from "../lib/autonomyLifecycle.ts";
import { operationsIntelligenceModel } from "../lib/model.ts";
import { autonomyOperationId } from "../lib/autonomyOperationId.ts";
import {
  cloudflareAutonomyArtifactStore,
  purgeCloudflareAutonomyArtifacts,
} from "../lib/autonomyCloudflareArtifacts.ts";
import { classifyAutonomyShellSettlement } from "../lib/autonomyShell.ts";
import { admissionControllerForRun } from "../lib/autonomyAdmissionController.ts";

export const operationsAutopilotModel = operationsIntelligenceModel;
export const operationsAutopilotAgentVersion =
  intelligenceAgentDefinition("operations-autopilot").version;

const completedOutputSchema = v.strictObject({
  completed: v.literal(true),
  outcome: v.picklist(["continuing", "terminal"]),
});
const emptyInputSchema = v.strictObject({});

function workItemId(delivery: ReturnType<typeof useDelivery>, runId: string) {
  if (delivery.kind === "signal" && delivery.type === "operations.autonomy.continue") {
    const id = delivery.attributes?.workItemId;
    if (id === undefined || id.length === 0 || id.length > 240) {
      throw new Error("The autonomy continuation has no valid work item id.");
    }
    return id;
  }
  if (delivery.kind === "signal" && delivery.type === "operations.autonomy.run") {
    return runId;
  }
  throw new Error("The autonomous agent received an unsupported delivery.");
}

export function OperationsAutopilot() {
  const input = useInitialData<OperationsAutonomyInput>();
  const delivery = useDelivery();
  const currentWorkItemId = workItemId(delivery, input.runId);
  const state = autonomyRunState(input);
  const [persistedProgress, setProgress] = usePersistentState<AutonomyProgress>(
    "autonomy-progress-v1",
    initialAutonomyProgress(),
  );
  const progress = v.parse(autonomyProgressSchema, persistedProgress);
  const writeLifecycleData = useDataWriter("autonomy-lifecycle", {
    schema: autonomyLifecycleDataSchema,
  });
  useModel(operationsAutopilotModel, { thinkingLevel: "minimal", compaction: false });
  let completedProgress: AutonomyProgress | undefined;
  let authorityEnded = false;
  let orchestrationInterrupted = false;

  useTool(
    defineTool<typeof emptyInputSchema, typeof completedOutputSchema, true, true>({
      name: "run_autonomy_work_item",
      description:
        "Execute the current trusted autonomy work item. Call once with no arguments and do not answer with prose.",
      input: emptyInputSchema,
      output: completedOutputSchema,
      harness: true,
      durable: true,
      async run({ harness, step, signal }) {
        const writeLifecycle = (event: AutonomyLifecycleEvent) => writeLifecycleData(event);
        const artifacts = cloudflareAutonomyArtifactStore();
        try {
          const result = await runAutonomyWorkItem({
            input,
            state,
            progress,
            workItemId: currentWorkItemId,
            harness,
            step,
            writeLifecycle,
            agentVersion: operationsAutopilotAgentVersion,
            model: operationsAutopilotModel,
            bindings: env,
            artifacts,
            ...(signal === undefined ? {} : { signal }),
          });
          completedProgress = result.progress;
          setProgress(result.progress);
          return {
            output: { completed: true, outcome: result.outcome },
            terminate: true,
          };
        } catch (error) {
          authorityEnded =
            error instanceof AutonomyServiceRefusalError &&
            (error.code === "authority_revoked" || error.code === "run_terminal");
          orchestrationInterrupted = !authorityEnded;
          if (authorityEnded) {
            await step.do("purge-private-run-artifacts-after-authority-end", async () => {
              await artifacts.clearRunArtifacts();
              return true;
            });
          }
          if (!authorityEnded) {
            writeLifecycle({
              operation: "plan_operations",
              phase: progress.stage === "planning" ? "planning" : "continuing",
              role: "controller",
              status: "failed",
            });
          }
          // Infrastructure/provider failure is deliberately not a product terminal.
          // Terminate this shell submission without advancing durable progress;
          // the continuing callback lets supervision reissue a fresh work item.
          return {
            output: { completed: true, outcome: "continuing" },
            terminate: true,
          };
        }
      },
    }),
  );

  useAgentFinish(async ({ response, signal }) => {
    const shellSettlement = classifyAutonomyShellSettlement(response.toolCalls);
    if (shellSettlement === "recoverable_missing_tool") {
      clearAutonomyRun(input.runId);
      throw new Error("The autonomy shell omitted its required durable work-item tool.");
    }
    // A present tool that failed can be provider or transport congestion.
    // Never turn an infrastructure failure into a product policy terminal.
    if (shellSettlement === "recoverable_tool_failure") {
      clearAutonomyRun(input.runId);
      return;
    }
    const settledProgress = completedProgress ?? progress;
    if (authorityEnded) {
      clearAutonomyRun(input.runId);
      return;
    }
    if (orchestrationInterrupted) {
      await deliverAutonomyCallback({
        state,
        operationId: await autonomyOperationId("callback", [
          input.runId,
          currentWorkItemId,
          "continuing",
        ]),
        content: {
          status: "running",
          phase: "continuing",
          observedSignalKeys:
            settledProgress.stage === "reading"
              ? settledProgress.observedSignals.map((entry) => entry.key)
              : [],
        },
        agentVersion: operationsAutopilotAgentVersion,
        model: operationsAutopilotModel,
        bindings: env,
        signal,
      });
      clearAutonomyRun(input.runId);
      return;
    }
    if (settledProgress.stage === "terminal") {
      // Terminal progress is already durable with the completed tool batch.
      // Purge is idempotent; the run-keyed admission controller durably owns the
      // terminal callback outbox and closes its fence only after Convex accepts it.
      await env.FLUE_OPERATIONS_AUTOPILOT_AGENT.getByName(
        input.runId,
      ).requestAutonomyArtifactPurge();
      await admissionControllerForRun(env, input.runId).enqueueTerminalSettlement({
        protocolVersion: operationsIntelligenceProtocolVersion,
        runId: input.runId,
        policyVersionId: input.policy.policyVersionId,
        policyChecksum: input.policy.policyChecksum,
        sourceChecksum: input.source.sourceChecksum,
        operationId: await autonomyOperationId("callback", [
          input.runId,
          currentWorkItemId,
          "terminal",
          settledProgress.status,
        ]),
        status: settledProgress.status,
        phase: "terminal",
        observedSignalKeys: settledProgress.observedSignals.map((entry) => entry.key),
        agentVersion: operationsAutopilotAgentVersion,
        model: operationsAutopilotModel,
      });
    } else {
      await deliverAutonomyCallback({
        state,
        operationId: await autonomyOperationId("callback", [
          input.runId,
          currentWorkItemId,
          "continuing",
        ]),
        content: {
          status: "running",
          phase: "continuing",
          observedSignalKeys:
            settledProgress.stage === "reading"
              ? settledProgress.observedSignals.map((entry) => entry.key)
              : [],
        },
        agentVersion: operationsAutopilotAgentVersion,
        model: operationsAutopilotModel,
        bindings: env,
        signal,
      });
    }
    clearAutonomyRun(input.runId);
  });

  return [
    ...operationsAutopilotSystemPromptSections,
    `Frozen run identity: run=${input.runId}; workItem=${currentWorkItemId}; event=${input.eventSlug}; policyVersion=${input.policy.policyVersionId}; sourceChecksum=${input.source.sourceChecksum}; protocol=${operationsIntelligenceProtocolVersion}.`,
  ].join("\n\n");
}

OperationsAutopilot.agentName = "operations-autopilot";
OperationsAutopilot.initialData = operationsAutonomyDispatchRequestSchema;
// One interrupted infrastructure attempt may be recovered inside a bounded
// work item. The backend supervisor admits later work items as new submissions.
OperationsAutopilot.durability = { maxAttempts: 2 };

/**
 * Private artifact cleanup is scheduled on the run Durable Object itself so
 * an abort intent cannot race a still-settling tool. Native Flue history stays
 * in its separately approved restricted retention class; this removes every
 * application-owned read, finding, candidate, and support table.
 */
export const cloudflare = extend({
  base: (Base) =>
    class extends Base {
      async requestAutonomyArtifactPurge() {
        await this.schedule(0, "purgeAutonomyArtifacts", undefined, {
          idempotent: true,
        });
      }

      purgeAutonomyArtifacts() {
        purgeCloudflareAutonomyArtifacts(this.ctx.storage.sql);
      }
    },
});
