import { v } from "convex/values";

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

export const operationsAutonomyDeepReadSources = [
  "intake_jobs",
  "admission_jobs",
  "participant_deliveries",
  "integration_jobs",
  "round_export_jobs",
  "synesthesia_operations",
  "incident_readiness",
  "attendance_operations",
] as const;

export const operationsAutonomyFailureClass = v.union(
  ...operationsAutonomyFailureClasses.map((value) => v.literal(value)),
);

export const operationsAutonomyIntakeJobFact = v.object({
  jobId: v.id("intakeInterpretations"),
  state: v.union(...operationsAutonomyIntakeJobStates.map((value) => v.literal(value))),
  policyVersionId: v.id("intakePolicyVersions"),
  ordinal: v.number(),
  createdAt: v.number(),
  completedAt: v.optional(v.number()),
  latencyMs: v.optional(v.number()),
  failureClass: v.optional(operationsAutonomyFailureClass),
});

export const operationsAutonomyAdmissionJobFact = v.object({
  jobId: v.id("admissionAIRecommendations"),
  state: v.union(...operationsAutonomyAdmissionJobStates.map((value) => v.literal(value))),
  policyVersionId: v.id("admissionPolicyVersions"),
  modelConfigVersionId: v.optional(v.id("admissionModelConfigVersions")),
  applicationContentVersion: v.number(),
  createdAt: v.number(),
  completedAt: v.optional(v.number()),
  latencyMs: v.optional(v.number()),
  failureClass: v.optional(operationsAutonomyFailureClass),
});

export const operationsAutonomyParticipantDeliveryFact = v.object({
  deliveryId: v.id("participantNotificationDeliveries"),
  state: v.union(...operationsAutonomyParticipantDeliveryStates.map((value) => v.literal(value))),
  templateKey: v.union(
    ...operationsAutonomyParticipantDeliveryTemplateKeys.map((value) => v.literal(value)),
  ),
  policyVersionId: v.id("communicationsPolicyVersions"),
  retryNumber: v.number(),
  attemptCount: v.number(),
  version: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  nextAttemptAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  failureClass: v.optional(operationsAutonomyFailureClass),
});

const integrationCommon = {
  bindingId: v.string(),
  state: v.union(...operationsAutonomyIntegrationStates.map((value) => v.literal(value))),
  syncState: v.union(...operationsAutonomyIntegrationSyncStates.map((value) => v.literal(value))),
  version: v.number(),
  syncRevision: v.number(),
  syncedRevision: v.number(),
  connectedAt: v.number(),
  updatedAt: v.number(),
  leaseExpiresAt: v.optional(v.number()),
  retryAt: v.optional(v.number()),
  failureClass: v.optional(operationsAutonomyFailureClass),
};

export const operationsAutonomyIntegrationJobFact = v.object({
  provider: v.literal("github"),
  ...integrationCommon,
  bindingId: v.id("githubRepositoryBindings"),
  topicState: v.union(...operationsAutonomyGithubTopicStates.map(value => v.literal(value))),
});

export const operationsAutonomyRoundExportJobFact = v.object({
  exportId: v.id("roundExports"),
  roundId: v.id("reviewRounds"),
  state: v.union(...operationsAutonomyRoundExportStates.map((value) => v.literal(value))),
  revision: v.number(),
  formatVersion: v.number(),
  closingRoundVersion: v.number(),
  counts: v.object({
    team: v.number(),
    result: v.number(),
    excluded: v.number(),
    withdrawn: v.number(),
    reviewSession: v.number(),
    scorecard: v.number(),
    scorecardVersion: v.number(),
    correctionCase: v.number(),
    manualReviewRecord: v.number(),
  }),
  version: v.number(),
  requestedAt: v.number(),
  updatedAt: v.number(),
  uploadedAt: v.optional(v.number()),
  verifiedAt: v.optional(v.number()),
  failedAt: v.optional(v.number()),
  failureClass: v.optional(operationsAutonomyFailureClass),
});

