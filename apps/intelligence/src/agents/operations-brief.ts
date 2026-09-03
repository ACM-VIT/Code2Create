"use agent";

import {
  intelligenceAgentDefinition,
  operationsBriefSystemPromptSections,
  operationsIntelligenceProtocolVersion,
  type OperationsIntelligenceCallback,
} from "@code2create/domain";
import {
  defineTool,
  useAgentFinish,
  useInitialData,
  useModel,
  usePersistentState,
  useTool,
} from "@flue/runtime";
import { env } from "cloudflare:workers";
import * as v from "valibot";

import { deliverCallback } from "../lib/callback.ts";
import {
  operationsBriefSelectionSchema,
  operationsIntelligenceRequestSchema,
  type OperationsIntelligenceInput,
} from "../protocol.ts";
import { buildGroundedOperationsBrief } from "../lib/groundedBrief.ts";
import { operationsIntelligenceModel } from "../lib/model.ts";

/** Shared by model execution and callback attribution. */
export const operationsBriefModel = operationsIntelligenceModel;
export const operationsBriefAgentVersion = intelligenceAgentDefinition("operations-brief").version;

function successCallback(
  input: OperationsIntelligenceInput,
  selection: v.InferOutput<typeof operationsBriefSelectionSchema>,
): OperationsIntelligenceCallback {
  const output = buildGroundedOperationsBrief(input, selection);
  return {
    protocolVersion: operationsIntelligenceProtocolVersion,
    briefId: input.briefId,
    sourceChecksum: input.sourceChecksum,
    agentVersion: operationsBriefAgentVersion,
    model: operationsBriefModel,
    completedAt: Date.now(),
    status: "succeeded",
    headline: output.headline,
    summary: output.summary,
    priorities: output.priorities,
  };
}

function failureCallback(input: OperationsIntelligenceInput): OperationsIntelligenceCallback {
  return {
    protocolVersion: operationsIntelligenceProtocolVersion,
    briefId: input.briefId,
    sourceChecksum: input.sourceChecksum,
    agentVersion: operationsBriefAgentVersion,
    model: operationsBriefModel,
    completedAt: Date.now(),
    status: "failed",
    failureCode: "model_did_not_publish",
  };
}

export function OperationsBrief() {
  const input = useInitialData<OperationsIntelligenceInput>();
  const [reminded, setReminded] = usePersistentState("publish-reminded", false);
  useModel(operationsBriefModel, { thinkingLevel: "low", compaction: false });
  useTool(
    defineTool({
      name: "publish_operations_brief",
      description:
        "Publish the final bounded operations brief by selecting only ordered, non-overlapping groups of signal keys from the frozen snapshot.",
      input: operationsBriefSelectionSchema,
      output: v.strictObject({ delivered: v.literal(true) }),
      durable: true,
      async run({ data, step }) {
        const result = await step.do(`publish:${input.briefId}`, () =>
          deliverCallback(successCallback(input, data), env),
        );
        return { output: result, terminate: true };
      },
    }),
  );
  useAgentFinish(async ({ response, append }) => {
    const published = response.toolCalls.some(
      (call) => call.tool === "publish_operations_brief" && !call.isError,
    );
    if (published) return;
    if (!reminded) {
      setReminded(true);
      append({
        kind: "signal",
        type: "operations.brief.publish_required",
        body: "Publish now. Supply only up to three non-overlapping groups of signal keys from the frozen snapshot.",
      });
      return;
    }
    await deliverCallback(failureCallback(input), env);
  });

  return [
    ...operationsBriefSystemPromptSections,
    `Frozen identity: brief=${input.briefId}; source checksum=${input.sourceChecksum}; protocol=${operationsIntelligenceProtocolVersion}.`,
    `Frozen snapshot JSON:\n${JSON.stringify(input.snapshot)}`,
  ].join("\n\n");
}

OperationsBrief.agentName = "operations-brief";
OperationsBrief.initialData = operationsIntelligenceRequestSchema;
OperationsBrief.durability = { maxAttempts: 2 };
