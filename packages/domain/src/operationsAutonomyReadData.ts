/** Closed, redacted status vocabulary for exhaustive autonomous operations reads. */
export const operationsAutonomyFailureClasses = [
  "refused",
  "invalid",
  "timeout",
  "rate_limited",
  "failed",
  "delayed",
  "bounced",
  "suppressed",
  "unknown",
  "inaccessible",
  "sync_error",
  "metadata_error",
  "webhook_error",
  "generation_failed",
] as const;
export type OperationsAutonomyFailureClass = (typeof operationsAutonomyFailureClasses)[number];

type OptionalFailure = { failureClass?: OperationsAutonomyFailureClass };

export const operationsAutonomyIntakeJobStates = [
  "running",
  "succeeded",
  "refused",
  "invalid",
  "timed_out",
  "rate_limited",
  "failed",
  "stale",
  "disabled",
] as const;
export const operationsAutonomyAdmissionJobStates = [
  "pending",
  ...operationsAutonomyIntakeJobStates,
] as const;
export const operationsAutonomyParticipantDeliveryStates = [
  "pending",
  "sending",
  "retry_wait",
  "sent",
  "delivery_delayed",
  "delivered",
  "bounced",
  "failed",
  "suppressed",
  "unknown",
  "superseded",
] as const;
export const operationsAutonomyParticipantDeliveryTemplateKeys = [
  "accept",
  "waitlist",
  "decline",
  "needs_information",
  "offer",
  "offer_confirmed",
  "offer_declined",
  "offer_expired",
] as const;
export const operationsAutonomyIntegrationProviders = ["github", "figma"] as const;
export const operationsAutonomyIntegrationStates = [
  "setup",
  "active",
  "inaccessible",
  "revoked",
  "archived",
] as const;
export const operationsAutonomyIntegrationSyncStates = [
  "pending",
  "running",
  "ready",
  "rate_limited",
  "error",
] as const;
export const operationsAutonomyGithubTopicStates = ["present", "missing", "unknown"] as const;
export const operationsAutonomyFigmaWebhookStates = [
  "pending",
  "active",
  "unavailable",
  "error",
] as const;
export const operationsAutonomyRoundExportStates = [
  "generating",
  "uploaded",
  "verified",
  "failed",
  "superseded",
] as const;
export const operationsAutonomySynesthesiaOperationKinds = ["window", "request", "report"] as const;
export const operationsAutonomySynesthesiaWindowStates = ["draft", "published", "closed"] as const;
export const operationsAutonomySynesthesiaRequestStates = [
  "pending",
  "approved",
  "queued",
  "playing",
  "played",
  "skipped",
  "rejected",
  "hidden",
] as const;
export const operationsAutonomySynesthesiaQueueModes = ["normal", "pinned", "deferred"] as const;
export const operationsAutonomySynesthesiaReportStates = ["open", "resolved", "dismissed"] as const;
export const operationsAutonomyIncidentReadinessKinds = ["incident", "emergency_pack"] as const;
export const operationsAutonomyIncidentSeverities = [
  "service_disruption",
  "major",
  "critical",
] as const;
export const operationsAutonomyIncidentServices = ["attendance_backend", "review_backend"] as const;
export const operationsAutonomyIncidentStates = ["open", "monitoring", "resolved"] as const;
export const operationsAutonomyIncidentManualModeStates = [
  "not_requested",
  "pending",
  "approved",
  "closed",
] as const;
export const operationsAutonomyEmergencyPackStates = ["pending", "ready", "failed"] as const;
export const operationsAutonomyAttendanceOperationKinds = [
  "session_job",
  "device",
  "station",
] as const;
export const operationsAutonomyAttendanceSessionJobKinds = [
  "build_expectations",
  "finalize_results",
  "cancel_results",
] as const;
export const operationsAutonomyAttendanceSessionJobStates = [
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
] as const;
export const operationsAutonomyAttendanceDeviceStates = ["active", "revoked"] as const;
export const operationsAutonomyAttendanceStationStates = [
  "inactive",
  "active",
  "disabled",
] as const;

export type OperationsAutonomyIntakeJob = OptionalFailure & {
  jobId: string;
  state: (typeof operationsAutonomyIntakeJobStates)[number];
  policyVersionId: string;
  ordinal: number;
  createdAt: number;
  completedAt?: number;
  latencyMs?: number;
};

export type OperationsAutonomyAdmissionJob = OptionalFailure & {
  jobId: string;
  state: (typeof operationsAutonomyAdmissionJobStates)[number];
  policyVersionId: string;
  modelConfigVersionId?: string;
  applicationContentVersion: number;
  createdAt: number;
  completedAt?: number;
  latencyMs?: number;
};

export type OperationsAutonomyParticipantDelivery = OptionalFailure & {
  deliveryId: string;
  state: (typeof operationsAutonomyParticipantDeliveryStates)[number];
  templateKey: (typeof operationsAutonomyParticipantDeliveryTemplateKeys)[number];
  policyVersionId: string;
  retryNumber: number;
  attemptCount: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  completedAt?: number;
};

type OperationsAutonomyIntegrationJobCommon = OptionalFailure & {
  bindingId: string;
  state: (typeof operationsAutonomyIntegrationStates)[number];
  syncState: (typeof operationsAutonomyIntegrationSyncStates)[number];
  version: number;
  syncRevision: number;
  syncedRevision: number;
  connectedAt: number;
  updatedAt: number;
  leaseExpiresAt?: number;
  retryAt?: number;
};

