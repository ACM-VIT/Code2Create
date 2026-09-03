import {
  operationsHealthSeverities,
  operationsHealthSignalKeys,
  type OperationsAutonomyReadTool,
  type OperationsHealthArea,
  type OperationsHealthSeverity,
  type OperationsHealthSignalKey,
} from "@code2create/domain";
import * as v from "valibot";

import type { AutonomyPlan, AutonomyReadReceipt } from "./autonomyExecution.ts";
import { autonomyPlannerResultSchema } from "./autonomyProtocol.ts";
import { autonomyOperationId } from "./autonomyOperationId.ts";

const boundedText = (maximum: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(maximum));
const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const digestId = v.pipe(v.string(), v.regex(/^digest-[a-f0-9]{64}$/u));
const evidenceRecordId = v.pipe(v.string(), v.regex(/^record-[a-f0-9]{64}$/u));
const checksum = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const evidenceSealSchema = v.strictObject({
  evidenceSetId: boundedText(200),
  rootHash: checksum,
  leafCount: v.pipe(nonNegativeInteger, v.minValue(1)),
  chunkCount: v.pipe(nonNegativeInteger, v.minValue(1)),
  sealedSequence: v.pipe(nonNegativeInteger, v.minValue(1)),
});

const traversalSchema = v.strictObject({
  readIndex: nonNegativeInteger,
  pageIndex: nonNegativeInteger,
  cursor: v.optional(boundedText(1_024)),
  snapshot: v.optional(boundedText(200)),
});

const observedSignalSchema = v.strictObject({
  key: v.picklist(operationsHealthSignalKeys),
  severity: v.picklist(operationsHealthSeverities),
});

const readingState = {
  plan: autonomyPlannerResultSchema,
  traversal: traversalSchema,
  observedSignals: v.array(observedSignalSchema),
  recommendationCount: nonNegativeInteger,
  nextSourceOrdinal: nonNegativeInteger,
  reductionLevels: v.array(v.nullable(digestId)),
};

export const autonomyProgressSchema = v.variant("stage", [
  v.strictObject({
    stage: v.literal("planning"),
    completedWorkItemId: v.optional(boundedText(240)),
  }),
  v.strictObject({
    stage: v.literal("reading"),
    completedWorkItemId: boundedText(240),
    ...readingState,
  }),
  v.strictObject({
    stage: v.literal("investigating"),
    completedWorkItemId: boundedText(240),
    ...readingState,
    pageArtifactId: boundedText(300),
    investigationAreaIndex: nonNegativeInteger,
    partialDigestId: v.optional(digestId),
  }),
  v.strictObject({
    stage: v.literal("reducing"),
    completedWorkItemId: boundedText(240),
    ...readingState,
    pending: v.variant("phase", [
      v.strictObject({
        phase: v.literal("source"),
        left: digestId,
        right: digestId,
        targetLevel: nonNegativeInteger,
        resume: v.picklist(["reading", "finalizing"]),
        cursor: v.optional(boundedText(200)),
        partialDigestId: v.optional(digestId),
        accumulatorDigestId: v.optional(digestId),
      }),
      v.strictObject({
        phase: v.literal("hypotheses"),
        left: digestId,
        right: digestId,
        targetLevel: nonNegativeInteger,
        resume: v.picklist(["reading", "finalizing"]),
        cursor: v.optional(boundedText(200)),
        accumulatorDigestId: digestId,
        hypothesisRootDigestIds: v.pipe(v.array(digestId), v.minLength(1), v.maxLength(3)),
        hypothesisCursor: v.optional(evidenceRecordId),
        partialDigestId: v.optional(digestId),
      }),
    ]),
  }),
  v.strictObject({
    stage: v.literal("finalizing"),
    completedWorkItemId: boundedText(240),
    ...readingState,
    finalDigestId: digestId,
    effectCursor: v.optional(boundedText(240)),
    activeEffectKey: v.optional(boundedText(240)),
    candidateVariantCursor: v.optional(evidenceRecordId),
    findingCursor: v.optional(evidenceRecordId),
    selectedCandidateRecordId: v.optional(evidenceRecordId),
    evidenceLeafCursor: v.optional(checksum),
    evidencePageIndex: v.optional(nonNegativeInteger),
    evidencePreviousPageHash: v.optional(checksum),
    evidenceSeal: v.optional(evidenceSealSchema),
    targetCitationIdentity: v.optional(checksum),
    publicationPending: v.optional(v.boolean()),
  }),
  v.strictObject({
    stage: v.literal("terminal"),
    completedWorkItemId: boundedText(240),
    status: v.picklist(["succeeded", "no_op", "escalated"]),
    observedSignals: v.array(observedSignalSchema),
  }),
]);

export type AutonomyTraversal = v.InferOutput<typeof traversalSchema>;
export type AutonomyObservedSignal = {
  key: OperationsHealthSignalKey;
  severity: OperationsHealthSeverity;
};

