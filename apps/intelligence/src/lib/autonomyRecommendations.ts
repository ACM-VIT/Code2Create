import type { FlueHarness, ToolStep } from "@flue/runtime";

import type { AutonomyRunState } from "./autonomyContext.ts";
import { normalizeRecommendationArguments, type AutonomyCandidate } from "./autonomyExecution.ts";
import {
  deliverRunningCheckpoint,
  lifecycleDuration,
  observedKeys,
  type AutonomyLifecycleWriter,
  type AutonomyActiveProgress,
} from "./autonomyLifecycle.ts";
import type { OperationsAutonomyInput } from "./autonomyProtocol.ts";
import { autonomyProposalKey } from "./autonomyProposal.ts";
import { autonomyOperationId } from "./autonomyOperationId.ts";
import { deliverAutonomyRecommendation, type AutonomyBindings } from "./autonomyTransport.ts";

type RecommendationContext = {
  input: OperationsAutonomyInput;
  state: AutonomyRunState;
  progress: AutonomyActiveProgress;
  workItemId: string;
  harness: FlueHarness;
  step: ToolStep;
  writeLifecycle: AutonomyLifecycleWriter;
  agentVersion: string;
  model: string;
  bindings: AutonomyBindings;
  signal?: AbortSignal;
};

export async function publishAutonomyCandidates(
  args: RecommendationContext & {
    candidates: readonly (AutonomyCandidate & {
      evidenceSet: import("@code2create/domain").OperationsAutonomyRecommendationEvidenceSeal;
      targetCitationIdentity?: string;
    })[];
  },
) {
  if (args.candidates.length === 0) return 0;
  await deliverRunningCheckpoint({
    ...args,
    phase: "proposing",
    observedSignalKeys: observedKeys(args.progress),
  });
  const seenEffects = new Set<string>();
  let published = 0;
  for (const candidate of args.candidates) {
    const normalizedArguments = normalizeRecommendationArguments(candidate.arguments);
    const proposalKey = await autonomyProposalKey({
      eventSlug: args.input.eventSlug,
      arguments: normalizedArguments,
    });
    if (seenEffects.has(proposalKey)) continue;
    seenEffects.add(proposalKey);
    const operationId = await autonomyOperationId("recommendation", [
      args.input.runId,
      proposalKey,
    ]);
    const startedAt = Date.now();
    args.writeLifecycle({
      operation: "propose_recommendation",
      phase: "proposing",
      role: "publisher",
      status: "started",
    });
    await args.step.do(`recommendation:${proposalKey}`, () =>
      deliverAutonomyRecommendation({
        state: args.state,
        content: {
          operationId,
          proposalKey,
          statement: candidate.statement,
          reasoning: candidate.reasoning,
          evidenceSet: candidate.evidenceSet,
          ...(candidate.targetCitationIdentity === undefined
            ? {}
            : { targetCitationIdentity: candidate.targetCitationIdentity }),
          arguments: normalizedArguments,
        },
        agentVersion: args.agentVersion,
        model: args.model,
        bindings: args.bindings,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      }),
    );
    published += 1;
    args.writeLifecycle({
      operation: "propose_recommendation",
      phase: "proposing",
      role: "publisher",
      status: "completed",
      durationMs: lifecycleDuration(startedAt),
    });
  }
  return published;
}