export type OperationsAutonomyIntegrationJob =
  | (OperationsAutonomyIntegrationJobCommon & {
      provider: "github";
      topicState: (typeof operationsAutonomyGithubTopicStates)[number];
    })
  | (OperationsAutonomyIntegrationJobCommon & {
      provider: "figma";
      webhookState: (typeof operationsAutonomyFigmaWebhookStates)[number];
      lastMetadataCheckAt: number;
      lastFullCaptureAt: number;
    });

export type OperationsAutonomyRoundExportCounts = {
  team: number;
  result: number;
  excluded: number;
  withdrawn: number;
  reviewSession: number;
  scorecard: number;
  scorecardVersion: number;
  correctionCase: number;
  manualReviewRecord: number;
};

export type OperationsAutonomyRoundExportJob = OptionalFailure & {
  exportId: string;
  roundId: string;
  state: (typeof operationsAutonomyRoundExportStates)[number];
  revision: number;
  formatVersion: number;
  closingRoundVersion: number;
  counts: OperationsAutonomyRoundExportCounts;
  version: number;
  requestedAt: number;
  updatedAt: number;
  uploadedAt?: number;
  verifiedAt?: number;
  failedAt?: number;
};

export type OperationsAutonomySynesthesiaOperation =
  | {
      kind: "window";
      windowId: string;
      status: (typeof operationsAutonomySynesthesiaWindowStates)[number];
      requestsOpen: boolean;
      votingOpen: boolean;
      playbackPaused: boolean;
      version: number;
      startsAt: number;
      endsAt: number;
      updatedAt: number;
    }
  | {
      kind: "request";
      requestId: string;
      windowId: string;
      state: (typeof operationsAutonomySynesthesiaRequestStates)[number];
      queueMode: (typeof operationsAutonomySynesthesiaQueueModes)[number];
      openReportCount: number;
      version: number;
      createdAt: number;
      updatedAt: number;
      scheduledFor?: number;
      playbackStartedAt?: number;
      playbackFinishedAt?: number;
    }
  | {
      kind: "report";
      reportId: string;
      windowId: string;
      requestId: string;
      state: (typeof operationsAutonomySynesthesiaReportStates)[number];
      version: number;
      createdAt: number;
      updatedAt: number;
      resolvedAt?: number;
    };

export type OperationsAutonomyIncidentReadinessItem =
  | {
      kind: "incident";
      incidentId: string;
      severity: (typeof operationsAutonomyIncidentSeverities)[number];
      affectedService: (typeof operationsAutonomyIncidentServices)[number];
      state: (typeof operationsAutonomyIncidentStates)[number];
      manualModeState: (typeof operationsAutonomyIncidentManualModeStates)[number];
      manualModeApprovalCount: number;
      version: number;
      openedAt: number;
      updatedAt: number;
      resolvedAt?: number;
    }
  | (OptionalFailure & {
      kind: "emergency_pack";
      packId: string;
      status: (typeof operationsAutonomyEmergencyPackStates)[number];
      version: number;
      requestedAt: number;
      expiresAt: number;
      completedAt?: number;
      failedAt?: number;
      counts?: {
        participants: number;
        teams: number;
        stations: number;
        sessions: number;
        rounds: number;
        panels: number;
        attendanceSheets: number;
        reviewSheets: number;
      };
    });

export type OperationsAutonomyAttendanceOperation =
  | (OptionalFailure & {
      kind: "session_job";
      jobId: string;
      sessionId: string;
      jobKind: (typeof operationsAutonomyAttendanceSessionJobKinds)[number];
      status: (typeof operationsAutonomyAttendanceSessionJobStates)[number];
      scannedCount: number;
      affectedCount: number;
      revision: number;
      createdAt: number;
      updatedAt: number;
      completedAt?: number;
    })
  | {
      kind: "device";
      deviceId: string;
      status: (typeof operationsAutonomyAttendanceDeviceStates)[number];
      pendingReplayCount: number;
      revision: number;
      registeredAt: number;
      lastSeenAt?: number;
      oldestPendingCapturedAt?: number;
    }
  | {
      kind: "station";
      stationId: string;
      status: (typeof operationsAutonomyAttendanceStationStates)[number];
      configurationVersion: number;
      createdAt: number;
      updatedAt: number;
      validFrom?: number;
      validUntil?: number;
    };

export type OperationsAutonomyReadDataByTool = {
  intake_jobs: { generatedAt: number; jobs: OperationsAutonomyIntakeJob[] };
  admission_jobs: { generatedAt: number; jobs: OperationsAutonomyAdmissionJob[] };
  participant_deliveries: {
    generatedAt: number;
    deliveries: OperationsAutonomyParticipantDelivery[];
  };
  integration_jobs: { generatedAt: number; bindings: OperationsAutonomyIntegrationJob[] };
  round_export_jobs: { generatedAt: number; exports: OperationsAutonomyRoundExportJob[] };
  synesthesia_operations: {
    generatedAt: number;
    operations: OperationsAutonomySynesthesiaOperation[];
  };
  incident_readiness: {
    generatedAt: number;
    items: OperationsAutonomyIncidentReadinessItem[];
  };
  attendance_operations: {
    generatedAt: number;
    operations: OperationsAutonomyAttendanceOperation[];
  };
};

export type OperationsAutonomyDeepReadTool = keyof OperationsAutonomyReadDataByTool;
export type OperationsAutonomyDeepReadData<Read extends OperationsAutonomyDeepReadTool> =
  OperationsAutonomyReadDataByTool[Read];
