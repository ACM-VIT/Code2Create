import {
  intelligenceRecommendationKinds,
  operationsAutonomyCancellationReasons,
  operationsAutonomyCallbackStatuses,
  operationsAutonomyModes,
  operationsAutonomyPublicLifecycleOperations,
  operationsAutonomyPublicLifecycleRoles,
  operationsAutonomyPublicLifecycleStatuses,
  operationsAutonomyReadTools,
  operationsAutonomyRunPhases,
  operationsAutonomyTriggers,
  operationsHealthAreas,
  operationsHealthSeverities,
  operationsHealthSignalKeys,
  operationsIntelligenceProtocolVersion,
} from "@code2create/domain";
import * as v from "valibot";

import {
  autonomyRecommendationArgumentsSchema,
  operationsHealthSnapshotSchema,
  platformReadSchemas,
} from "../protocol.ts";
import { autonomyPlaybookNames } from "./autonomyPlaybooks.ts";

const boundedText = (minimum: number, maximum: number) =>
  v.pipe(v.string(), v.minLength(minimum), v.maxLength(maximum));
const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positiveInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const checksum = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const opaqueId = boundedText(1, 200);
const operationId = v.pipe(boundedText(1, 240), v.regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u));
const evidenceRecordId = v.pipe(v.string(), v.regex(/^record-[a-f0-9]{64}$/u));
const evidencePairId = v.pipe(v.string(), v.regex(/^record-[a-f0-9]{64}\.record-[a-f0-9]{64}$/u));

const uniqueValues = <Value>(values: Value[]) => new Set(values).size === values.length;

const frozenPolicySchema = v.pipe(
  v.strictObject({
    policyVersionId: opaqueId,
    policyVersion: positiveInteger,
    policyChecksum: checksum,
    mode: v.picklist(operationsAutonomyModes),
    escalationSeverity: v.picklist(["attention", "critical"]),
    allowedReadTools: v.pipe(
      v.array(v.picklist(operationsAutonomyReadTools)),
      v.minLength(1),
      v.maxLength(operationsAutonomyReadTools.length),
    ),
    allowedRecommendationKinds: v.pipe(
      v.array(v.picklist(intelligenceRecommendationKinds)),
      v.maxLength(intelligenceRecommendationKinds.length),
    ),
  }),
  v.check((policy) => uniqueValues(policy.allowedReadTools), "Autonomy read tools must be unique."),
  v.check(
    (policy) => uniqueValues(policy.allowedRecommendationKinds),
    "Autonomy recommendation kinds must be unique.",
  ),
  v.check(
    (policy) => policy.allowedReadTools.includes("operations_health"),
    "Autonomy policy must authorize the current operations-health read.",
  ),
  v.check(
    (policy) =>
      policy.mode === "observe"
        ? policy.allowedRecommendationKinds.length === 0
        : policy.allowedRecommendationKinds.length > 0,
    "Observe mode cannot publish recommendations, while recommend mode requires an effect allowlist.",
  ),
);

export const operationsAutonomyDispatchRequestSchema = v.strictObject({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  trigger: v.picklist(operationsAutonomyTriggers),
  runId: opaqueId,
  eventSlug: v.pipe(boundedText(1, 120), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)),
  policy: frozenPolicySchema,
  source: v.strictObject({
    sourceChecksum: checksum,
    snapshot: operationsHealthSnapshotSchema,
  }),
});

export type OperationsAutonomyInput = v.InferOutput<typeof operationsAutonomyDispatchRequestSchema>;

export const operationsAutonomyAbortRequestSchema = v.strictObject({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  runId: opaqueId,
  reason: v.picklist(operationsAutonomyCancellationReasons),
  operationId,
});

export type OperationsAutonomyAbortInput = v.InferOutput<
  typeof operationsAutonomyAbortRequestSchema
>;

export const operationsAutonomyContinuationRequestSchema = v.strictObject({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  runId: opaqueId,
  operationId,
  priorSubmissionId: opaqueId,
  workItemId: operationId,
});

export type OperationsAutonomyContinuationInput = v.InferOutput<
  typeof operationsAutonomyContinuationRequestSchema
>;

export const operationsAutonomyWorkReceiptSchema = v.strictObject({
  state: v.literal("accepted"),
  sequence: positiveInteger,
});

const opaqueCursor = boundedText(1, 1_024);
const pageSchema = v.pipe(
  v.strictObject({
    cursor: v.optional(opaqueCursor),
    isDone: v.boolean(),
    snapshot: opaqueId,
  }),
  v.check(
    (page) => (page.isDone ? page.cursor === undefined : page.cursor !== undefined),
    "A completed read page has no cursor, and an incomplete page must provide one.",
  ),
);
const autonomyReadReceiptBase = {
  state: v.literal("accepted"),
  sequence: positiveInteger,
  page: pageSchema,
};

/**
 * Signed responses are still external input. The read discriminator owns the
 * exact redacted projection that may reach a prompt; no unbounded value can
 * cross this parser.
 */
