import { adjudicateAutonomyCandidatePage } from "./autonomyAdjudication.ts";
import {
  autonomyTerminalStatus,
  deliverRunningCheckpoint,
  observedKeys,
} from "./autonomyLifecycle.ts";
import { publishAutonomyCandidates } from "./autonomyRecommendations.ts";
import { prepareRecommendationEvidence } from "./autonomyRecommendationEvidence.ts";
import type { AutonomyFinalizingProgress } from "./autonomyTraversal.ts";
import type { AutonomyOrchestrationResult, RunAutonomyWorkItemArgs } from "./autonomyWorkItem.ts";

const findingPageSize = 8;
const rootCatalogPageSize = 16;

function clearActiveEffect(progress: AutonomyFinalizingProgress, effectCursor: string) {
  const {
    activeEffectKey: _activeEffectKey,
    candidateVariantCursor: _candidateVariantCursor,
    findingCursor: _findingCursor,
    selectedCandidateRecordId: _selectedCandidateRecordId,
    evidenceLeafCursor: _evidenceLeafCursor,
    evidencePageIndex: _evidencePageIndex,
    evidencePreviousPageHash: _evidencePreviousPageHash,
    evidenceSeal: _evidenceSeal,
    targetCitationIdentity: _targetCitationIdentity,
    publicationPending: _publicationPending,
    ...remaining
  } = progress;
  return { ...remaining, effectCursor };
}

/**
 * Reviews every variant of one effect against every durable finding page.
 * The last supported variant is selected deterministically by record id; an
 * early suppressed variant never hides a later complete one.
 */
export async function finalizeAutonomyWorkItem(
  args: RunAutonomyWorkItemArgs & { progress: AutonomyFinalizingProgress },
): Promise<AutonomyOrchestrationResult> {
  let progress = args.progress;
  const prepared = await args.artifacts.prepareRootCatalog({
    rootDigestId: progress.finalDigestId,
    limit: rootCatalogPageSize,
  });
  if (!prepared.isDone) {
    return {
      progress: { ...progress, completedWorkItemId: args.workItemId },
      outcome: "continuing",
    };
  }
  const effectPage = await args.artifacts.readCandidateEffects({
    rootDigestId: progress.finalDigestId,
    ...(progress.effectCursor === undefined ? {} : { cursor: progress.effectCursor }),
    limit: 1,
  });
  const effectKey = effectPage.effectKeys[0];
  if (progress.activeEffectKey !== undefined && effectKey !== progress.activeEffectKey)
    throw new Error("The autonomy effect cursor changed during adjudication.");
  if (effectKey !== undefined && progress.activeEffectKey === undefined) {
    progress = {
      ...progress,
      activeEffectKey: effectKey,
    };
  }

  if (effectKey !== undefined) {
    const variantPage = await args.artifacts.readCandidateEffectVariants({
      rootDigestId: progress.finalDigestId,
      effectKey,
      ...(progress.candidateVariantCursor === undefined
        ? {}
        : { cursor: progress.candidateVariantCursor }),
      limit: 1,
    });
    const candidate = variantPage.records[0];
    if (candidate === undefined) {
      if (!variantPage.isDone) {
        throw new Error("The incomplete autonomy candidate page has no record.");
      }
      const selected =
        progress.selectedCandidateRecordId === undefined
          ? undefined
          : await args.artifacts.getEvidenceRecord(progress.selectedCandidateRecordId);
      let published = 0;
      if (selected?.kind === "candidate") {
        const evidence =
          progress.evidenceSeal === undefined
            ? await prepareRecommendationEvidence({
                runId: args.input.runId,
                workItemId: args.workItemId,
                proposalKey: effectKey,
                candidateRecordId: selected.recordId,
                candidate: selected.candidate,
                progress,
                state: args.state,
                artifacts: args.artifacts,
                bindings: args.bindings,
                step: args.step,
                ...(args.signal === undefined ? {} : { signal: args.signal }),
              })
            : {
                state: "sealed" as const,
                progress,
                seal: progress.evidenceSeal,
                ...(progress.targetCitationIdentity === undefined
                  ? {}
                  : { targetCitationIdentity: progress.targetCitationIdentity }),
              };
        if (evidence.state === "continuing") {
          return { progress: evidence.progress, outcome: "continuing" };
        }
        progress = evidence.progress;
        if (progress.publicationPending !== true) {
          return {
            progress: {
              ...progress,
              completedWorkItemId: args.workItemId,
              publicationPending: true,
            },
            outcome: "continuing",
          };
        }
        published = await publishAutonomyCandidates({
          ...args,
          progress,
          candidates: [
            {
              ...selected.candidate,
              evidenceSet: evidence.seal,
              ...(evidence.targetCitationIdentity === undefined
                ? {}
                : { targetCitationIdentity: evidence.targetCitationIdentity }),
            },
          ],
        });
      }
      return {
        progress: {
          ...clearActiveEffect(progress, effectKey),
          completedWorkItemId: args.workItemId,
          recommendationCount: progress.recommendationCount + published,
        },
        outcome: "continuing",
      };
    }
    if (args.input.policy.mode === "observe") {
      return {
        progress: {
          ...clearActiveEffect(progress, effectKey),
          completedWorkItemId: args.workItemId,
        },
        outcome: "continuing",
      };
    }
    const findingPage = await args.artifacts.readFindingRecords({
      rootDigestId: progress.finalDigestId,
      ...(progress.findingCursor === undefined ? {} : { cursor: progress.findingCursor }),
      limit: findingPageSize,
    });
    if (findingPage.records.length === 0) {
      if (!findingPage.isDone) {
        throw new Error("The incomplete autonomy finding page has no record.");
      }
      return {
        progress: {
          ...progress,
          completedWorkItemId: args.workItemId,
          candidateVariantCursor: candidate.recordId,
        },
        outcome: "continuing",
      };
    }
    const decision = await adjudicateAutonomyCandidatePage({
      ...args,
      progress,
      candidate,
      findings: findingPage.records,
    });
    if (!findingPage.isDone && decision === "approve") {
      const cursor = findingPage.cursor;
      if (cursor === undefined) {
        throw new Error("The incomplete autonomy finding page has no cursor.");
      }
      return {
        progress: {
          ...progress,
          completedWorkItemId: args.workItemId,
          findingCursor: cursor,
        },
        outcome: "continuing",
      };
    }
    const { findingCursor: _findingCursor, ...withoutFindingCursor } = progress;
    return {
      progress: {
        ...withoutFindingCursor,
        completedWorkItemId: args.workItemId,
        candidateVariantCursor: candidate.recordId,
        ...(decision === "approve" ? { selectedCandidateRecordId: candidate.recordId } : {}),
      },
      outcome: "continuing",
    };
  }

  await deliverRunningCheckpoint({
    ...args,
    phase: "finalizing",
    observedSignalKeys: observedKeys(progress),
  });
  const status = autonomyTerminalStatus(args.input, progress);
  return {
    progress: {
      stage: "terminal",
      completedWorkItemId: args.workItemId,
      status,
      observedSignals: progress.observedSignals,
    },
    outcome: "terminal",
  };
}