export const operationsAutonomySynesthesiaOperationFact = v.union(
  v.object({
    kind: v.literal("window"),
    windowId: v.id("synesthesiaWindows"),
    status: v.union(...operationsAutonomySynesthesiaWindowStates.map((value) => v.literal(value))),
    requestsOpen: v.boolean(),
    votingOpen: v.boolean(),
    playbackPaused: v.boolean(),
    version: v.number(),
    startsAt: v.number(),
    endsAt: v.number(),
    updatedAt: v.number(),
  }),
  v.object({
    kind: v.literal("request"),
    requestId: v.id("songRequests"),
    windowId: v.id("synesthesiaWindows"),
    state: v.union(...operationsAutonomySynesthesiaRequestStates.map((value) => v.literal(value))),
    queueMode: v.union(...operationsAutonomySynesthesiaQueueModes.map((value) => v.literal(value))),
    openReportCount: v.number(),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    scheduledFor: v.optional(v.number()),
    playbackStartedAt: v.optional(v.number()),
    playbackFinishedAt: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("report"),
    reportId: v.id("synesthesiaReports"),
    windowId: v.id("synesthesiaWindows"),
    requestId: v.id("songRequests"),
    state: v.union(...operationsAutonomySynesthesiaReportStates.map((value) => v.literal(value))),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
  }),
);

export const operationsAutonomyIncidentReadinessFact = v.union(
  v.object({
    kind: v.literal("incident"),
    incidentId: v.id("incidents"),
    severity: v.union(...operationsAutonomyIncidentSeverities.map((value) => v.literal(value))),
    affectedService: v.union(
      ...operationsAutonomyIncidentServices.map((value) => v.literal(value)),
    ),
    state: v.union(...operationsAutonomyIncidentStates.map((value) => v.literal(value))),
    manualModeState: v.union(
      ...operationsAutonomyIncidentManualModeStates.map((value) => v.literal(value)),
    ),
    manualModeApprovalCount: v.number(),
    version: v.number(),
    openedAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("emergency_pack"),
    packId: v.id("emergencyPacks"),
    status: v.union(...operationsAutonomyEmergencyPackStates.map((value) => v.literal(value))),
    version: v.number(),
    requestedAt: v.number(),
    expiresAt: v.number(),
    completedAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    failureClass: v.optional(operationsAutonomyFailureClass),
    counts: v.optional(
      v.object({
        participants: v.number(),
        teams: v.number(),
        stations: v.number(),
        sessions: v.number(),
        rounds: v.number(),
        panels: v.number(),
        attendanceSheets: v.number(),
        reviewSheets: v.number(),
      }),
    ),
  }),
);

export const operationsAutonomyAttendanceOperationFact = v.union(
  v.object({
    kind: v.literal("session_job"),
    jobId: v.id("attendanceSessionJobs"),
    sessionId: v.id("attendanceSessions"),
    jobKind: v.union(
      ...operationsAutonomyAttendanceSessionJobKinds.map((value) => v.literal(value)),
    ),
    status: v.union(
      ...operationsAutonomyAttendanceSessionJobStates.map((value) => v.literal(value)),
    ),
    scannedCount: v.number(),
    affectedCount: v.number(),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    failureClass: v.optional(operationsAutonomyFailureClass),
  }),
  v.object({
    kind: v.literal("device"),
    deviceId: v.id("attendanceDeviceInstallations"),
    status: v.union(...operationsAutonomyAttendanceDeviceStates.map((value) => v.literal(value))),
    pendingReplayCount: v.number(),
    revision: v.number(),
    registeredAt: v.number(),
    lastSeenAt: v.optional(v.number()),
    oldestPendingCapturedAt: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("station"),
    stationId: v.id("attendanceStations"),
    status: v.union(...operationsAutonomyAttendanceStationStates.map((value) => v.literal(value))),
    configurationVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    validFrom: v.optional(v.number()),
    validUntil: v.optional(v.number()),
  }),
);