export type AutonomyReadingProgress = {
  stage: "reading";
  completedWorkItemId: string;
  plan: AutonomyPlan;
  traversal: AutonomyTraversal;
  observedSignals: AutonomyObservedSignal[];
  recommendationCount: number;
  nextSourceOrdinal: number;
  reductionLevels: (string | null)[];
};

export type AutonomyReducingProgress = Omit<AutonomyReadingProgress, "stage"> & {
  stage: "reducing";
  pending:
    | {
        phase: "source";
        left: string;
        right: string;
        targetLevel: number;
        resume: "reading" | "finalizing";
        cursor?: string | undefined;
        partialDigestId?: string | undefined;
        accumulatorDigestId?: string | undefined;
      }
    | {
        phase: "hypotheses";
        left: string;
        right: string;
        targetLevel: number;
        resume: "reading" | "finalizing";
        cursor?: string | undefined;
        accumulatorDigestId: string;
        hypothesisRootDigestIds: string[];
        hypothesisCursor?: string | undefined;
        partialDigestId?: string | undefined;
      };
};

export type AutonomyInvestigatingProgress = Omit<AutonomyReadingProgress, "stage"> & {
  stage: "investigating";
  pageArtifactId: string;
  investigationAreaIndex: number;
  partialDigestId?: string | undefined;
};

export type AutonomyFinalizingProgress = Omit<AutonomyReadingProgress, "stage"> & {
  stage: "finalizing";
  finalDigestId: string;
  effectCursor?: string | undefined;
  activeEffectKey?: string | undefined;
  candidateVariantCursor?: string | undefined;
  findingCursor?: string | undefined;
  selectedCandidateRecordId?: string | undefined;
  evidenceLeafCursor?: string | undefined;
  evidencePageIndex?: number | undefined;
  evidencePreviousPageHash?: string | undefined;
  evidenceSeal?:
    | {
        evidenceSetId: string;
        rootHash: string;
        leafCount: number;
        chunkCount: number;
        sealedSequence: number;
      }
    | undefined;
  targetCitationIdentity?: string | undefined;
  publicationPending?: boolean | undefined;
};

export type AutonomyProgress =
  | { stage: "planning"; completedWorkItemId?: string | undefined }
  | AutonomyReadingProgress
  | AutonomyInvestigatingProgress
  | AutonomyReducingProgress
  | AutonomyFinalizingProgress
  | {
      stage: "terminal";
      completedWorkItemId: string;
      status: "succeeded" | "no_op" | "escalated";
      observedSignals: AutonomyObservedSignal[];
    };

export function initialAutonomyProgress(): AutonomyProgress {
  return { stage: "planning" };
}

export function workItemAlreadyApplied(progress: AutonomyProgress, workItemId: string) {
  return progress.completedWorkItemId === workItemId;
}

export function readingAutonomyProgress(args: {
  workItemId: string;
  plan: AutonomyPlan;
}): AutonomyReadingProgress {
  return {
    stage: "reading",
    completedWorkItemId: args.workItemId,
    plan: args.plan,
    traversal: {
      readIndex: 0,
      pageIndex: 0,
    },
    observedSignals: [],
    recommendationCount: 0,
    nextSourceOrdinal: 0,
    reductionLevels: [],
  };
}

export function currentTraversalRead(progress: AutonomyReadingProgress) {
  const read = progress.plan.reads[progress.traversal.readIndex];
  if (read === undefined) throw new Error("The autonomy traversal has no current read.");
  return read;
}

export function pageOperationId(args: {
  runId: string;
  read: OperationsAutonomyReadTool;
  pageIndex: number;
}) {
  return autonomyOperationId("read", [args.runId, args.read, String(args.pageIndex)]);
}

export function acceptTraversalPage(args: {
  progress: AutonomyReadingProgress;
  receipt: AutonomyReadReceipt;
  workItemId: string;
}) {
  const { progress, receipt } = args;
  validateTraversalPage(progress, receipt);

  const observedByKey = new Map(progress.observedSignals.map((signal) => [signal.key, signal]));
  if (receipt.read === "operations_health") {
    for (const signal of receipt.data.signals) {
      observedByKey.set(signal.key, { key: signal.key, severity: signal.severity });
    }
  }

  const observedSignals = [...observedByKey.values()];
  if (!receipt.page.isDone) {
    const cursor = receipt.page.cursor;
    if (cursor === undefined) throw new Error("An incomplete autonomy page has no cursor.");
    return {
      ...progress,
      completedWorkItemId: args.workItemId,
      traversal: {
        ...progress.traversal,
        pageIndex: progress.traversal.pageIndex + 1,
        cursor,
        snapshot: receipt.page.snapshot,
      },
      observedSignals,
    };
  }

  const nextReadIndex = progress.traversal.readIndex + 1;
  return {
    ...progress,
    completedWorkItemId: args.workItemId,
    traversal: {
      readIndex: nextReadIndex,
      pageIndex: 0,
    },
    observedSignals,
  };
}