export const operationsAutonomyReadReceiptSchema = v.variant("read", [
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("operations_health"),
    data: platformReadSchemas.operations_health,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("operations_attention"),
    data: platformReadSchemas.operations_attention,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("review_rounds"),
    data: platformReadSchemas.review_rounds,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("review_exceptions"),
    data: platformReadSchemas.review_exceptions,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("attendance_counts"),
    data: platformReadSchemas.attendance_counts,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("floor_mapping_progress"),
    data: platformReadSchemas.floor_mapping_progress,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("support_load"),
    data: platformReadSchemas.support_load,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("intake_jobs"),
    data: platformReadSchemas.intake_jobs,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("admission_jobs"),
    data: platformReadSchemas.admission_jobs,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("participant_deliveries"),
    data: platformReadSchemas.participant_deliveries,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("integration_jobs"),
    data: platformReadSchemas.integration_jobs,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("round_export_jobs"),
    data: platformReadSchemas.round_export_jobs,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("synesthesia_operations"),
    data: platformReadSchemas.synesthesia_operations,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("incident_readiness"),
    data: platformReadSchemas.incident_readiness,
  }),
  v.strictObject({
    ...autonomyReadReceiptBase,
    read: v.literal("attendance_operations"),
    data: platformReadSchemas.attendance_operations,
  }),
]);

export const operationsAutonomyRecommendationReceiptSchema = v.strictObject({
  state: v.literal("accepted"),
  sequence: positiveInteger,
  recommendationId: opaqueId,
});

export const operationsAutonomyCallbackReceiptSchema = v.strictObject({
  state: v.literal("accepted"),
  sequence: positiveInteger,
  runState: v.picklist([
    "pending",
    "leased",
    "accepted",
    "running",
    "succeeded",
    "no_op",
    "escalated",
    "failed",
    "canceled",
  ]),
});

export const autonomyPlannerResultSchema = v.pipe(
  v.strictObject({
    playbooks: v.pipe(
      v.array(v.picklist(autonomyPlaybookNames)),
      v.maxLength(autonomyPlaybookNames.length),
    ),
    focusSignalKeys: v.pipe(v.array(v.picklist(operationsHealthSignalKeys)), v.maxLength(16)),
    reads: v.pipe(
      v.array(v.picklist(operationsAutonomyReadTools)),
      v.maxLength(operationsAutonomyReadTools.length),
    ),
  }),
  v.check((plan) => uniqueValues(plan.playbooks), "Playbooks must be unique."),
  v.check((plan) => uniqueValues(plan.focusSignalKeys), "Signal keys must be unique."),
  v.check((plan) => uniqueValues(plan.reads), "Reads must be unique."),
);

export const autonomyCitationSchema = v.strictObject({
  read: v.picklist(operationsAutonomyReadTools),
  generatedAt: nonNegativeInteger,
  operationId,
  snapshot: opaqueId,
  keys: v.pipe(v.array(boundedText(1, 200)), v.minLength(1), v.maxLength(16)),
});

export const autonomyCandidateRecommendationSchema = v.strictObject({
  statement: boundedText(10, 300),
  reasoning: boundedText(10, 1_500),
  citations: v.pipe(v.array(autonomyCitationSchema), v.minLength(1), v.maxLength(8)),
  arguments: autonomyRecommendationArgumentsSchema,
  supportRecordIds: v.optional(
    v.pipe(
      v.array(evidenceRecordId),
      v.minLength(1),
      v.maxLength(4),
      v.check(uniqueValues, "Candidate support records must be unique."),
    ),
  ),
});

export const autonomyEvidenceFindingSchema = v.strictObject({
  statement: boundedText(10, 400),
  uncertainty: boundedText(10, 300),
  citations: v.pipe(v.array(autonomyCitationSchema), v.minLength(1), v.maxLength(8)),
  supportRecordIds: v.optional(
    v.pipe(
      v.array(evidenceRecordId),
      v.minLength(1),
      v.maxLength(4),
      v.check(uniqueValues, "Finding support records must be unique."),
    ),
  ),
});

export const autonomyEvidenceDigestContentSchema = v.strictObject({
  summary: boundedText(10, 1_000),
  findings: v.pipe(v.array(autonomyEvidenceFindingSchema), v.maxLength(8)),
  observedSignalKeys: v.pipe(v.array(v.picklist(operationsHealthSignalKeys)), v.maxLength(16)),
});

export const autonomyInvestigatorResultSchema = v.pipe(
  v.strictObject({
    area: v.picklist(operationsHealthAreas),
    observedSignalKeys: v.pipe(v.array(v.picklist(operationsHealthSignalKeys)), v.maxLength(16)),
    digest: autonomyEvidenceDigestContentSchema,
    candidates: v.pipe(v.array(autonomyCandidateRecommendationSchema), v.maxLength(16)),
    complete: v.boolean(),
  }),
  v.check(
    (result) => uniqueValues(result.observedSignalKeys),
    "Observed signal keys must be unique.",
  ),
  v.check(
    (result) =>
      uniqueValues(result.candidates.map((candidate) => JSON.stringify(candidate.arguments))),
    "Candidate effects must be unique within an investigation.",
  ),
  v.check(
    (result) =>
      [...result.digest.findings, ...result.candidates].every(
        (record) => record.supportRecordIds === undefined,
      ),
    "Source investigation records cannot name derived support records.",
  ),
);

