import {
  operationsAutonomyAdmissionJobStates,
  operationsAutonomyAttendanceDeviceStates,
  operationsAutonomyAttendanceSessionJobKinds,
  operationsAutonomyAttendanceSessionJobStates,
  operationsAutonomyAttendanceStationStates,
  operationsAutonomyEmergencyPackStates,
  operationsAutonomyFailureClasses,
  operationsAutonomyGithubTopicStates,
  operationsAutonomyIncidentManualModeStates,
  operationsAutonomyIncidentServices,
  operationsAutonomyIncidentSeverities,
  operationsAutonomyIncidentStates,
  operationsAutonomyIntakeJobStates,
  operationsAutonomyIntegrationStates,
  operationsAutonomyIntegrationSyncStates,
  operationsAutonomyParticipantDeliveryStates,
  operationsAutonomyParticipantDeliveryTemplateKeys,
  operationsAutonomyRoundExportStates,
  operationsAutonomySynesthesiaQueueModes,
  operationsAutonomySynesthesiaReportStates,
  operationsAutonomySynesthesiaRequestStates,
  operationsAutonomySynesthesiaWindowStates,
} from "@code2create/domain";
import * as v from "valibot";

const boundedId = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const maximumDeepReadRows = 4;

const optionalFailure = {
  failureClass: v.optional(v.picklist(operationsAutonomyFailureClasses)),
};

const intakeJobSchema = v.strictObject({
  jobId: boundedId,
  state: v.picklist(operationsAutonomyIntakeJobStates),
  policyVersionId: boundedId,
  ordinal: nonNegativeInteger,
  createdAt: nonNegativeInteger,
  completedAt: v.optional(nonNegativeInteger),
  latencyMs: v.optional(nonNegativeInteger),
  ...optionalFailure,
});

const admissionJobSchema = v.strictObject({
  jobId: boundedId,
  state: v.picklist(operationsAutonomyAdmissionJobStates),
  policyVersionId: boundedId,
  modelConfigVersionId: v.optional(boundedId),
  applicationContentVersion: nonNegativeInteger,
  createdAt: nonNegativeInteger,
  completedAt: v.optional(nonNegativeInteger),
  latencyMs: v.optional(nonNegativeInteger),
  ...optionalFailure,
});

const participantDeliverySchema = v.strictObject({
  deliveryId: boundedId,
  state: v.picklist(operationsAutonomyParticipantDeliveryStates),
  templateKey: v.picklist(operationsAutonomyParticipantDeliveryTemplateKeys),
  policyVersionId: boundedId,
  retryNumber: nonNegativeInteger,
  attemptCount: nonNegativeInteger,
  version: nonNegativeInteger,
  createdAt: nonNegativeInteger,
  updatedAt: nonNegativeInteger,
  nextAttemptAt: v.optional(nonNegativeInteger),
  completedAt: v.optional(nonNegativeInteger),
  ...optionalFailure,
});

const integrationCommon = {
  bindingId: boundedId,
  state: v.picklist(operationsAutonomyIntegrationStates),
  syncState: v.picklist(operationsAutonomyIntegrationSyncStates),
  version: nonNegativeInteger,
  syncRevision: nonNegativeInteger,
  syncedRevision: nonNegativeInteger,
  connectedAt: nonNegativeInteger,
  updatedAt: nonNegativeInteger,
  leaseExpiresAt: v.optional(nonNegativeInteger),
  retryAt: v.optional(nonNegativeInteger),
  ...optionalFailure,
};
const integrationJobSchema = v.variant("provider", [
  v.strictObject({
    provider: v.literal("github"),
    ...integrationCommon,
    topicState: v.picklist(operationsAutonomyGithubTopicStates),
  }),

]);

const roundExportCountsSchema = v.strictObject({
  team: nonNegativeInteger,
  result: nonNegativeInteger,
  excluded: nonNegativeInteger,
  withdrawn: nonNegativeInteger,
  reviewSession: nonNegativeInteger,
  scorecard: nonNegativeInteger,
  scorecardVersion: nonNegativeInteger,
  correctionCase: nonNegativeInteger,
  manualReviewRecord: nonNegativeInteger,
});
const roundExportJobSchema = v.strictObject({
  exportId: boundedId,
  roundId: boundedId,
  state: v.picklist(operationsAutonomyRoundExportStates),
  revision: nonNegativeInteger,
  formatVersion: nonNegativeInteger,
  closingRoundVersion: nonNegativeInteger,
  counts: roundExportCountsSchema,
  version: nonNegativeInteger,
  requestedAt: nonNegativeInteger,
  updatedAt: nonNegativeInteger,
  uploadedAt: v.optional(nonNegativeInteger),
  verifiedAt: v.optional(nonNegativeInteger),
  failedAt: v.optional(nonNegativeInteger),
  ...optionalFailure,
});

const synesthesiaOperationSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("window"),
    windowId: boundedId,
    status: v.picklist(operationsAutonomySynesthesiaWindowStates),
    requestsOpen: v.boolean(),
    votingOpen: v.boolean(),
    playbackPaused: v.boolean(),
    version: nonNegativeInteger,
    startsAt: nonNegativeInteger,
    endsAt: nonNegativeInteger,
    updatedAt: nonNegativeInteger,
  }),
  v.strictObject({
    kind: v.literal("request"),
    requestId: boundedId,
    windowId: boundedId,
    state: v.picklist(operationsAutonomySynesthesiaRequestStates),
    queueMode: v.picklist(operationsAutonomySynesthesiaQueueModes),
    openReportCount: nonNegativeInteger,
    version: nonNegativeInteger,
    createdAt: nonNegativeInteger,
    updatedAt: nonNegativeInteger,
    scheduledFor: v.optional(nonNegativeInteger),
    playbackStartedAt: v.optional(nonNegativeInteger),
    playbackFinishedAt: v.optional(nonNegativeInteger),
  }),
  v.strictObject({
    kind: v.literal("report"),
    reportId: boundedId,
    windowId: boundedId,
    requestId: boundedId,
    state: v.picklist(operationsAutonomySynesthesiaReportStates),
    version: nonNegativeInteger,
    createdAt: nonNegativeInteger,
    updatedAt: nonNegativeInteger,
    resolvedAt: v.optional(nonNegativeInteger),
  }),
]);

const incidentReadinessSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("incident"),
    incidentId: boundedId,
    severity: v.picklist(operationsAutonomyIncidentSeverities),
    affectedService: v.picklist(operationsAutonomyIncidentServices),
    state: v.picklist(operationsAutonomyIncidentStates),
    manualModeState: v.picklist(operationsAutonomyIncidentManualModeStates),
    manualModeApprovalCount: nonNegativeInteger,
    version: nonNegativeInteger,
    openedAt: nonNegativeInteger,
    updatedAt: nonNegativeInteger,
    resolvedAt: v.optional(nonNegativeInteger),
  }),
  v.strictObject({
    kind: v.literal("emergency_pack"),
    packId: boundedId,
    status: v.picklist(operationsAutonomyEmergencyPackStates),
    version: nonNegativeInteger,
    requestedAt: nonNegativeInteger,
    expiresAt: nonNegativeInteger,
    completedAt: v.optional(nonNegativeInteger),
    failedAt: v.optional(nonNegativeInteger),
    counts: v.optional(
      v.strictObject({
        participants: nonNegativeInteger,
        teams: nonNegativeInteger,
        stations: nonNegativeInteger,
        sessions: nonNegativeInteger,
        rounds: nonNegativeInteger,
        panels: nonNegativeInteger,
        attendanceSheets: nonNegativeInteger,
        reviewSheets: nonNegativeInteger,
      }),
    ),
    ...optionalFailure,
  }),
]);

const attendanceOperationSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("session_job"),
    jobId: boundedId,
    sessionId: boundedId,
    jobKind: v.picklist(operationsAutonomyAttendanceSessionJobKinds),
    status: v.picklist(operationsAutonomyAttendanceSessionJobStates),
    scannedCount: nonNegativeInteger,
    affectedCount: nonNegativeInteger,
    revision: nonNegativeInteger,
    createdAt: nonNegativeInteger,
    updatedAt: nonNegativeInteger,
    completedAt: v.optional(nonNegativeInteger),
    ...optionalFailure,
  }),
  v.strictObject({
    kind: v.literal("device"),
    deviceId: boundedId,
    status: v.picklist(operationsAutonomyAttendanceDeviceStates),
    pendingReplayCount: nonNegativeInteger,
    revision: nonNegativeInteger,
    registeredAt: nonNegativeInteger,
    lastSeenAt: v.optional(nonNegativeInteger),
    oldestPendingCapturedAt: v.optional(nonNegativeInteger),
  }),
  v.strictObject({
    kind: v.literal("station"),
    stationId: boundedId,
    status: v.picklist(operationsAutonomyAttendanceStationStates),
    configurationVersion: nonNegativeInteger,
    createdAt: nonNegativeInteger,
    updatedAt: nonNegativeInteger,
    validFrom: v.optional(nonNegativeInteger),
    validUntil: v.optional(nonNegativeInteger),
  }),
]);

const deepRows = <const Schema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: Schema,
) => v.pipe(v.array(schema), v.maxLength(maximumDeepReadRows));

export const autonomyDeepReadSchemas = {
  intake_jobs: v.strictObject({ generatedAt: nonNegativeInteger, jobs: deepRows(intakeJobSchema) }),
  admission_jobs: v.strictObject({
    generatedAt: nonNegativeInteger,
    jobs: deepRows(admissionJobSchema),
  }),
  participant_deliveries: v.strictObject({
    generatedAt: nonNegativeInteger,
    deliveries: deepRows(participantDeliverySchema),
  }),
  integration_jobs: v.strictObject({
    generatedAt: nonNegativeInteger,
    bindings: deepRows(integrationJobSchema),
  }),
  round_export_jobs: v.strictObject({
    generatedAt: nonNegativeInteger,
    exports: deepRows(roundExportJobSchema),
  }),
  synesthesia_operations: v.strictObject({
    generatedAt: nonNegativeInteger,
    operations: deepRows(synesthesiaOperationSchema),
  }),
  incident_readiness: v.strictObject({
    generatedAt: nonNegativeInteger,
    items: deepRows(incidentReadinessSchema),
  }),
  attendance_operations: v.strictObject({
    generatedAt: nonNegativeInteger,
    operations: deepRows(attendanceOperationSchema),
  }),
} as const;