/** Validates the entire page boundary before any model or recommendation effect. */
export function validateTraversalPage(
  progress: AutonomyReadingProgress,
  receipt: AutonomyReadReceipt,
) {
  const read = currentTraversalRead(progress);
  if (receipt.read !== read) throw new Error("The autonomy read page changed its read type.");
  if (
    progress.traversal.snapshot !== undefined &&
    receipt.page.snapshot !== progress.traversal.snapshot
  )
    throw new Error("The autonomy read traversal changed snapshots between pages.");
  if (!receipt.page.isDone) {
    const cursor = receipt.page.cursor;
    if (cursor === undefined) throw new Error("The autonomy read page has no cursor.");
  }
}

export function traversalIsComplete(progress: AutonomyReadingProgress) {
  return progress.traversal.readIndex >= progress.plan.reads.length;
}

/** Removes investigation-only pointers before strict durable-state parsing. */
export function resumeReadingAfterInvestigation(
  progress: AutonomyInvestigatingProgress,
): AutonomyReadingProgress {
  const {
    pageArtifactId: _pageArtifactId,
    investigationAreaIndex: _investigationAreaIndex,
    partialDigestId: _partialDigestId,
    ...reading
  } = progress;
  return { ...reading, stage: "reading" };
}

type ReducibleProgress = AutonomyReadingProgress | AutonomyReducingProgress;

function readingAfterReduction(args: {
  progress: ReducibleProgress;
  levels: (string | null)[];
  workItemId: string;
}): AutonomyReadingProgress {
  if (args.progress.stage === "reading") {
    return {
      ...args.progress,
      completedWorkItemId: args.workItemId,
      reductionLevels: args.levels,
    };
  }
  const { pending: _pending, ...reading } = args.progress;
  return {
    ...reading,
    stage: "reading",
    completedWorkItemId: args.workItemId,
    reductionLevels: args.levels,
  };
}

function nextFinalMerge(
  progress: ReducibleProgress,
  levels: (string | null)[],
  workItemId: string,
): AutonomyReducingProgress | AutonomyFinalizingProgress {
  const occupied = levels.flatMap((digest, level) => (digest === null ? [] : [{ digest, level }]));
  if (occupied.length === 0) throw new Error("The autonomy reduction has no evidence digest.");
  if (occupied.length === 1) {
    const only = occupied[0];
    if (only === undefined) throw new Error("The autonomy final digest is unavailable.");
    const reading = readingAfterReduction({ progress, levels, workItemId });
    return {
      ...reading,
      stage: "finalizing",
      finalDigestId: only.digest,
    };
  }
  const [left, right] = occupied;
  if (left === undefined || right === undefined) {
    throw new Error("The autonomy reduction pair is unavailable.");
  }
  const nextLevels = [...levels];
  nextLevels[left.level] = null;
  nextLevels[right.level] = null;
  return {
    ...progress,
    stage: "reducing",
    completedWorkItemId: workItemId,
    reductionLevels: nextLevels,
    pending: {
      phase: "source",
      left: left.digest,
      right: right.digest,
      targetLevel: Math.max(left.level, right.level) + 1,
      resume: "finalizing",
    },
  };
}

export function queueAutonomyDigest(args: {
  progress: AutonomyReadingProgress | AutonomyReducingProgress;
  digestId: string;
  level: number;
  resume: "reading" | "finalizing";
  workItemId: string;
}): AutonomyReadingProgress | AutonomyReducingProgress | AutonomyFinalizingProgress {
  const levels = [...args.progress.reductionLevels];
  const occupied = levels[args.level];
  if (occupied !== undefined && occupied !== null) {
    levels[args.level] = null;
    return {
      ...args.progress,
      stage: "reducing" as const,
      completedWorkItemId: args.workItemId,
      reductionLevels: levels,
      pending: {
        phase: "source",
        left: occupied,
        right: args.digestId,
        targetLevel: args.level + 1,
        resume: args.resume,
      },
    };
  }
  levels[args.level] = args.digestId;
  if (args.resume === "finalizing") {
    return nextFinalMerge(args.progress, levels, args.workItemId);
  }
  return readingAfterReduction({
    progress: args.progress,
    levels,
    workItemId: args.workItemId,
  });
}

export function investigationAreasForPage(receipt: AutonomyReadReceipt): OperationsHealthArea[] {
  switch (receipt.read) {
    case "operations_health": {
      const areas = [...new Set(receipt.data.signals.map((signal) => signal.area))];
      return areas.length === 0 ? ["system"] : areas;
    }
    case "operations_attention":
    case "review_rounds":
    case "review_exceptions":
      return ["reviews"];
    case "attendance_counts":
    case "attendance_operations":
      return ["attendance"];
    case "incident_readiness":
      return ["system"];
    case "support_load":
    case "participant_deliveries":
      return ["communications"];
    case "intake_jobs":
      return ["intake"];
    case "admission_jobs":
      return ["admissions"];
    case "integration_jobs":
      return ["integrations"];
    case "round_export_jobs":
      return ["scores"];
    case "synesthesia_operations":
      return ["synesthesia"];
  }
}
