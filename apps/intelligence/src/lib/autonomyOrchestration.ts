import { completeAutonomyPlan, plannerPrompt } from "./autonomyExecution.ts";
import { investigateAutonomyPage } from "./autonomyInvestigation.ts";
import { evidenceTargetsForPage, pageEvidenceDigest } from "./autonomyEvidence.ts";
import { registerDigestCandidateEffects } from "./autonomyCandidateOwnership.ts";
import { deliverRunningCheckpoint, lifecycleDuration, observedKeys } from "./autonomyLifecycle.ts";
import { autonomyPlannerResultSchema } from "./autonomyProtocol.ts";
import { reduceAutonomyEvidenceWorkItem } from "./autonomyReduction.ts";
import { finalizeAutonomyWorkItem } from "./autonomyFinalization.ts";
import {
  acceptTraversalPage,
  currentTraversalRead,
  pageOperationId,
  queueAutonomyDigest,
  readingAutonomyProgress,
  resumeReadingAfterInvestigation,
  traversalIsComplete,
  validateTraversalPage,
  investigationAreasForPage,
  workItemAlreadyApplied,
  type AutonomyInvestigatingProgress,
  type AutonomyReadingProgress,
} from "./autonomyTraversal.ts";
import { performAutonomyRead } from "./autonomyTransport.ts";
import type { AutonomyOrchestrationResult, RunAutonomyWorkItemArgs } from "./autonomyWorkItem.ts";

