import type { OperationsAutonomyRecommendationEvidenceSeal } from "@code2create/domain";
import type { ToolStep } from "@flue/runtime";

import type { AutonomyArtifactStore } from "./autonomyArtifacts.ts";
import type { AutonomyCandidate } from "./autonomyExecution.ts";
import { autonomyOperationId } from "./autonomyOperationId.ts";
import {
  deliverAutonomyRecommendationEvidence,
  operationsAutonomyRecommendationEvidenceChunkMaximumCitations,
  type AutonomyBindings,
} from "./autonomyTransport.ts";
import type { AutonomyRunState } from "./autonomyContext.ts";
import type { AutonomyFinalizingProgress } from "./autonomyTraversal.ts";

const supportTraversalPageSize = 16;

function targetKeys(argumentsValue: AutonomyCandidate["arguments"]) {
  switch (argumentsValue.kind) {
    case "hold_review_team":
      return {
        read: "review_exceptions" as const,
        keys: [
          argumentsValue.teamRoundStateId,
          String(argumentsValue.expectedTeamRoundStateVersion),
        ],
      };
    case "page_reserve_reviewer":
      return {
        read: "review_exceptions" as const,
        keys: [argumentsValue.missingPanelMemberId, String(argumentsValue.expectedPanelVersion)],
      };
    case "dismiss_attention_item":
      return {
        read: "operations_attention" as const,
        keys: [argumentsValue.itemId, String(argumentsValue.expectedItemVersion)],
      };
    case "open_support_case": {
      const keys = [argumentsValue.roundId, argumentsValue.teamId].filter(
        (value): value is string => value !== undefined,
      );
      return keys.length === 0 ? undefined : { read: undefined, keys };
    }
  }
}

export function findAutonomyTargetSourceLeaf(args: {
  candidate: AutonomyCandidate;
  leaves: readonly { identity: string; citation: AutonomyCandidate["citations"][number] }[];
}) {
  const target = targetKeys(args.candidate.arguments);
  if (target === undefined) return undefined;
  return args.leaves.find(
    ({ citation }) =>
      (target.read === undefined || citation.read === target.read) &&
      target.keys.every((key) => citation.keys.includes(key)),
  );
}

export async function autonomyEvidenceSetId(args: { runId: string; proposalKey: string }) {
  return autonomyOperationId("recommendation", [args.runId, args.proposalKey, "evidence-set"]);
}

export type RecommendationEvidenceResult =
  | { state: "continuing"; progress: AutonomyFinalizingProgress }
  | {
      state: "sealed";
      progress: AutonomyFinalizingProgress;
      seal: OperationsAutonomyRecommendationEvidenceSeal;
      targetCitationIdentity?: string;
    };

/**
 * Expands a bounded-fan-in support DAG into canonical source leaves, then
 * uploads one exact, idempotent evidence page. Both traversals are durable and
 * can span arbitrarily many continuation submissions without growing progress.
 */
export async function prepareRecommendationEvidence(args: {
  runId: string;
  workItemId: string;
  proposalKey: string;
  candidateRecordId: string;
  candidate: AutonomyCandidate;
  progress: AutonomyFinalizingProgress;
  state: AutonomyRunState;
  artifacts: AutonomyArtifactStore;
  bindings: AutonomyBindings;
  step: ToolStep;
  signal?: AbortSignal;
}): Promise<RecommendationEvidenceResult> {
  const evidenceSetId = await autonomyEvidenceSetId({
    runId: args.runId,
    proposalKey: args.proposalKey,
  });
  const collected = await args.artifacts.collectSupportLeaves({
    collectionId: evidenceSetId,
    rootRecordId: args.candidateRecordId,
    limit: supportTraversalPageSize,
  });
  if (!collected.isDone) {
    return {
      state: "continuing",
      progress: {
        ...args.progress,
        completedWorkItemId: args.workItemId,
      },
    };
  }
  const pageIndex = args.progress.evidencePageIndex ?? 0;
  const leafPage = await args.artifacts.readSupportLeaves({
    collectionId: evidenceSetId,
    ...(args.progress.evidenceLeafCursor === undefined
      ? {}
      : { afterIdentity: args.progress.evidenceLeafCursor }),
    limit: operationsAutonomyRecommendationEvidenceChunkMaximumCitations,
  });
  if (leafPage.leaves.length === 0) {
    throw new Error("The autonomy recommendation has no source evidence leaves.");
  }
  const operationId = await autonomyOperationId("recommendation", [
    args.runId,
    args.proposalKey,
    "evidence-page",
    String(pageIndex),
  ]);
  const receipt = await args.step.do(`recommendation-evidence:${pageIndex}`, () =>
    deliverAutonomyRecommendationEvidence({
      state: args.state,
      content: {
        operationId,
        proposalKey: args.proposalKey,
        evidenceSetId,
        pageIndex,
        ...(args.progress.evidencePreviousPageHash === undefined
          ? {}
          : { previousPageHash: args.progress.evidencePreviousPageHash }),
        citations: leafPage.leaves.map(({ citation }) => citation),
        isDone: leafPage.isDone,
      },
      bindings: args.bindings,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    }),
  );
  const targetLeaf = findAutonomyTargetSourceLeaf({
    candidate: args.candidate,
    leaves: leafPage.leaves,
  });
  const targetIdentity = args.progress.targetCitationIdentity ?? targetLeaf?.identity;
  if (!leafPage.isDone) {
    const cursor = leafPage.cursor;
    if (cursor === undefined) {
      throw new Error("The incomplete recommendation evidence page has no cursor.");
    }
    return {
      state: "continuing",
      progress: {
        ...args.progress,
        completedWorkItemId: args.workItemId,
        evidenceLeafCursor: cursor,
        evidencePageIndex: pageIndex + 1,
        evidencePreviousPageHash: receipt.pageHash,
        ...(targetIdentity === undefined ? {} : { targetCitationIdentity: targetIdentity }),
      },
    };
  }
  const seal = receipt.seal;
  if (seal === undefined) {
    throw new Error("The terminal recommendation evidence page has no seal.");
  }
  if (targetKeys(args.candidate.arguments) !== undefined && targetIdentity === undefined) {
    throw new Error("The sealed autonomy evidence set has no exact target source leaf.");
  }
  return {
    state: "sealed",
    progress: {
      ...args.progress,
      completedWorkItemId: args.workItemId,
      evidenceSeal: seal,
      ...(targetIdentity === undefined ? {} : { targetCitationIdentity: targetIdentity }),
    },
    seal,
    ...(targetIdentity === undefined ? {} : { targetCitationIdentity: targetIdentity }),
  };
}