export const autonomyDigestMergeResultSchema = v.pipe(
  v.strictObject({
    digest: autonomyEvidenceDigestContentSchema,
    candidates: v.pipe(v.array(autonomyCandidateRecommendationSchema), v.maxLength(16)),
    complete: v.boolean(),
  }),
  v.check(
    (result) =>
      uniqueValues(result.candidates.map((candidate) => JSON.stringify(candidate.arguments))),
    "Merged candidate effects must be unique.",
  ),
);

export const autonomySynthesisResultSchema = v.pipe(
  v.strictObject({
    digest: autonomyEvidenceDigestContentSchema,
    candidates: v.pipe(v.array(autonomyCandidateRecommendationSchema), v.maxLength(16)),
    reviewedPairIds: v.pipe(v.array(evidencePairId), v.minLength(1), v.maxLength(4)),
    complete: v.boolean(),
  }),
  v.check(
    (result) => uniqueValues(result.reviewedPairIds),
    "Synthesis pair acknowledgements must be unique.",
  ),
  v.check(
    (result) =>
      uniqueValues(result.candidates.map((candidate) => JSON.stringify(candidate.arguments))),
    "Synthesized candidate effects must be unique.",
  ),
  v.check(
    (result) =>
      [...result.digest.findings, ...result.candidates].every(
        (record) => record.supportRecordIds !== undefined,
      ),
    "Derived synthesis records require exact direct support records.",
  ),
);

export const autonomyHypothesisSynthesisResultSchema = v.pipe(
  v.strictObject({
    digest: autonomyEvidenceDigestContentSchema,
    candidates: v.pipe(v.array(autonomyCandidateRecommendationSchema), v.maxLength(16)),
    reviewedHypothesisRecordIds: v.pipe(v.array(evidenceRecordId), v.minLength(1), v.maxLength(4)),
    reviewedSourceRecordIds: v.pipe(v.array(evidenceRecordId), v.minLength(1), v.maxLength(8)),
    complete: v.boolean(),
  }),
  v.check(
    (result) => uniqueValues(result.reviewedHypothesisRecordIds),
    "Hypothesis record acknowledgements must be unique.",
  ),
  v.check(
    (result) => uniqueValues(result.reviewedSourceRecordIds),
    "Hypothesis source-record acknowledgements must be unique.",
  ),
  v.check(
    (result) =>
      uniqueValues(result.candidates.map((candidate) => JSON.stringify(candidate.arguments))),
    "Hypothesis candidate effects must be unique.",
  ),
  v.check(
    (result) =>
      [...result.digest.findings, ...result.candidates].every(
        (record) => record.supportRecordIds !== undefined,
      ),
    "Derived hypothesis records require exact direct support records.",
  ),
);

export const autonomyCandidateAdjudicationResultSchema = v.pipe(
  v.strictObject({
    reviewedFindingRecordIds: v.pipe(v.array(evidenceRecordId), v.minLength(1), v.maxLength(8)),
    decision: v.picklist(["approve", "suppress"]),
  }),
  v.check(
    (result) => uniqueValues(result.reviewedFindingRecordIds),
    "Adjudicated finding record ids must be unique.",
  ),
);

export const autonomyCriticResultSchema = v.pipe(
  v.strictObject({
    approvedCandidateIndexes: v.pipe(v.array(nonNegativeInteger), v.maxLength(64)),
  }),
  v.check(
    (result) => uniqueValues(result.approvedCandidateIndexes),
    "Approved candidate indexes must be unique.",
  ),
);

export function validateCriticCandidateIndexes(
  approvedCandidateIndexes: readonly number[],
  candidateCount: number,
) {
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 0) {
    throw new Error("The critic candidate count is invalid.");
  }
  if (approvedCandidateIndexes.some((index) => index >= candidateCount)) {
    throw new Error("The critic selected a candidate index outside the reviewed set.");
  }
}

export const autonomyLifecycleDataSchema = v.strictObject({
  operation: v.picklist(operationsAutonomyPublicLifecycleOperations),
  phase: v.picklist(operationsAutonomyRunPhases),
  role: v.picklist(operationsAutonomyPublicLifecycleRoles),
  status: v.picklist(operationsAutonomyPublicLifecycleStatuses),
  durationMs: v.optional(v.pipe(nonNegativeInteger, v.maxValue(24 * 60 * 60 * 1_000))),
});

export const operationsAutonomyCallbackStatusSchema = v.picklist(
  operationsAutonomyCallbackStatuses,
);

export const operationsHealthAreaSchema = v.picklist(operationsHealthAreas);
export const operationsHealthSeveritySchema = v.picklist(operationsHealthSeverities);
export const autonomyOperationIdSchema = operationId;