async function planWorkItem(args: RunAutonomyWorkItemArgs): Promise<AutonomyOrchestrationResult> {
  await deliverRunningCheckpoint({
    ...args,
    phase: "planning",
    observedSignalKeys: [],
  });
  const startedAt = Date.now();
  args.writeLifecycle({
    operation: "plan_operations",
    phase: "planning",
    role: "planner",
    status: "started",
  });
  const proposedPlan = await args.step.do("planner", async () => {
    const response = await args.harness.prompt(plannerPrompt(args.input), {
      result: autonomyPlannerResultSchema,
      thinkingLevel: "high",
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    return response.data;
  });
  const plan = completeAutonomyPlan(args.input, proposedPlan);
  args.writeLifecycle({
    operation: "plan_operations",
    phase: "planning",
    role: "planner",
    status: "completed",
    durationMs: lifecycleDuration(startedAt),
  });
  return {
    progress: readingAutonomyProgress({ workItemId: args.workItemId, plan }),
    outcome: "continuing",
  };
}

async function readCurrentPage(
  args: RunAutonomyWorkItemArgs & {
    progress: AutonomyReadingProgress;
  },
) {
  const read = currentTraversalRead(args.progress);
  await deliverRunningCheckpoint({
    ...args,
    phase: "reading",
    observedSignalKeys: observedKeys(args.progress),
  });
  const startedAt = Date.now();
  args.writeLifecycle({
    operation: "read_operations_data",
    phase: "reading",
    role: "reader",
    status: "started",
  });
  const operationId = await pageOperationId({
    runId: args.input.runId,
    read,
    pageIndex: args.progress.traversal.pageIndex,
  });
  const receipt = await args.step.do(`read:${read}:${args.progress.traversal.pageIndex}`, () =>
    performAutonomyRead({
      state: args.state,
      operationId,
      read,
      ...(args.progress.traversal.cursor === undefined
        ? {}
        : { cursor: args.progress.traversal.cursor }),
      bindings: args.bindings,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    }),
  );
  // No model or proposal can run until the signed page proves it belongs to
  // this exact snapshot/cursor traversal and does not conceal another page.
  validateTraversalPage(args.progress, receipt);
  if (!receipt.page.isDone) {
    const cursor = receipt.page.cursor;
    if (cursor === undefined) throw new Error("An incomplete page has no cursor.");
    const accepted = await args.step.do(`cursor:${args.progress.traversal.pageIndex}`, () =>
      args.artifacts.claimCursor({
        claimId: operationId,
        read: receipt.read,
        snapshot: receipt.page.snapshot,
        cursor,
      }),
    );
    if (!accepted) throw new Error("The autonomy traversal returned a cursor cycle.");
  }
  args.writeLifecycle({
    operation: "read_operations_data",
    phase: "reading",
    role: "reader",
    status: "completed",
    durationMs: lifecycleDuration(startedAt),
  });
  return receipt;
}

async function readingWorkItem(
  args: RunAutonomyWorkItemArgs & {
    progress: AutonomyReadingProgress;
  },
): Promise<AutonomyOrchestrationResult> {
  const receipt = await readCurrentPage(args);
  const pageArtifactId = await args.step.do("store-read-page", async () => {
    await args.artifacts.putTargets(evidenceTargetsForPage(receipt));
    return args.artifacts.putReadPage(receipt);
  });
  return {
    progress: {
      ...args.progress,
      stage: "investigating",
      completedWorkItemId: args.workItemId,
      pageArtifactId,
      investigationAreaIndex: 0,
    },
    outcome: "continuing",
  };
}

async function investigatingWorkItem(
  args: RunAutonomyWorkItemArgs & {
    progress: AutonomyInvestigatingProgress;
  },
): Promise<AutonomyOrchestrationResult> {
  const receipt = await args.artifacts.getReadPage(args.progress.pageArtifactId);
  const prior =
    args.progress.partialDigestId === undefined
      ? undefined
      : await args.artifacts.getDigest(args.progress.partialDigestId);
  await deliverRunningCheckpoint({
    ...args,
    phase: "investigating",
    observedSignalKeys: observedKeys(args.progress),
  });
  const investigation = await investigateAutonomyPage({
    ...args,
    receipt,
    area: investigationAreasForPage(receipt)[args.progress.investigationAreaIndex],
    ...(prior === undefined ? {} : { prior }),
  });
  const digest = await pageEvidenceDigest({
    receipt,
    investigation,
    sourceOrdinal: args.progress.nextSourceOrdinal,
    ...(prior === undefined ? {} : { previousDigestId: prior.digestId }),
  });
  await args.step.do("store-page-evidence", async () => {
    await args.artifacts.putDigest(digest);
    await registerDigestCandidateEffects({
      eventSlug: args.input.eventSlug,
      digest,
      artifacts: args.artifacts,
    });
    return digest.digestId;
  });
  if (!investigation.complete) {
    return {
      progress: {
        ...args.progress,
        completedWorkItemId: args.workItemId,
        nextSourceOrdinal: args.progress.nextSourceOrdinal + 1,
        partialDigestId: digest.digestId,
      },
      outcome: "continuing",
    };
  }
  const areas = investigationAreasForPage(receipt);
  if (args.progress.investigationAreaIndex + 1 < areas.length) {
    return {
      progress: {
        ...args.progress,
        completedWorkItemId: args.workItemId,
        nextSourceOrdinal: args.progress.nextSourceOrdinal + 1,
        investigationAreaIndex: args.progress.investigationAreaIndex + 1,
        partialDigestId: digest.digestId,
      },
      outcome: "continuing",
    };
  }
  const readingProgress: AutonomyReadingProgress = {
    ...resumeReadingAfterInvestigation(args.progress),
    nextSourceOrdinal: args.progress.nextSourceOrdinal + 1,
  };
  const progress = acceptTraversalPage({
    progress: readingProgress,
    receipt,
    workItemId: args.workItemId,
  });
  const next = queueAutonomyDigest({
    progress,
    digestId: digest.digestId,
    level: 0,
    resume: traversalIsComplete(progress) ? "finalizing" : "reading",
    workItemId: args.workItemId,
  });
  return { progress: next, outcome: "continuing" };
}

export async function runAutonomyWorkItem(
  args: RunAutonomyWorkItemArgs,
): Promise<AutonomyOrchestrationResult> {
  if (args.progress.stage === "terminal") {
    return { progress: args.progress, outcome: "terminal" };
  }
  if (workItemAlreadyApplied(args.progress, args.workItemId)) {
    return { progress: args.progress, outcome: "continuing" };
  }
  if (args.progress.stage === "planning") return planWorkItem(args);
  if (args.progress.stage === "reading") {
    return readingWorkItem({ ...args, progress: args.progress });
  }
  if (args.progress.stage === "investigating") {
    return investigatingWorkItem({ ...args, progress: args.progress });
  }
  if (args.progress.stage === "reducing") {
    return reduceAutonomyEvidenceWorkItem({ ...args, progress: args.progress });
  }
  return finalizeAutonomyWorkItem({ ...args, progress: args.progress });
}
