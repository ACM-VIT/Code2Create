import {
  venueConfirmationCall,
  venueCallResponseValue,
  venueResponseEffect,
} from "./lib/venueCallValidators";
import { defineSchema, defineTable } from "convex/server";
import { outingPhase, outingScanDecision } from "./lib/outingValues";
import {
  reviewerVenueStatus,
  venuePolicyFields,
} from "./lib/reviewerVenuePolicy";
import { v } from "convex/values";
import { projectReviewAssessment } from "./lib/reviewPlanningFields";

import {
  reviewEvidenceCheckpointFields,
  reviewEvidenceAnalysis,
  reviewEvidenceCoverage,
  reviewQuestionPolicy,
  reviewQuestionSource,
  reviewSuggestedQuestion,
  admissionAiDisposition,
  admissionDecision,
  admissionDecisionStage,
  admissionExperienceBand,
  admissionOfferState,
  admissionRecommendationState,
  admissionReviewAssignmentState,
  applicationState,
  attendanceCredentialKind,
  attendanceCorrectionKind,
  attendanceExpectationBuildState,
  attendancePresenceOutcome,
  attendancePresenceSourceKind,
  attendancePresenceTransition,
  attendanceScannerCredentialKind,
  attendanceSessionJobKind,
  attendanceSessionJobStatus,
  attendanceSessionExpectation,
  attendanceSessionKind,
  attendanceSessionRequirement,
  attendanceSessionResult,
  attendanceSessionStatus,
  attendanceStationMode,
  attendanceStationStatus,
  attentionDetectorKey,
  attentionItemState,
  attentionProposal,
  attentionScopeType,
  attentionSeverity,
  attentionSubjectType,
  attendanceExportField,
  attendanceManualTransition,
  barcodeSymbology,
  criterionAssessment,
  eventPhaseKey,
  eventStatus,
  eventRole,
  githubInstallationState,
  githubRepositoryBindingState,
  githubRepositoryCoverage,
  githubRepositorySyncState,
  githubRepositoryTopicState,
  integrationProviderHealth,
  intakeAnswerLength,
  intakeQuestionPurpose,
  memberRole,
  noveltyBand,
  noveltyCorpusImportState,
  noveltyCorpusStatus,
  noveltyPreviewState,
  participantClass,
  participantGender,
  participantEligibilityStatus,
  participantOnboardingStatus,
  participantPhoneVerificationStatus,
  participantEmailProvider,
  participantEmailTemplateKey,
  participantAssistantPhase,
  participantAssistantRequestState,
  projectCheckpointKey,
  projectDraftStage,
  permissionBundleEntry,
  permissionDelegation,
  permissionGrantSourceType,
  permissionGrantStatus,
  rehearsalRunState,
  rehearsalScenarioState,
  rehearsalWorkstream,
  repositoryKind,
  reviewEvaluationState,
  reviewPanelStatus,
  reviewProgressionScoreReference,
  reviewRoundStatus,
  reviewStaffingPolicy,
  reviewerClockInStatus,
  reviewerPageChainState,
  reviewerPageState,
  reviewerPushDeliveryState,
  outboundCallDeliveryState,
  reviewRoundReserveStatus,
  reviewSessionStatus,
  roundExportState,
  scorecardCorrectionCategory,
  scorecardCorrectionKind,
  scorecardCorrectionState,
  scorecardStatus,
  scopeType,
  sessionPresenceState,
  songQueueMode,
  songRequestState,
  studyYear,
  vitResidenceType,
  supportCaseCategory,
  supportCaseState,
  synesthesiaWindowKind,
  synesthesiaWindowStatus,
  teamRoundState,
  teamRosterEntryStatus,
  teamStatus,
  venueCheckInStatus,
  venueIdentityCheckMethod,
  venuePresenceState,
  youtubeVideo,
  ambienceMode,
} from "./values";
import {
  intelligenceRecommendationArguments,
  intelligenceRecommendationCitation,
  intelligenceRecommendationStatus,
  operationsAutonomyRecommendationCitation,
  operationsAutonomyRecommendationEvidenceSeal,
} from "./lib/intelligenceRecommendationValidators";
import {
  operationsAutonomyEscalationSeverity,
  operationsAutonomyFailureCode,
  operationsAutonomyMode,
  operationsAutonomyRecommendationKind,
  operationsAutonomyReadTool,
  operationsAutonomyRunPhase,
  operationsAutonomyRunState,
  operationsAutonomySignalKey,
  operationsAutonomySourceSnapshot,
} from "./lib/operationsAutonomyValidators";
import {
  operationsAutonomyAdmissionJobFact,
  operationsAutonomyAttendanceOperationFact,
  operationsAutonomyIncidentReadinessFact,
  operationsAutonomyIntakeJobFact,
  operationsAutonomyIntegrationJobFact,
  operationsAutonomyParticipantDeliveryFact,
  operationsAutonomyRoundExportJobFact,
  operationsAutonomySynesthesiaOperationFact,
} from "./lib/operationsAutonomyDeepReadValidators";
import {
  operationsBriefPriority,
  operationsHealthArea,
  operationsHealthSeverity,
  operationsHealthSignalKey,
  operationsHealthSnapshot,
} from "./lib/operationsIntelligenceValidators";
import {
  operationsEpisodeAnalysisState,
  operationsEpisodeExpectedState,
  operationsEpisodeHypothesisStance,
  operationsEpisodeLifecycle,
  operationsEpisodePredictionOutcome,
  operationsEpisodeState,
} from "./lib/operationsEpisodeValidators";

const attendanceRollCallCounts = v.object({
  expected: v.number(),
  notArrived: v.number(),
  inside: v.number(),
  temporarilyOut: v.number(),
  departed: v.number(),
  elsewhere: v.number(),
  unknown: v.number(),
});

const rosterBundleSelection = v.object({
  bundleId: v.id("permissionBundles"),
  bundleVersionId: v.id("permissionBundleVersions"),
  bundleChecksum: v.string(),
});

const operationsAutonomyAttentionFact = v.object({
  itemId: v.id("operationsAttentionItems"),
  detectorKey: attentionDetectorKey,
  subjectType: attentionSubjectType,
  severity: attentionSeverity,
  state: attentionItemState,
  version: v.number(),
  recurrenceCount: v.number(),
  firstObservedAt: v.number(),
  lastObservedAt: v.number(),
});

const operationsAutonomyReviewExceptionFact = v.union(
  v.object({
    kind: v.literal("vacancy"),
    missingPanelMemberId: v.id("reviewPanelMembers"),
    panelId: v.id("reviewPanels"),
    panelName: v.string(),
    panelVersion: v.number(),
    roundId: v.id("reviewRounds"),
    roundName: v.string(),
    vacantSince: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("team"),
    teamRoundStateId: v.id("teamRoundStates"),
    roundId: v.id("reviewRounds"),
    state: teamRoundState,
    version: v.number(),
    callAttemptCount: v.number(),
    queuedAt: v.optional(v.number()),
    heldAt: v.optional(v.number()),
    missedAt: v.optional(v.number()),
  }),
);

const operationsAutonomySupportFact = v.object({
  caseId: v.id("supportCases"),
  category: supportCaseCategory,
  state: supportCaseState,
  createdAt: v.number(),
  teamId: v.optional(v.id("teams")),
  roundId: v.optional(v.id("reviewRounds")),
});

const operationsAutonomyDeepReadSource = v.union(
  v.literal("intake_jobs"),
  v.literal("admission_jobs"),
  v.literal("participant_deliveries"),
  v.literal("integration_jobs"),
  v.literal("round_export_jobs"),
  v.literal("synesthesia_operations"),
  v.literal("incident_readiness"),
  v.literal("attendance_operations"),
);

const projectVersionFields = {
    eventId: v.id("events"),
    teamId: v.id("teams"),
    version: v.number(),
    initialIdea: v.string(),
    additionalInformation: v.optional(v.string()),
    intakePolicyVersionId: v.id("intakePolicyVersions"),
    intakeResponses: v.array(
      v.object({
        questionId: v.id("intakeGeneratedQuestions"),
        ordinal: v.number(),
        question: v.string(),
        purposeKey: intakeQuestionPurpose,
        answerLength: intakeAnswerLength,
        source: v.union(v.literal("fixed"), v.literal("model"), v.literal("fallback"),
        ),
        answer: v.string(),
      }),
    ),
    lockedRosterSnapshotId: v.id("teamSubmissionAttempts"),
    lockedMemberCount: v.number(),
    lockedLeadMembershipId: v.id("eventMemberships"),
    freshForEventAttestation: v.object({
      participantPolicyVersionId: v.id("participantPolicyVersions"),
      acceptedByMembershipId: v.id("eventMemberships"),
      acceptedAt: v.number(),
    }),
    finalConfirmation: v.object({
      participantPolicyVersionId: v.id("participantPolicyVersions"),
      previewedDraftVersion: v.number(),
      previewedTeamVersion: v.number(),
      confirmedByMembershipId: v.id("eventMemberships"),
      confirmedAt: v.number(),
    }),
    participantPolicyVersionId: v.id("participantPolicyVersions"),
    admissionPolicyVersionId: v.id("admissionPolicyVersions"),
    proposalRevision: v.optional(
      v.object({
        sourceProjectVersionId: v.id("projectVersions"),
        editedByMembershipId: v.id("eventMemberships"),
        editedAt: v.number(),
      }),
    ),
    rosterRevision: v.optional(
      v.object({
        sourceProjectVersionId: v.id("projectVersions"),
        changedByMembershipId: v.id("eventMemberships"),
        changedAt: v.number(),
      }),
    ),
    sourceDraftVersion: v.number(),
    submittedByMembershipId: v.id("eventMemberships"),
    submittedAt: v.number(),
  };

export default defineSchema({
  events: defineTable({
    slug: v.string(),
    name: v.string(),
    timezone: v.string(),
    status: eventStatus,
    vitEmailDomains: v.array(v.string()),
    publishedParticipantPolicyId: v.optional(v.id("participantPolicyVersions")),
    publishedParticipantEligibilityImportId: v.optional(v.id("participantEligibilityImports"),
    ),
    publishedEventPhaseScheduleId: v.optional(v.id("eventPhaseScheduleVersions"),
    ),
    publishedProjectCheckpointPlanId: v.optional(v.id("projectCheckpointPlanVersions"),
    ),
    publishedIntakePolicyId: v.optional(v.id("intakePolicyVersions")),
    publishedNoveltyCorpusVersionId: v.optional(v.id("noveltyCorpusVersions")),
    publishedAdmissionPolicyId: v.optional(v.id("admissionPolicyVersions")),
    publishedAdmissionModelConfigId: v.optional(v.id("admissionModelConfigVersions"),
    ),
    publishedAttendancePlanVersionId: v.optional(v.id("attendancePlanVersions"),
    ),
    publishedIntegrationPolicyId: v.optional(v.id("integrationPolicyVersions")),
    publishedCommunicationsPolicyId: v.optional(v.id("communicationsPolicyVersions"),
    ),
    admissionResultsReleasedAt: v.optional(v.number()),
    admissionRsvpClosesAt: v.optional(v.number()),
    admissionRsvpReminderAt: v.optional(v.number()),
    admissionRsvpOpenedByPersonId: v.optional(v.id("people")),
    admissionResultsReleasedByPersonId: v.optional(v.id("people")),
    admissionResultsCommunicationsPolicyId: v.optional(v.id("communicationsPolicyVersions"),
    ),
    externalApplicationsCloseAt: v.optional(v.number()),
    applicationsCloseAt: v.number(),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    ambience: v.optional(
      v.object({
        mode: ambienceMode,
        changedAt: v.number(),
        changedByPersonId: v.id("people"),
      }),
    ),
    createdByPersonId: v.optional(v.id("people")),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_status", ["status"]),

  participantPolicyVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    label: v.string(),
    teamMinimumSize: v.number(),
    teamMaximumSize: v.number(),
    mixedParticipantClassesAllowed: v.boolean(),
    phoneVerificationEnabled: v.boolean(),
    vitHostelResidenceCatalog: v.array(
      v.object({
        stableKey: v.string(),
        label: v.string(),
        kind: v.union(v.literal("mens"), v.literal("ladies")),
      }),
    ),
    profileNotice: v.string(),
    projectTextNotice: v.string(),
    privacyNoticeUrl: v.string(),
    freshProjectAttestation: v.string(),
    finalSubmissionWarning: v.string(),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  eventPhaseScheduleVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  eventPhaseWindows: defineTable({
    eventId: v.id("events"),
    scheduleVersionId: v.id("eventPhaseScheduleVersions"),
    phaseKey: eventPhaseKey,
    displayName: v.string(),
    description: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    displayOrder: v.number(),
    status: v.union(v.literal("draft"), v.literal("published"), v.literal("retired"),
    ),
    createdAt: v.number(),
  })
    .index("by_schedule_order", ["scheduleVersionId", "displayOrder"])
    .index("by_schedule_key", ["scheduleVersionId", "phaseKey"]),

  projectCheckpointPlanVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  projectCheckpointDefinitions: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("projectCheckpointPlanVersions"),
    checkpointKey: projectCheckpointKey,
    phaseKey: eventPhaseKey,
    displayName: v.string(),
    prompt: v.string(),
    followUpQuestion: v.string(),
    graceMinutes: v.number(),
    displayOrder: v.number(),
    status: v.union(v.literal("draft"), v.literal("published"), v.literal("retired"),
    ),
    createdAt: v.number(),
  })
    .index("by_plan_order", ["planVersionId", "displayOrder"])
    .index("by_plan_key", ["planVersionId", "checkpointKey"]),

  intakePolicyVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    openingText: v.string(),
    initialPrompt: v.string(),
    initialHelpText: v.string(),
    initialIdeaMinLength: v.number(),
    initialIdeaMaxLength: v.number(),
    followUpAnswerMinLength: v.number(),
    followUpAnswerMaxLength: v.number(),
    minimumFollowUpCount: v.number(),
    maximumFollowUpCount: v.number(),
    deterministicFollowUpCount: v.number(),
    questionMaxLength: v.number(),
    allowedPurposeKeys: v.array(intakeQuestionPurpose),
    fallbackQuestions: v.array(
      v.object({
        ordinal: v.number(),
        text: v.string(),
        purposeKey: intakeQuestionPurpose,
        answerLength: intakeAnswerLength,
      }),
    ),
    blockedTerms: v.array(v.string()),
    commonIdeaPatterns: v.array(
      v.object({
        stableKey: v.string(),
        description: v.string(),
        supportiveQuestionGuidance: v.string(),
      }),
    ),
    model: v.union(
      v.object({ mode: v.literal("deterministic") }),
      v.object({
        mode: v.literal("assisted"),
        modelId: v.string(),
        systemInstruction: v.string(),
        instructionVersion: v.string(),
        schemaVersion: v.string(),
        redactionVersion: v.string(),
        questionPolicyVersion: v.string(),
        evaluationSuiteVersion: v.string(),
      }),
    ),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  communicationsPolicyVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    venueName: v.string(),
    venueAddress: v.optional(v.string()),
    venueMapUrl: v.optional(v.string()),
    startsAt: v.number(),
    endsAt: v.number(),
    nextSteps: v.array(
      v.object({
        stableKey: v.string(),
        title: v.string(),
        detail: v.string(),
        actionUrl: v.optional(v.string()),
        dueAt: v.optional(v.number()),
      }),
    ),
    discordUrl: v.string(),
    discordLabel: v.string(),
    notificationProvider: participantEmailProvider,
    emailTemplates: v.array(
      v.object({
        templateKey: participantEmailTemplateKey,
        subject: v.string(),
        text: v.string(),
        html: v.string(),
        assetBundleId: v.optional(v.id("communicationsEmailAssetBundles")),
      }),
    ),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  communicationsEmailAssetBundles: defineTable({
    eventId: v.id("events"),
    templateKey: participantEmailTemplateKey,
    sourceFileName: v.string(),
    sourceByteCount: v.number(),
    sourceSha256: v.string(),
    assets: v.array(
      v.object({
        storageId: v.id("_storage"),
        fileName: v.string(),
        contentType: v.string(),
        contentId: v.string(),
        disposition: v.union(v.literal("inline"), v.literal("attachment")),
        byteCount: v.number(),
        sha256: v.string(),
      }),
    ),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
  }).index("by_event_created", ["eventId", "createdAt"]),

  noveltyCorpusVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    revision: v.number(),
    status: noveltyCorpusStatus,
    importState: noveltyCorpusImportState,
    label: v.string(),
    minimumIdeaLength: v.number(),
    debounceMs: v.number(),
    maximumRequestsPerMinute: v.number(),
    distinctSimilarityBoundary: v.number(),
    commonSimilarityBoundary: v.number(),
    embeddingModel: v.literal("text-embedding-3-small"),
    embeddingDimensions: v.number(),
    entryCount: v.number(),
    checksum: v.optional(v.string()),
    activeImportOperationId: v.optional(v.string()),
    activeImportFingerprint: v.optional(v.string()),
    importFailureCategory: v.optional(v.string()),
    createdByPersonId: v.id("people"),
    lastEditedByPersonId: v.id("people"),
    createdAt: v.number(),
    updatedAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  noveltyCorpusEntries: defineTable({
    eventId: v.id("events"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    sourceKey: v.string(),
    sourceYear: v.number(),
    themeLabel: v.string(),
    summary: v.string(),
    reflectionPrompt: v.string(),
    embedding: v.array(v.float64()),
    createdAt: v.number(),
  })
    .index("by_corpus_source", ["corpusVersionId", "sourceKey"])
    .vectorIndex("by_corpus_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["corpusVersionId"],
    }),

  noveltyTeamIdeas: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    inputFingerprint: v.string(),
    lifecycle: v.union(v.literal("editing"), v.literal("saved"), v.literal("submitted"),
    ),
    comparisonScope: v.optional(v.string()),
    embedding: v.array(v.float64()),
    sourceUpdatedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_team", ["teamId"])
    .index("by_event_comparison_scope", ["eventId", "comparisonScope"])
    .vectorIndex("by_event_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["eventId", "comparisonScope"],
    }),

  noveltyPreviewRequests: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    personId: v.id("people"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    clientRequestId: v.string(),
    inputFingerprint: v.string(),
    inputCharacterCount: v.number(),
    state: noveltyPreviewState,
    score: v.optional(v.number()),
    band: v.optional(noveltyBand),
    effectiveSimilarTeams: v.optional(v.number()),
    comparedTeamCount: v.optional(v.number()),
    nearestSimilarity: v.optional(v.number()),
    nearestThemeLabel: v.optional(v.string()),
    reflectionPrompt: v.optional(v.string()),
    scoringVersion: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    providerRemainingRequests: v.optional(v.number()),
    providerRequestReset: v.optional(v.string()),
    agentOperationId: v.optional(v.string()),
    agentOutputChecksum: v.optional(v.string()),
    agentVersion: v.optional(v.string()),
    agentModel: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    failureCategory: v.optional(v.string()),
    requestedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_team_requested", ["teamId", "requestedAt"])
    .index("by_team_state_requested", ["teamId", "state", "requestedAt"])
    .index("by_team_fingerprint_requested", ["teamId", "inputFingerprint", "requestedAt",
    ])
    .index("by_team_client_request", ["teamId", "clientRequestId"])
    .index("by_event_state_requested", ["eventId", "state", "requestedAt"]),

  people: defineTable({
    authUserId: v.string(),
    googleSubject: v.optional(v.string()),
    verifiedEmail: v.string(),
    displayName: v.string(),
    status: v.union(v.literal("active"), v.literal("suspended")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_auth_user", ["authUserId"])
    .index("by_google_subject", ["googleSubject"])
    .index("by_verified_email", ["verifiedEmail"]),

  googleIdentityClaims: defineTable({
    authUserId: v.string(),
    googleSubject: v.string(),
    verifiedEmail: v.string(),
    displayName: v.optional(v.string()),
    hostedDomain: v.optional(v.string()),
    tokenIssuedAt: v.number(),
    tokenExpiresAt: v.number(),
    verifiedAt: v.number(),
  })
    .index("by_auth_user", ["authUserId"])
    .index("by_google_subject", ["googleSubject"]),

  eventAccessSubjects: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    emailNormalized: v.string(),
    displayName: v.string(),
    status: v.union(v.literal("active"), v.literal("suspended"), v.literal("closed"),
    ),
    linkedBy: v.union(
      v.literal("participant_provisioning"),
      v.literal("roster_claim"),
      v.literal("access_invitation"),
    ),
    accessVersion: v.number(),
    statusChangedAt: v.optional(v.number()),
    statusChangedByPersonId: v.optional(v.id("people")),
    statusReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_person", ["personId"])
    .index("by_event_person", ["eventId", "personId"])
    .index("by_event_email", ["eventId", "emailNormalized"])
    .index("by_event_link_status_email", ["eventId", "linkedBy", "status", "emailNormalized",
    ])
    .index("by_event_status_email", ["eventId", "status", "emailNormalized"])
    .searchIndex("search_by_event_status_name", {
      searchField: "displayName",
      filterFields: ["eventId", "status"],
    }),

  eventAccessInvitations: defineTable({
    eventId: v.id("events"),
    emailNormalized: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("revoked"),
      v.literal("expired"),
    ),
    validUntil: v.number(),
    version: v.number(),
    createdByPersonId: v.id("people"),
    creationOperationId: v.string(),
    reason: v.string(),
    createdAt: v.number(),
    claimedByPersonId: v.optional(v.id("people")),
    claimedEventAccessSubjectId: v.optional(v.id("eventAccessSubjects")),
    claimOperationId: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    revokedByPersonId: v.optional(v.id("people")),
    revokeOperationId: v.optional(v.string()),
    revokedAt: v.optional(v.number()),
    revokeReason: v.optional(v.string()),
  })
    .index("by_event_email_status", ["eventId", "emailNormalized", "status"])
    .index("by_event_status_created", ["eventId", "status", "createdAt"]),

  rosterImports: defineTable({
    eventId: v.id("events"),
    sourceName: v.string(),
    sourceFileName: v.optional(v.string()),
    validFrom: v.number(),
    validUntil: v.number(),
    bundleSelections: v.array(rosterBundleSelection),
    configurationChecksum: v.string(),
    previewChecksum: v.string(),
    rowCount: v.number(),
    createdCount: v.number(),
    replacedCount: v.number(),
    unchangedCount: v.number(),
    alreadyClaimedCount: v.number(),
    reason: v.string(),
    authorizingGrantIds: v.array(v.id("permissionGrants")),
    createdByPersonId: v.id("people"),
    clientOperationId: v.string(),
    createdAt: v.number(),
  })
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_event_operation", ["eventId", "clientOperationId"]),

  rosterEntries: defineTable({
    eventId: v.id("events"),
    rosterImportId: v.id("rosterImports"),
    sourceRowNumber: v.number(),
    emailNormalized: v.string(),
    displayName: v.string(),
    role: eventRole,
    configurationChecksum: v.string(),
    validFrom: v.number(),
    validUntil: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("revoked"),
      v.literal("superseded"),
      v.literal("expired"),
    ),
    version: v.number(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    claimedByPersonId: v.optional(v.id("people")),
    claimedEventAccessSubjectId: v.optional(v.id("eventAccessSubjects")),
    claimedEventRoleId: v.optional(v.id("eventRoles")),
    permissionGrantBatchIds: v.optional(v.array(v.id("permissionGrantBatches")),
    ),
    claimOperationId: v.optional(v.string()),
    claimedAuthUserId: v.optional(v.string()),
    claimedGoogleSubject: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    supersededByRosterEntryId: v.optional(v.id("rosterEntries")),
    supersededAt: v.optional(v.number()),
    revokedByPersonId: v.optional(v.id("people")),
    revokeOperationId: v.optional(v.string()),
    revokedAt: v.optional(v.number()),
    revokeReason: v.optional(v.string()),
    expiredAt: v.optional(v.number()),
  })
    .index("by_event_email_status", ["eventId", "emailNormalized", "status"])
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_event_status_created", ["eventId", "status", "createdAt"])
    .index("by_import_row", ["rosterImportId", "sourceRowNumber"])
    .index("by_claimed_person", ["eventId", "claimedByPersonId"]),

  participantEligibilityImports: defineTable({
    eventId: v.id("events"),
    batchKey: v.string(),
    status: v.union(v.literal("preparing"), v.literal("active"), v.literal("superseded"),
    ),
    expectedExternalCount: v.number(),
    expectedVitCount: v.number(),
    externalSourceChecksum: v.string(),
    vitSourceChecksum: v.string(),
    createdAt: v.number(),
    activatedAt: v.optional(v.number()),
    supersededAt: v.optional(v.number()),
  })
    .index("by_event_batch", ["eventId", "batchKey"])
    .index("by_event_status", ["eventId", "status"]),

  participantEligibilityEntries: defineTable({
    eventId: v.id("events"),
    participantEligibilityImportId: v.id("participantEligibilityImports"),
    participantClass,
    identityKind: v.union(v.literal("email"), v.literal("vit_registration")),
    identityNormalized: v.string(),
    sourceRowNumber: v.number(),
    createdAt: v.number(),
  })
    .index("by_import_identity", [
      "participantEligibilityImportId",
      "participantClass",
      "identityNormalized",
    ])
    .index("by_import_class", ["participantEligibilityImportId", "participantClass",
    ])
    .index("by_event_import", ["eventId", "participantEligibilityImportId"]),

  teamRosterImports: defineTable({
    eventId: v.id("events"),
    sourceName: v.string(),
    sourceFileName: v.optional(v.string()),
    previewChecksum: v.string(),
    rowCount: v.number(),
    createdCount: v.number(),
    replacedCount: v.number(),
    alreadyAssignedCount: v.number(),
    choiceRequiredCount: v.number(),
    waitingForLeadCount: v.number(),
    identityConflictCount: v.number(),
    appliedNowCount: v.number(),
    reason: v.string(),
    authorizingGrantIds: v.array(v.id("permissionGrants")),
    createdByPersonId: v.id("people"),
    clientOperationId: v.string(),
    createdAt: v.number(),
  })
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_event_operation", ["eventId", "clientOperationId"]),

  teamRosterEntries: defineTable({
    eventId: v.id("events"),
    teamRosterImportId: v.id("teamRosterImports"),
    sourceRowNumber: v.number(),
    emailNormalized: v.optional(v.string()),
    vitRegistrationNumber: v.optional(v.string()),
    displayName: v.string(),
    teamName: v.string(),
    role: memberRole,
    status: teamRosterEntryStatus,
    version: v.number(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    claimedByMembershipId: v.optional(v.id("eventMemberships")),
    claimedTeamId: v.optional(v.id("teams")),
    claimedAt: v.optional(v.number()),
    supersededByEntryId: v.optional(v.id("teamRosterEntries")),
  })
    .index("by_event_email_status", ["eventId", "emailNormalized", "status"])
    .index("by_event_vit_registration_status", ["eventId", "vitRegistrationNumber", "status",
    ])
    .index("by_event_team_status", ["eventId", "teamName", "status"])
    .index("by_event_status", ["eventId", "status"])
    .index("by_import_row", ["teamRosterImportId", "sourceRowNumber"])
    .index("by_event_created", ["eventId", "createdAt"]),

  participantRosterRecoveries: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    rosterEntryId: v.id("teamRosterEntries"),
    emailNormalized: v.string(),
    vitRegistrationNumber: v.string(),
    status: v.union(v.literal("approved"), v.literal("completed"), v.literal("revoked")),
    expiresAt: v.number(),
    approvedByPersonId: v.id("people"),
    authorizingGrantIds: v.array(v.id("permissionGrants")),
    reason: v.string(),
    approvedAt: v.number(),
    completedAt: v.optional(v.number()),
    completedByMembershipId: v.optional(v.id("eventMemberships")),
    revokedAt: v.optional(v.number()),
    revokedByPersonId: v.optional(v.id("people")),
  })
    .index("by_event_email", ["eventId", "emailNormalized"])
    .index("by_roster_entry", ["rosterEntryId"])
    .index("by_team_status", ["teamId", "status"]),

  eventMemberships: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
    participantClass,
    vitStudentIdentity: v.optional(
      v.object({
        fullName: v.string(),
        registrationNumber: v.string(),
        programmeCode: v.string(),
        yearOfStudy: studyYear,
      }),
    ),
    eligibilityStatus: participantEligibilityStatus,
    onboardingStatus: participantOnboardingStatus,
    acceptedParticipantPolicyVersionIds: v.array(v.id("participantPolicyVersions"),
    ),
    googleHostedDomain: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_person", ["eventId", "personId"])
    .index("by_person", ["personId"])
    .index("by_event_status", ["eventId", "eligibilityStatus"])
    .index("by_event_onboarding_status", ["eventId", "onboardingStatus"])
    .index("by_event_vit_registration", ["eventId", "vitStudentIdentity.registrationNumber",
    ]),

  eventRoles: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
    role: eventRole,
    validFrom: v.number(),
    validUntil: v.optional(v.number()),
    status: v.union(
      v.literal("active"),
      v.literal("replaced"),
      v.literal("revoked"),
      v.literal("expired"),
    ),
    sourceType: v.union(v.literal("production_seed"), v.literal("roster"), v.literal("manual"),
    ),
    sourceId: v.string(),
    assignedByPersonId: v.id("people"),
    createdAt: v.number(),
    reason: v.optional(v.string()),
    endedAt: v.optional(v.number()),
    endedByPersonId: v.optional(v.id("people")),
    endReason: v.optional(v.string()),
  })
    .index("by_event_person_status", ["eventId", "personId", "status"])
    .index("by_event_role_status", ["eventId", "role", "status"]),

  permissionBundles: defineTable({
    eventId: v.id("events"),
    key: v.string(),
    label: v.string(),
    defaultRole: v.optional(eventRole),
    status: v.union(v.literal("active"), v.literal("retired")),
    publishedVersionId: v.optional(v.id("permissionBundleVersions")),
    draftVersionId: v.optional(v.id("permissionBundleVersions")),
    publishedVersion: v.number(),
    version: v.number(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_key", ["eventId", "key"])
    .index("by_event_status_label", ["eventId", "status", "label"]),

  permissionBundleVersions: defineTable({
    eventId: v.id("events"),
    bundleId: v.id("permissionBundles"),
    key: v.string(),
    label: v.string(),
    defaultRole: v.optional(eventRole),
    version: v.number(),
    revision: v.number(),
    status: v.union(v.literal("draft"), v.literal("published"), v.literal("retired"),
    ),
    entries: v.array(permissionBundleEntry),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    updatedByPersonId: v.id("people"),
    updatedAt: v.number(),
    publishedByPersonId: v.optional(v.id("people")),
    publishedAt: v.optional(v.number()),
    retiredAt: v.optional(v.number()),
  })
    .index("by_bundle_status", ["bundleId", "status"])
    .index("by_bundle_version", ["bundleId", "version"])
    .index("by_event_status_label", ["eventId", "status", "label"]),

  permissionGrantBatches: defineTable({
    eventId: v.id("events"),
    clientOperationId: v.string(),
    requestFingerprint: v.string(),
    action: v.union(v.literal("apply_bundle"), v.literal("migrate_bundle")),
    actorPersonId: v.id("people"),
    targetPersonId: v.id("people"),
    bundleId: v.id("permissionBundles"),
    bundleVersionId: v.id("permissionBundleVersions"),
    sourceBundleVersionId: v.optional(v.id("permissionBundleVersions")),
    sourceGrantBatchId: v.optional(v.id("permissionGrantBatches")),
    resolvedBindings: v.optional(v.array(v.object({ key: v.string(), scopeId: v.string() })),
    ),
    reason: v.string(),
    authorizingGrantIds: v.array(v.id("permissionGrants")),
    expectedAccessVersion: v.number(),
    previewChecksum: v.string(),
    validUntil: v.optional(v.number()),
    status: v.union(v.literal("applying"), v.literal("complete")),
    resultGrantIds: v.array(v.id("permissionGrants")),
    supersededGrantIds: v.optional(v.array(v.id("permissionGrants"))),
    preservedGrantIds: v.optional(v.array(v.id("permissionGrants"))),
    createdCount: v.number(),
    resultAccessVersion: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_event_operation", ["eventId", "clientOperationId"])
    .index("by_event_target_created", ["eventId", "targetPersonId", "createdAt",
    ])
    .index("by_event_bundle_version_status_created", [
      "eventId",
      "bundleVersionId",
      "status",
      "createdAt",
    ]),

  participantPhoneVerifications: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    personId: v.id("people"),
    phone: v.string(),
    status: participantPhoneVerificationStatus,
    codeDigest: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    resendAvailableAt: v.number(),
    attemptCount: v.number(),
    providerMessageId: v.optional(v.string()),
    failureCode: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_membership", ["membershipId"])
    .index("by_membership_phone", ["membershipId", "phone"])
    .index("by_event_phone", ["eventId", "phone"]),

  participantProfiles: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    participantClass,
    fullName: v.string(),
    phone: v.string(),
    phoneVerificationId: v.optional(v.id("participantPhoneVerifications")),
    phoneVerifiedAt: v.optional(v.number()),
    gender: participantGender,
    institution: v.string(),
    yearOfStudy: studyYear,
    vitRegistrationNumber: v.optional(v.string()),
    vitProgramme: v.optional(v.string()),
    vitResidenceType: v.optional(vitResidenceType),
    vitHostelResidence: v.optional(v.string()),
    vitHostelRoomNumber: v.optional(v.string()),
    externalUniversity: v.optional(v.string()),
    externalCollege: v.optional(v.string()),
    profileVersion: v.number(),
    updatedAt: v.number(),
  })
    .index("by_membership", ["membershipId"])
    .index("by_event_class", ["eventId", "participantClass"])
    .index("by_event_vit_registration", ["eventId", "vitRegistrationNumber"]),

  teams: defineTable({
    competitionCategory: v.optional(v.literal("oc")),
    eventId: v.id("events"),
    name: v.string(),
    publicCode: v.string(),
    leadMembershipId: v.id("eventMemberships"),
    status: teamStatus,
    activeMemberCount: v.number(),
    activeVitMemberCount: v.number(),
    activeExternalMemberCount: v.number(),
    membershipLocked: v.boolean(),
    submissionAttemptId: v.optional(v.id("teamSubmissionAttempts")),
    lockedProjectVersionId: v.optional(v.id("projectVersions")),
    lockedAt: v.optional(v.number()),
    lockParticipantPolicyVersionId: v.optional(v.id("participantPolicyVersions"),
    ),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_code", ["eventId", "publicCode"])
    .index("by_event_name", ["eventId", "name"])
    .index("by_event_status", ["eventId", "status"]),

  teamMembers: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    membershipId: v.id("eventMemberships"),
    role: memberRole,
    status: v.union(
      v.literal("invited"),
      v.literal("active"),
      v.literal("left"),
      v.literal("removed"),
    ),
    joinedAt: v.number(),
    leftAt: v.optional(v.number()),
    source: v.union(
      v.literal("created"),
      v.literal("code"),
      v.literal("invitation"),
      v.literal("backfill"),
    ),
  })
    .index("by_team_status", ["teamId", "status"])
    .index("by_event_membership_status", ["eventId", "membershipId", "status"])
    .index("by_team_membership_status", ["teamId", "membershipId", "status"]),

  teamSubmissionAttempts: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    draftId: v.id("projectDrafts"),
    requestedByPersonId: v.id("people"),
    requestedByMembershipId: v.id("eventMemberships"),
    authorizingGrantIds: v.array(v.id("permissionGrants")),
    clientOperationId: v.string(),
    requestFingerprint: v.string(),
    state: v.union(
      v.literal("validating"),
      v.literal("finalizing"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    sourceTeamVersion: v.number(),
    lockedTeamVersion: v.number(),
    sourceDraftVersion: v.number(),
    participantPolicyVersionId: v.id("participantPolicyVersions"),
    admissionPolicyVersionId: v.id("admissionPolicyVersions"),
    cursor: v.optional(v.string()),
    processedMemberCount: v.number(),
    processedVitMemberCount: v.number(),
    processedExternalMemberCount: v.number(),
    hasFirstYear: v.boolean(),
    hasSecondYear: v.boolean(),
    hasLaterYear: v.boolean(),
    hasPostgraduateYear: v.boolean(),
    hasNotApplicableYear: v.boolean(),
    projectVersionId: v.optional(v.id("projectVersions")),
    applicationId: v.optional(v.id("applications")),
    failureCode: v.optional(v.string()),
    failureMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_team_and_created_at", ["teamId", "createdAt"])
    .index("by_event_and_state_and_created_at", ["eventId", "state", "createdAt",
    ])
    .index("by_event_and_requester_and_client_operation", [
      "eventId",
      "requestedByPersonId",
      "clientOperationId",
    ])
    .index("by_state_and_updated_at", ["state", "updatedAt"]),

  teamSubmissionMembers: defineTable({
    eventId: v.id("events"),
    submissionAttemptId: v.id("teamSubmissionAttempts"),
    teamId: v.id("teams"),
    ordinal: v.number(),
    teamMemberId: v.id("teamMembers"),
    membershipId: v.id("eventMemberships"),
    personId: v.id("people"),
    role: memberRole,
    participantClass,
    displayName: v.string(),
    institution: v.string(),
    yearOfStudy: studyYear,
    profileVersion: v.number(),
    destinationEmailNormalized: v.string(),
    materializedAt: v.number(),
  })
    .index("by_submission_attempt_and_ordinal", ["submissionAttemptId", "ordinal",
    ])
    .index("by_submission_attempt_and_team_member", ["submissionAttemptId", "teamMemberId",
    ])
    .index("by_submission_attempt_and_membership", ["submissionAttemptId", "membershipId",
    ]),

  teamLeadershipTransfers: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    fromMembershipId: v.id("eventMemberships"),
    toMembershipId: v.id("eventMemberships"),
    expectedTeamVersion: v.number(),
    state: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("cancelled"),
      v.literal("expired"),
      v.literal("stale"),
    ),
    requestedByPersonId: v.id("people"),
    decidedByPersonId: v.optional(v.id("people")),
    requestedAt: v.number(),
    decidedAt: v.optional(v.number()),
    expiresAt: v.number(),
    clientOperationId: v.string(),
  })
    .index("by_team_state", ["teamId", "state"])
    .index("by_to_state", ["toMembershipId", "state"]),

  permissionGrants: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
    permissionKey: v.string(),
    scopeType,
    scopeId: v.optional(v.string()),
    delegation: v.optional(permissionDelegation),
    validFrom: v.number(),
    validUntil: v.optional(v.number()),
    status: permissionGrantStatus,
    sourceType: permissionGrantSourceType,
    sourceId: v.string(),
    grantBatchId: v.optional(v.id("permissionGrantBatches")),
    grantedByPersonId: v.optional(v.id("people")),
    reason: v.string(),
    createdAt: v.number(),
    activatedAt: v.optional(v.number()),
    expiredAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    revokedByPersonId: v.optional(v.id("people")),
    revokeReason: v.optional(v.string()),
  })
    .index("by_subject_permission_status", ["eventAccessSubjectId", "permissionKey", "status",
    ])
    .index("by_subject_permission_status_scope", [
      "eventAccessSubjectId",
      "permissionKey",
      "status",
      "scopeType",
      "scopeId",
      "validUntil",
    ])
    .index("by_subject_permission_status_valid_until", [
      "eventAccessSubjectId",
      "permissionKey",
      "status",
      "validUntil",
    ])
    .index("by_subject_permission_status_scope_type_valid_until", [
      "eventAccessSubjectId",
      "permissionKey",
      "status",
      "scopeType",
      "validUntil",
    ])
    .index("by_event_permission_status", ["eventId", "permissionKey", "status"])
    .index("by_person_status", ["eventId", "personId", "status"])
    .index("by_source", ["eventId", "sourceType", "sourceId", "status"])
    .index("by_status_valid_from", ["status", "validFrom"])
    .index("by_status_valid_until", ["status", "validUntil"])
    .index("by_grant_batch", ["grantBatchId"]),

  participantAssistantThreads: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    threadId: v.string(),
    supportCaseId: v.optional(v.id("supportCases")),
    escalatedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_eventId_and_personId", ["eventId", "personId"])
    .index("by_threadId", ["threadId"]),

  participantAssistantRequests: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    threadId: v.string(),
    clientRequestId: v.string(),
    promptMessageId: v.string(),
    phaseAtRequest: participantAssistantPhase,
    state: participantAssistantRequestState,
    failureMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_threadId_and_clientRequestId", ["threadId", "clientRequestId"])
    .index("by_threadId_and_state_and_updatedAt", ["threadId", "state", "updatedAt",
    ])
    .index("by_threadId_and_updatedAt", ["threadId", "updatedAt"]),

  outingPolicies: defineTable({
    eventId: v.id("events"),
    capacity: v.number(),
    occupiedCount: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_event", ["eventId"]),

  participantServiceQueueEntries: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    personId: v.id("people"),
    kind: v.literal("outing_permission"),
    joinedAt: v.number(),
    phase: outingPhase,
  })
    .index("by_membership_kind", ["membershipId", "kind"])
    .index("by_phase", ["phase.status"])
    .index("by_event_phase_joinedAt", ["eventId", "phase.status", "joinedAt"]),

  supportCases: defineTable({
    eventId: v.id("events"),
    publicCode: v.string(),
    category: supportCaseCategory,
    description: v.string(),
    origin: v.union(v.literal("participant"), v.literal("reviewer"), v.literal("staff"),
    ),
    reporterPersonId: v.id("people"),
    reporterEventAccessSubjectId: v.id("eventAccessSubjects"),
    contactEmail: v.string(),
    subjectPersonId: v.optional(v.id("people")),
    teamId: v.optional(v.id("teams")),
    roundId: v.optional(v.id("reviewRounds")),
    reviewSessionId: v.optional(v.id("reviewSessions")),
    attendanceSessionId: v.optional(v.id("attendanceSessions")),
    ownerPersonId: v.optional(v.id("people")),
    state: supportCaseState,
    lastActionAt: v.number(),
    firstResponseAt: v.optional(v.number()),
    awaitingStaffReply: v.boolean(),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_event_code", ["eventId", "publicCode"])
    .index("by_event_updated", ["eventId", "updatedAt"])
    .index("by_event_state_updated", ["eventId", "state", "updatedAt"])
    .index("by_event_state_created", ["eventId", "state", "createdAt"])
    .index("by_event_reporter_updated", ["eventId", "reporterPersonId", "updatedAt",
    ])
    .index("by_event_reporter_state_updated", ["eventId", "reporterPersonId", "state", "updatedAt",
    ])
    .index("by_event_owner_state_updated", ["eventId", "ownerPersonId", "state", "updatedAt",
    ]),

  supportCaseActions: defineTable({
    eventId: v.id("events"),
    supportCaseId: v.id("supportCases"),
    kind: v.union(
      v.literal("opened"),
      v.literal("reporter_reply"),
      v.literal("public_note"),
      v.literal("internal_note"),
      v.literal("state_changed"),
      v.literal("owner_changed"),
    ),
    visibility: v.union(v.literal("reporter"), v.literal("internal")),
    actorPersonId: v.id("people"),
    body: v.optional(v.string()),
    previousState: v.optional(supportCaseState),
    nextState: v.optional(supportCaseState),
    previousOwnerPersonId: v.optional(v.id("people")),
    nextOwnerPersonId: v.optional(v.id("people")),
    externalActor: v.optional(
      v.object({
        provider: v.literal("discord"),
        providerUserId: v.string(),
        displayName: v.string(),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_case_time", ["supportCaseId", "createdAt"])
    .index("by_event_time", ["eventId", "createdAt"]),

  supportDiscordChannels: defineTable({
    eventId: v.id("events"),
    supportCaseId: v.id("supportCases"),
    discordGuildId: v.string(),
    discordChannelId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_support_case", ["supportCaseId"])
    .index("by_discord_channel", ["discordChannelId"]),

  supportDiscordOutbox: defineTable({
    eventId: v.id("events"),
    supportCaseId: v.id("supportCases"),
    supportCaseActionId: v.id("supportCaseActions"),
    state: v.union(v.literal("pending"), v.literal("claimed"), v.literal("delivered")),
    claimId: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    nextAttemptAt: v.number(),
    attemptCount: v.number(),
    lastErrorCode: v.optional(v.string()),
    discordMessageId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    deliveredAt: v.optional(v.number()),
  })
    .index("by_event_and_state_and_next_attempt", ["eventId", "state", "nextAttemptAt"])
    .index("by_event_and_state_and_claim_expiry", ["eventId", "state", "claimExpiresAt"])
    .index("by_support_case_action", ["supportCaseActionId"]),

  supportDiscordInboundMessages: defineTable({
    eventId: v.id("events"),
    supportCaseId: v.id("supportCases"),
    supportCaseActionId: v.id("supportCaseActions"),
    discordMessageId: v.string(),
    discordUserId: v.string(),
    discordDisplayName: v.string(),
    createdAt: v.number(),
  })
    .index("by_discord_message", ["discordMessageId"])
    .index("by_support_case_and_created_at", ["supportCaseId", "createdAt"]),

  supportCaseStatShards: defineTable({
    eventId: v.id("events"),
    shard: v.number(),
    open: v.number(),
    investigating: v.number(),
    waiting: v.number(),
    resolved: v.number(),
    closed: v.number(),
    unowned: v.number(),
    awaitingStaffReply: v.number(),
    safety: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_event_shard", ["eventId", "shard"]),

  rehearsalRuns: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    templateVersion: v.string(),
    scheduledFor: v.optional(v.number()),
    state: rehearsalRunState,
    version: v.number(),
    createdByPersonId: v.id("people"),
    startedByPersonId: v.optional(v.id("people")),
    completedByPersonId: v.optional(v.id("people")),
    cancelledByPersonId: v.optional(v.id("people")),
    completionSummary: v.optional(v.string()),
    cancellationReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
  })
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_event_state_created", ["eventId", "state", "createdAt"]),

  rehearsalWorkstreamOwners: defineTable({
    eventId: v.id("events"),
    rehearsalRunId: v.id("rehearsalRuns"),
    workstream: rehearsalWorkstream,
    personId: v.id("people"),
    version: v.number(),
    assignedByPersonId: v.id("people"),
    assignedAt: v.number(),
  })
    .index("by_run_workstream", ["rehearsalRunId", "workstream"])
    .index("by_person_run", ["personId", "rehearsalRunId"]),

  rehearsalScenarios: defineTable({
    eventId: v.id("events"),
    rehearsalRunId: v.id("rehearsalRuns"),
    stableKey: v.string(),
    sequence: v.number(),
    workstream: rehearsalWorkstream,
    title: v.string(),
    expectedState: v.string(),
    recoveryAction: v.string(),
    state: rehearsalScenarioState,
    resultSummary: v.optional(v.string()),
    lastUpdatedByPersonId: v.optional(v.id("people")),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("by_run_sequence", ["rehearsalRunId", "sequence"])
    .index("by_run_key", ["rehearsalRunId", "stableKey"])
    .index("by_run_state_sequence", ["rehearsalRunId", "state", "sequence"])
    .index("by_event_workstream_state", ["eventId", "workstream", "state"]),

  rehearsalScenarioActions: defineTable({
    eventId: v.id("events"),
    rehearsalRunId: v.id("rehearsalRuns"),
    rehearsalScenarioId: v.id("rehearsalScenarios"),
    kind: v.union(
      v.literal("started"),
      v.literal("passed"),
      v.literal("failed"),
      v.literal("blocked"),
      v.literal("rerun"),
    ),
    previousState: rehearsalScenarioState,
    nextState: rehearsalScenarioState,
    note: v.optional(v.string()),
    actorPersonId: v.id("people"),
    scenarioVersion: v.number(),
    createdAt: v.number(),
  })
    .index("by_scenario_time", ["rehearsalScenarioId", "createdAt"])
    .index("by_run_time", ["rehearsalRunId", "createdAt"]),

  incidents: defineTable({
    eventId: v.id("events"),
    title: v.string(),
    summary: v.string(),
    severity: v.union(v.literal("service_disruption"), v.literal("major"), v.literal("critical"),
    ),
    affectedService: v.union(v.literal("attendance_backend"), v.literal("review_backend"),
    ),
    state: v.union(v.literal("open"), v.literal("monitoring"), v.literal("resolved"),
    ),
    manualModeState: v.union(
      v.literal("not_requested"),
      v.literal("pending"),
      v.literal("approved"),
      v.literal("closed"),
    ),
    manualModeApprovalCount: v.number(),
    openedByPersonId: v.id("people"),
    resolvedByPersonId: v.optional(v.id("people")),
    resolutionReason: v.optional(v.string()),
    openedAt: v.number(),
    resolvedAt: v.optional(v.number()),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_state_opened", ["eventId", "state", "openedAt"])
    .index("by_event_opened", ["eventId", "openedAt"])
    .index("by_event_service_opened", ["eventId", "affectedService", "openedAt",
    ]),

  incidentManualModeApprovals: defineTable({
    eventId: v.id("events"),
    incidentId: v.id("incidents"),
    approvedByPersonId: v.id("people"),
    incidentVersion: v.number(),
    reason: v.string(),
    approvedAt: v.number(),
  })
    .index("by_incident_person", ["incidentId", "approvedByPersonId"])
    .index("by_incident_time", ["incidentId", "approvedAt"]),

  synesthesiaCatalogTracks: defineTable({
    eventId: v.id("events"),
    provider: v.string(),
    providerTrackId: v.string(),
    title: v.string(),
    artist: v.string(),
    album: v.optional(v.string()),
    durationSeconds: v.number(),
    isExplicit: v.boolean(),
    energyTag: v.string(),
    searchText: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    version: v.number(),
    createdByPersonId: v.id("people"),
    updatedByPersonId: v.id("people"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_provider_track", ["eventId", "provider", "providerTrackId",
    ])
    .index("by_event_status_title", ["eventId", "status", "title"])
    .searchIndex("search_event_catalog", {
      searchField: "searchText",
      filterFields: ["eventId", "status"],
    }),

  synesthesiaWindows: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    kind: synesthesiaWindowKind,
    customKindLabel: v.optional(v.string()),
    startsAt: v.number(),
    endsAt: v.number(),
    status: synesthesiaWindowStatus,
    requestsOpen: v.boolean(),
    votingOpen: v.boolean(),
    playbackPaused: v.boolean(),
    playbackPauseReason: v.optional(v.string()),
    catalogSourceLabel: v.string(),
    autoApproveRequests: v.boolean(),
    maxRequestsPerParticipant: v.number(),
    maxRequestsTotal: v.number(),
    maxTrackDurationSeconds: v.number(),
    allowExplicit: v.boolean(),
    allowedEnergyTags: v.array(v.string()),
    version: v.number(),
    createdByPersonId: v.id("people"),
    updatedByPersonId: v.id("people"),
    createdAt: v.number(),
    updatedAt: v.number(),
    publishedByPersonId: v.optional(v.id("people")),
    publishedAt: v.optional(v.number()),
    closedByPersonId: v.optional(v.id("people")),
    closedAt: v.optional(v.number()),
    closeReason: v.optional(v.string()),
  })
    .index("by_event_status_start", ["eventId", "status", "startsAt"])
    .index("by_event_start", ["eventId", "startsAt"]),

  songRequests: defineTable({
    eventId: v.id("events"),
    windowId: v.id("synesthesiaWindows"),
    catalogTrackId: v.id("synesthesiaCatalogTracks"),
    requestedByMembershipId: v.id("eventMemberships"),
    requestedByPersonId: v.id("people"),
    provider: v.string(),
    providerTrackId: v.string(),
    title: v.string(),
    artist: v.string(),
    album: v.optional(v.string()),
    durationSeconds: v.number(),
    isExplicit: v.boolean(),
    energyTag: v.string(),
    note: v.optional(v.string()),
    state: songRequestState,
    openReportCount: v.number(),
    queueMode: songQueueMode,
    scheduledFor: v.optional(v.number()),
    publicReason: v.optional(v.string()),
    internalNote: v.optional(v.string()),
    moderatedByPersonId: v.optional(v.id("people")),
    moderatedAt: v.optional(v.number()),
    playbackStartedAt: v.optional(v.number()),
    playbackFinishedAt: v.optional(v.number()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_window_track", ["windowId", "catalogTrackId"])
    .index("by_window_created", ["windowId", "createdAt"])
    .index("by_window_state_created", ["windowId", "state", "createdAt"])
    .index("by_window_requester_created", ["windowId", "requestedByMembershipId", "createdAt",
    ])
    .index("by_event_created", ["eventId", "createdAt"]),

  songVotes: defineTable({
    eventId: v.id("events"),
    windowId: v.id("synesthesiaWindows"),
    requestId: v.id("songRequests"),
    membershipId: v.id("eventMemberships"),
    personId: v.id("people"),
    state: v.union(v.literal("active"), v.literal("removed")),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request_member", ["requestId", "membershipId"])
    .index("by_window_member_state", ["windowId", "membershipId", "state"]),

  synesthesiaReports: defineTable({
    eventId: v.id("events"),
    windowId: v.id("synesthesiaWindows"),
    requestId: v.id("songRequests"),
    reporterMembershipId: v.id("eventMemberships"),
    reporterPersonId: v.id("people"),
    reason: v.string(),
    state: v.union(v.literal("open"), v.literal("resolved"), v.literal("dismissed"),
    ),
    publicResolution: v.optional(v.string()),
    internalResolution: v.optional(v.string()),
    resolvedByPersonId: v.optional(v.id("people")),
    resolvedAt: v.optional(v.number()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request_reporter", ["requestId", "reporterMembershipId"])
    .index("by_request_state_created", ["requestId", "state", "createdAt"])
    .index("by_window_state_created", ["windowId", "state", "createdAt"])
    .index("by_window_reporter", ["windowId", "reporterMembershipId"]),

  synesthesiaPlaybackEvents: defineTable({
    eventId: v.id("events"),
    windowId: v.id("synesthesiaWindows"),
    requestId: v.id("songRequests"),
    kind: v.union(v.literal("started"), v.literal("played"), v.literal("skipped"),
    ),
    actorPersonId: v.id("people"),
    requestVersion: v.number(),
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_request_time", ["requestId", "createdAt"])
    .index("by_window_time", ["windowId", "createdAt"]),

  synesthesiaAccessStates: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    personId: v.id("people"),
    state: v.union(v.literal("active"), v.literal("suspended")),
    reason: v.string(),
    changedByPersonId: v.id("people"),
    version: v.number(),
    changedAt: v.number(),
  })
    .index("by_membership", ["membershipId"])
    .index("by_event_state_changed", ["eventId", "state", "changedAt"]),

  /** Recent provider searches, shared by every event so quota is spent once per phrase. */
  synesthesiaSearchCache: defineTable({
    provider: v.literal("youtube"),
    queryKey: v.string(),
    results: v.array(youtubeVideo),
    fetchedAt: v.number(),
  }).index("by_provider_query", ["provider", "queryKey"]),

  projectDrafts: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    intakePolicyVersionId: v.id("intakePolicyVersions"),
    stage: projectDraftStage,
    initialIdea: v.optional(v.string()),
    additionalInformation: v.optional(v.string()),
    noveltyCorpusVersionId: v.optional(v.id("noveltyCorpusVersions")),
    noveltyEvaluatedInputFingerprint: v.optional(v.string()),
    noveltyScore: v.optional(v.number()),
    noveltyBand: v.optional(noveltyBand),
    noveltyNearestThemeLabel: v.optional(v.string()),
    noveltyReflectionPrompt: v.optional(v.string()),
    noveltyScoringVersion: v.optional(v.string()),
    noveltyRefinementFailureCategory: v.optional(v.string()),
    noveltyPreviewRequestId: v.optional(v.id("noveltyPreviewRequests")),
    noveltyEvaluatedAt: v.optional(v.number()),
    adaptiveQuestionDeadlineAt: v.optional(v.number()),
    freshnessAttestedByMembershipId: v.optional(v.id("eventMemberships")),
    freshnessAttestedAt: v.optional(v.number()),
    version: v.number(),
    lastEditedByMembershipId: v.id("eventMemberships"),
    updatedAt: v.number(),
  })
    .index("by_team", ["teamId"])
    .index("by_event_intake_policy", ["eventId", "intakePolicyVersionId"]),

  intakeWorkingFields: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    kind: v.union(v.literal("idea"), v.literal("follow_up")),
    questionId: v.optional(v.id("intakeGeneratedQuestions")),
    value: v.string(),
    baseDraftVersion: v.number(),
    revision: v.number(),
    writtenByMembershipId: v.id("eventMemberships"),
    updatedAt: v.number(),
  })
    .index("by_team", ["teamId"])
    .index("by_team_base_version", ["teamId", "baseDraftVersion"])
    .index("by_team_kind_question", ["teamId", "kind", "questionId"]),

  intakeAnswerVersions: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    draftId: v.id("projectDrafts"),
    promptKey: v.string(),
    generatedQuestionId: v.optional(v.id("intakeGeneratedQuestions")),
    answerVersion: v.number(),
    value: v.string(),
    supersedesAnswerVersionId: v.optional(v.id("intakeAnswerVersions")),
    status: v.union(v.literal("active"), v.literal("superseded"), v.literal("inactive_for_route"),
    ),
    writtenByMembershipId: v.id("eventMemberships"),
    writtenAt: v.number(),
    clientOperationId: v.string(),
  })
    .index("by_team_prompt_status", ["teamId", "promptKey", "status"])
    .index("by_team_prompt_version", ["teamId", "promptKey", "answerVersion"])
    .index("by_draft_prompt_status", ["draftId", "promptKey", "status"])
    .index("by_draft_status", ["draftId", "status"])
    .index("by_generated_question_status", ["generatedQuestionId", "status"]),

  intakeGeneratedQuestions: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    draftId: v.id("projectDrafts"),
    ordinal: v.number(),
    text: v.string(),
    purposeKey: intakeQuestionPurpose,
    answerLength: intakeAnswerLength,
    source: v.union(v.literal("fixed"), v.literal("model"), v.literal("fallback"),
    ),
    sourceAnswerVersionIds: v.array(v.id("intakeAnswerVersions")),
    intakePolicyVersionId: v.id("intakePolicyVersions"),
    interpretationId: v.optional(v.id("intakeInterpretations")),
    matchedIdeaPatternKey: v.optional(v.string()),
    state: v.union(
      v.literal("active"),
      v.literal("answered"),
      v.literal("replaced"),
      v.literal("stale"),
    ),
    validationCategory: v.string(),
    answeredAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_draft_ordinal", ["draftId", "ordinal"])
    .index("by_draft_state_ordinal", ["draftId", "state", "ordinal"]),

  intakeInterpretations: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    draftId: v.id("projectDrafts"),
    intakePolicyVersionId: v.id("intakePolicyVersions"),
    inputAnswerVersionIds: v.array(v.id("intakeAnswerVersions")),
    inputFingerprint: v.string(),
    ordinal: v.number(),
    state: v.union(
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("refused"),
      v.literal("invalid"),
      v.literal("timed_out"),
      v.literal("rate_limited"),
      v.literal("failed"),
      v.literal("stale"),
      v.literal("disabled"),
    ),
    coveragePurposeKeys: v.array(intakeQuestionPurpose),
    nextQuestionText: v.optional(v.string()),
    nextQuestionPurposeKey: v.optional(intakeQuestionPurpose),
    nextQuestionAnswerLength: v.optional(intakeAnswerLength),
    matchedIdeaPatternKey: v.optional(v.string()),
    stopReason: v.optional(
      v.union(
        v.literal("needs_question"),
        v.literal("enough_context"),
        v.literal("question_limit"),
      ),
    ),
    modelId: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    failureCategory: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_draft_created", ["draftId", "createdAt"])
    .index("by_draft_input", ["draftId", "inputFingerprint"])
    .index("by_event_state_created", ["eventId", "state", "createdAt"]),

  projectVersions: defineTable(v.union(
    v.object(projectVersionFields),
    v.object({
      ...projectVersionFields,
      freshForEventAttestation: v.null(),
      finalConfirmation: v.null(),
      organizerImport: v.object({
        importedByPersonId: v.id("people"), importedAt: v.number(), evidence: v.string(),
      }),
    }),
  ))
    .index("by_team_version", ["teamId", "version"])
    .index("by_event_submitted", ["eventId", "submittedAt"]),

  teamCheckpointDrafts: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    planVersionId: v.id("projectCheckpointPlanVersions"),
    definitionId: v.id("projectCheckpointDefinitions"),
    checkpointKey: projectCheckpointKey,
    stage: v.union(
      v.literal("update"),
      v.literal("follow_up"),
      v.literal("review"),
      v.literal("submitted"),
    ),
    updateText: v.optional(v.string()),
    followUpAnswer: v.optional(v.string()),
    submissionId: v.optional(v.id("teamCheckpointSubmissions")),
    version: v.number(),
    lastEditedByMembershipId: v.id("eventMemberships"),
    updatedAt: v.number(),
  })
    .index("by_team_key", ["teamId", "checkpointKey"])
    .index("by_event_key_updated", ["eventId", "checkpointKey", "updatedAt"]),

  teamCheckpointSubmissions: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    planVersionId: v.id("projectCheckpointPlanVersions"),
    definitionId: v.id("projectCheckpointDefinitions"),
    phaseScheduleVersionId: v.id("eventPhaseScheduleVersions"),
    phaseWindowId: v.id("eventPhaseWindows"),
    checkpointKey: projectCheckpointKey,
    sequence: v.number(),
    displayName: v.string(),
    prompt: v.string(),
    updateText: v.string(),
    followUpQuestion: v.string(),
    followUpAnswer: v.string(),
    dueAt: v.number(),
    closesAt: v.number(),
    timing: v.union(v.literal("on_time"), v.literal("late")),
    previousSubmissionId: v.optional(v.id("teamCheckpointSubmissions")),
    sourceDraftVersion: v.number(),
    submittedByMembershipId: v.id("eventMemberships"),
    submittedAt: v.number(),
  })
    .index("by_team_key", ["teamId", "checkpointKey"])
    .index("by_team_sequence", ["teamId", "sequence"])
    .index("by_team_submitted", ["teamId", "submittedAt"])
    .index("by_event_key_submitted", ["eventId", "checkpointKey", "submittedAt",
    ]),

  applications: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    submittedProjectVersionId: v.id("projectVersions"),
    admissionPolicyVersionId: v.id("admissionPolicyVersions"),
    state: applicationState,
    experienceBand: admissionExperienceBand,
    aiRecommendationId: v.optional(v.id("admissionAIRecommendations")),
    aiDisposition: v.optional(admissionAiDisposition),
    humanDecision: v.optional(admissionDecision),
    decisionStage: admissionDecisionStage,
    humanReasonCode: v.optional(v.string()),
    decidedByPersonId: v.optional(v.id("people")),
    decidedAt: v.optional(v.number()),
    releasedByPersonId: v.optional(v.id("people")),
    releasedAt: v.optional(v.number()),
    currentOfferId: v.optional(v.id("admissionOffers")),
    assignedReviewCount: v.number(),
    completedReviewCount: v.number(),
    contentVersion: v.number(),
    version: v.number(),
    submittedAt: v.number(),
  })
    .index("by_team", ["teamId"])
    .index("by_event_submitted", ["eventId", "submittedAt"])
    .index("by_event_decision_stage", ["eventId", "decisionStage", "submittedAt",
    ])
    .index("by_event_state_submitted", ["eventId", "state", "submittedAt"]),

  participantNotificationDestinations: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    personId: v.id("people"),
    channel: v.literal("verified_email"),
    emailNormalized: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    disabledAt: v.optional(v.number()),
    disabledByPersonId: v.optional(v.id("people")),
    disabledReasonCode: v.optional(v.string()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_person_channel", ["eventId", "personId", "channel"])
    .index("by_event_status", ["eventId", "status"]),

  participantNotificationDeliveries: defineTable({
    eventId: v.id("events"),
    applicationId: v.id("applications"),
    teamId: v.id("teams"),
    membershipId: v.id("eventMemberships"),
    personId: v.id("people"),
    destinationId: v.id("participantNotificationDestinations"),
    communicationsPolicyVersionId: v.id("communicationsPolicyVersions"),
    channel: v.literal("verified_email"),
    destinationEmailNormalized: v.string(),
    templateKey: v.union(
      v.literal("accept"),
      v.literal("waitlist"),
      v.literal("decline"),
      v.literal("offer"),
      v.literal("offer_confirmed"),
      v.literal("offer_declined"),
      v.literal("offer_expired"),
      v.literal("external_event_pass"),
    ),
    applicationVersion: v.number(),
    portalPath: v.string(),
    rootNotificationKey: v.string(),
    retryNumber: v.number(),
    supersedesDeliveryId: v.optional(v.id("participantNotificationDeliveries")),
    state: v.union(
      v.literal("pending"),
      v.literal("sending"),
      v.literal("retry_wait"),
      v.literal("sent"),
      v.literal("delivery_delayed"),
      v.literal("delivered"),
      v.literal("bounced"),
      v.literal("failed"),
      v.literal("suppressed"),
      v.literal("unknown"),
      v.literal("superseded"),
    ),
    attemptCount: v.number(),
    attemptId: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    provider: v.optional(participantEmailProvider),
    providerMessageId: v.optional(v.string()),
    providerAcceptedAt: v.optional(v.number()),
    lastProviderEventAt: v.optional(v.number()),
    lastProviderEventId: v.optional(v.string()),
    providerErrorCode: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_root_retry", ["rootNotificationKey", "retryNumber"])
    .index("by_provider_message", ["providerMessageId"])
    .index("by_membership_created", ["membershipId", "createdAt"])
    .index("by_application_created", ["applicationId", "createdAt"])
    .index("by_application_membership_created", ["applicationId", "membershipId", "createdAt",
    ])
    .index("by_destination_state", ["destinationId", "state"])
    .index("by_event_state_updated", ["eventId", "state", "updatedAt"])
    .index("by_event_state_claim", ["eventId", "state", "claimExpiresAt"])
    .index("by_event_state_next_attempt", ["eventId", "state", "nextAttemptAt",
    ]),

  participantNotificationProviderEvents: defineTable({
    provider: v.literal("cloudflare_email"),
    eventId: v.string(),
    providerMessageId: v.string(),
    recipientEmailNormalized: v.string(),
    eventType: v.union(
      v.literal("email.delivered"),
      v.literal("email.delivery_delayed"),
      v.literal("email.bounced"),
      v.literal("email.failed"),
      v.literal("email.suppressed"),
      v.literal("email.complained"),
    ),
    providerAt: v.number(),
    disableDestination: v.boolean(),
    providerErrorCode: v.optional(v.string()),
    payloadHash: v.string(),
    appliedAt: v.optional(v.number()),
    receivedAt: v.number(),
  })
    .index("by_provider_event", ["provider", "eventId"])
    .index("by_provider_message_time", ["providerMessageId", "providerAt"]),

  admissionAIRecommendations: defineTable({
    eventId: v.id("events"),
    applicationId: v.id("applications"),
    teamId: v.id("teams"),
    projectVersionId: v.id("projectVersions"),
    admissionPolicyVersionId: v.id("admissionPolicyVersions"),
    modelConfigVersionId: v.optional(v.id("admissionModelConfigVersions")),
    applicationContentVersion: v.number(),
    sourceInputFingerprint: v.string(),
    experienceBand: admissionExperienceBand,
    state: admissionRecommendationState,
    recommendation: v.optional(admissionDecision),
    centralProposalConsistency: v.optional(
      v.object({
        assessment: v.union(v.literal("consistent"), v.literal("contradictory"),
        ),
        sourceRefs: v.array(v.string()),
      }),
    ),
    criterionAssessments: v.array(
      v.object({
        criterionKey: v.string(),
        assessment: criterionAssessment,
        sourceRefs: v.array(v.string()),
      }),
    ),
    strengths: v.array(v.string()),
    concerns: v.array(v.string()),
    confidence: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    ),
    limitations: v.array(v.string()),
    providerRequestId: v.optional(v.string()),
    agentOperationId: v.optional(v.string()),
    agentOutputChecksum: v.optional(v.string()),
    agentVersion: v.optional(v.string()),
    agentModel: v.optional(v.string()),
    agentDispatchAttemptId: v.optional(v.string()),
    agentSubmissionId: v.optional(v.string()),
    agentAcceptedAt: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    failureCategory: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_application_created", ["applicationId", "createdAt"])
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_state_and_createdAt", ["state", "createdAt"])
    .index("by_event_state_created", ["eventId", "state", "createdAt"]),

  admissionPolicyVersions: defineTable({
    eventId: v.id("events"),
    version: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    aiRecommendationMode: v.union(v.literal("enabled"), v.literal("disabled")),
    minimumHumanReviews: v.number(),
    overallParticipantCapacity: v.number(),
    criteria: v.array(
      v.object({
        criterionKey: v.string(),
        label: v.string(),
        guidanceByBand: v.object({
          firstYear: v.string(),
          earlyYear: v.string(),
          laterYear: v.string(),
          postgraduateOrProfessional: v.string(),
          mixedOrExternal: v.string(),
        }),
      }),
    ),
    decisionReasonCodes: v.array(
      v.object({
        key: v.string(),
        label: v.string(),
        allowedDecisions: v.array(admissionDecision),
      }),
    ),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  admissionModelConfigVersions: defineTable({
    eventId: v.id("events"),
    admissionPolicyVersionId: v.id("admissionPolicyVersions"),
    version: v.string(),
    modelId: v.string(),
    promptVersion: v.string(),
    schemaVersion: v.string(),
    evaluationSuiteVersion: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"])
    .index("by_policy_status", ["admissionPolicyVersionId", "status"]),

  admissionHumanReviews: defineTable({
    eventId: v.id("events"),
    applicationId: v.id("applications"),
    applicationContentVersion: v.number(),
    reviewerPersonId: v.id("people"),
    recommendation: admissionDecision,
    reasonCode: v.string(),
    note: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("superseded")),
    createdAt: v.number(),
  })
    .index("by_application_status", ["applicationId", "status"])
    .index("by_application_reviewer_status", ["applicationId", "reviewerPersonId", "status",
    ])
    .index("by_application_reviewer_content_version", [
      "applicationId",
      "reviewerPersonId",
      "applicationContentVersion",
    ]),

  admissionReviewAssignments: defineTable({
    eventId: v.id("events"),
    applicationId: v.id("applications"),
    applicationContentVersion: v.number(),
    reviewerPersonId: v.id("people"),
    assignedByPersonId: v.id("people"),
    state: admissionReviewAssignmentState,
    version: v.number(),
    assignedAt: v.number(),
    completedAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    cancelledByPersonId: v.optional(v.id("people")),
    cancellationReason: v.optional(v.string()),
  })
    .index("by_state_assigned", ["state", "assignedAt"])
    .index("by_application_state_assigned", ["applicationId", "state", "assignedAt",
    ])
    .index("by_application_reviewer_state", ["applicationId", "reviewerPersonId", "state",
    ])
    .index("by_event_reviewer_state_assigned", [
      "eventId",
      "reviewerPersonId",
      "state",
      "assignedAt",
    ]),

  admissionCapacityBuckets: defineTable({
    eventId: v.id("events"),
    admissionPolicyVersionId: v.id("admissionPolicyVersions"),
    capacity: v.number(),
    reserved: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_policy", ["admissionPolicyVersionId"])
    .index("by_event", ["eventId"]),

  admissionOffers: defineTable({
    eventId: v.id("events"),
    applicationId: v.id("applications"),
    teamId: v.id("teams"),
    lockedRosterSnapshotId: v.id("teamSubmissionAttempts"),
    participantCount: v.number(),
    source: v.literal("accepted_decision"),
    state: admissionOfferState,
    sentAt: v.number(),
    expiresAt: v.number(),
    reminderAt: v.optional(v.number()),
    createdByPersonId: v.id("people"),
    createdByGrantIds: v.array(v.id("permissionGrants")),
    decidedByPersonId: v.optional(v.id("people")),
    decidedAt: v.optional(v.number()),
    decisionReason: v.optional(v.string()),
    version: v.number(),
  })
    .index("by_application_sent", ["applicationId", "sentAt"])
    .index("by_event_state_expiry", ["eventId", "state", "expiresAt"]),

  admissionCapacityReservations: defineTable({
    eventId: v.id("events"),
    applicationId: v.id("applications"),
    offerId: v.id("admissionOffers"),
    admissionPolicyVersionId: v.id("admissionPolicyVersions"),
    participantCount: v.number(),
    state: v.union(v.literal("active"), v.literal("released")),
    reservedAt: v.number(),
    releasedAt: v.optional(v.number()),
    releasedReason: v.optional(
      v.union(v.literal("offer_declined"), v.literal("offer_expired"), v.literal("offer_revoked"),
      ),
    ),
    releasedByPersonId: v.optional(v.id("people")),
  })
    .index("by_application_state", ["applicationId", "state"])
    .index("by_offer", ["offerId"]),

  attendancePlanVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    name: v.string(),
    vitBarcodeSymbologies: v.array(barcodeSymbology),
    vitBarcodeNormalizationVersion: v.string(),
    offlineQueueMaxScans: v.number(),
    offlineQueueMaxAgeSeconds: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  attendanceBarcodeKeySets: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    encryptedKey: v.string(),
    iv: v.string(),
    authTag: v.string(),
    wrappingKeyVersion: v.string(),
    status: v.union(v.literal("active"), v.literal("retired"), v.literal("compromised"),
    ),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    rewrappedAt: v.optional(v.number()),
    retiredAt: v.optional(v.number()),
  }).index("by_event_status_version", ["eventId", "status", "version"]),

  attendanceZones: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("attendancePlanVersions"),
    stableKey: v.string(),
    name: v.string(),
    safeCapacity: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_plan_key", ["planVersionId", "stableKey"]),

  attendanceSessions: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("attendancePlanVersions"),
    stableKey: v.string(),
    name: v.string(),
    kind: attendanceSessionKind,
    requirement: attendanceSessionRequirement,
    expectedCohort: v.union(
      v.object({ kind: v.literal("all_admitted") }),
      v.object({
        kind: v.literal("participant_classes"),
        participantClasses: v.array(participantClass),
      }),
      v.object({
        kind: v.literal("explicit"),
        membershipIds: v.array(v.id("eventMemberships")),
      }),
    ),
    zoneId: v.id("attendanceZones"),
    status: attendanceSessionStatus,
    startsAt: v.number(),
    endsAt: v.number(),
    checkInOpensAt: v.number(),
    checkInClosesAt: v.number(),
    awayAlertAfterMinutes: v.optional(v.number()),
    expectationBuildState: attendanceExpectationBuildState,
    expectationCount: v.number(),
    expectationJobId: v.optional(v.id("attendanceSessionJobs")),
    finalizationJobId: v.optional(v.id("attendanceSessionJobs")),
    version: v.number(),
    openedAt: v.optional(v.number()),
    closingCutoffAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    cancelledByPersonId: v.optional(v.id("people")),
    cancelledAt: v.optional(v.number()),
    cancellationReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_plan_key", ["planVersionId", "stableKey"])
    .index("by_event_status_start", ["eventId", "status", "startsAt"]),

  attendanceSessionJobs: defineTable({
    eventId: v.id("events"),
    sessionId: v.id("attendanceSessions"),
    kind: attendanceSessionJobKind,
    status: attendanceSessionJobStatus,
    cursor: v.optional(v.string()),
    scannedCount: v.number(),
    affectedCount: v.number(),
    requestedByPersonId: v.id("people"),
    clientOperationId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    failureCode: v.optional(v.string()),
  })
    .index("by_session_kind", ["sessionId", "kind"])
    .index("by_status_updated", ["status", "updatedAt"])
    .index("by_event_status_updated", ["eventId", "status", "updatedAt"]),

  attendanceDeviceInstallations: defineTable({
    eventId: v.id("events"),
    /** Scanner policy selected automatically from the published attendance plan. */
    stationId: v.optional(v.id("attendanceStations")),
    installationId: v.string(),
    secretHash: v.string(),
    name: v.string(),
    platform: v.union(v.literal("android"), v.literal("ios")),
    status: v.union(v.literal("active"), v.literal("revoked")),
    registeredByPersonId: v.id("people"),
    registeredAt: v.number(),
    lastSeenAt: v.optional(v.number()),
    lastSequence: v.optional(v.number()),
    pendingReplayCount: v.number(),
    oldestPendingCapturedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_event_installation", ["eventId", "installationId"])
    .index("by_event_status", ["eventId", "status"]),

  attendanceStations: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("attendancePlanVersions"),
    zoneId: v.id("attendanceZones"),
    sessionId: v.optional(v.id("attendanceSessions")),
    deviceInstallationId: v.optional(v.id("attendanceDeviceInstallations")),
    stableKey: v.string(),
    name: v.string(),
    mode: v.optional(attendanceStationMode),
    allowedCredentialKinds: v.optional(v.array(attendanceScannerCredentialKind),
    ),
    status: attendanceStationStatus,
    configurationVersion: v.number(),
    validFrom: v.optional(v.number()),
    validUntil: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_plan_key", ["planVersionId", "stableKey"])
    .index("by_device_status", ["deviceInstallationId", "status"])
    .index("by_event_status", ["eventId", "status"]),

  attendanceCredentials: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    kind: v.union(v.literal("vit_id_barcode"), v.literal("badge_qr")),
    lookupHash: v.string(),
    barcodeSymbology: v.optional(barcodeSymbology),
    normalizationVersion: v.optional(v.string()),
    badgeReference: v.optional(v.string()),
    version: v.number(),
    state: v.union(
      v.literal("pending_verification"),
      v.literal("active"),
      v.literal("suspended"),
      v.literal("revoked"),
      v.literal("replaced"),
    ),
    supersedesCredentialId: v.optional(v.id("attendanceCredentials")),
    replacedByCredentialId: v.optional(v.id("attendanceCredentials")),
    replacementReason: v.optional(v.string()),
    pendingExpiresAt: v.optional(v.number()),
    enrolledByPersonId: v.id("people"),
    enrolledAt: v.number(),
    verifiedAt: v.optional(v.number()),
    revokedByPersonId: v.optional(v.id("people")),
    revokedAt: v.optional(v.number()),
    revokeReason: v.optional(v.string()),
  })
    .index("by_event_lookup", ["eventId", "lookupHash"])
    .index("by_event_badge_reference", ["eventId", "badgeReference"])
    .index("by_membership_state", ["membershipId", "state"]),

  venueCheckIns: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    stationId: v.id("attendanceStations"),
    zoneId: v.id("attendanceZones"),
    identityCheckMethod: venueIdentityCheckMethod,
    credentialId: v.optional(v.id("attendanceCredentials")),
    credentialKind: v.optional(v.union(v.literal("vit_id_barcode"), v.literal("badge_qr")),
    ),
    credentialVersion: v.optional(v.number()),
    badgeReference: v.optional(v.string()),
    status: venueCheckInStatus,
    checkedInByPersonId: v.id("people"),
    checkedInAt: v.number(),
    checkInReason: v.optional(v.string()),
    reversedByPersonId: v.optional(v.id("people")),
    reversedAt: v.optional(v.number()),
    reversalReason: v.optional(v.string()),
    version: v.number(),
  })
    .index("by_event_membership_status", ["eventId", "membershipId", "status"])
    .index("by_membership_time", ["membershipId", "checkedInAt"])
    .index("by_event_status_time", ["eventId", "status", "checkedInAt"]),

  venueCheckInCounterShards: defineTable({
    eventId: v.id("events"),
    shard: v.number(),
    checkedIn: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_event_shard", ["eventId", "shard"]),

  attendanceExternalPasses: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    encryptedBearer: v.string(),
    bearerIv: v.string(),
    bearerAuthTag: v.string(),
    lookupHash: v.string(),
    version: v.number(),
    state: v.union(v.literal("active"), v.literal("suspended")),
    issuedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_membership", ["membershipId"])
    .index("by_event_lookup", ["eventId", "lookupHash"]),

  attendanceExternalIdentityBindings: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    lookupHash: v.string(),
    barcodeSymbology,
    version: v.number(),
    state: v.union(v.literal("active"), v.literal("suspended")),
    linkedByPersonId: v.id("people"),
    linkedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_membership", ["membershipId"])
    .index("by_event_lookup", ["eventId", "lookupHash"]),

  staffedParticipantResolutions: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    resolutionMethod: v.union(
      v.literal("external_id_barcode"),
      v.literal("vit_id_barcode"),
      v.literal("external_pass"),
      v.literal("manual_lookup"),
    ),
    barcodeLookupHash: v.optional(v.string()),
    barcodeSymbology: v.optional(barcodeSymbology),
    stationId: v.id("attendanceStations"),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    resolvedByPersonId: v.id("people"),
    resolvedAt: v.number(),
    expiresAt: v.number(),
    venueAction: v.optional(v.union(v.literal("record_check_in"), v.literal("reverse_check_in")),
    ),
    venueActionAt: v.optional(v.number()),
    venueCheckInId: v.optional(v.id("venueCheckIns")),
    credentialAction: v.optional(
      v.union(
        v.literal("begin_vit_enrolment"),
        v.literal("begin_vit_rebind"),
        v.literal("suspend_vit"),
        v.literal("begin_badge_issue"),
        v.literal("begin_badge_replacement"),
        v.literal("revoke_badge"),
        v.literal("link_external_id"),
        v.literal("suspend_external_pass"),
        v.literal("reissue_external_pass"),
      ),
    ),
    credentialActionAt: v.optional(v.number()),
    attendanceCredentialId: v.optional(v.id("attendanceCredentials")),
    attendanceExternalPassId: v.optional(v.id("attendanceExternalPasses")),
  }).index("by_event_membership_time", ["eventId", "membershipId", "resolvedAt"]),

  attendanceVenueStates: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    state: venuePresenceState,
    zoneId: v.optional(v.id("attendanceZones")),
    currentIntervalId: v.optional(v.id("attendancePresenceIntervals")),
    lastEventId: v.optional(v.id("attendancePresenceEvents")),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_membership", ["eventId", "membershipId"])
    .index("by_zone_state", ["zoneId", "state"]),

  attendanceTeamAvailability: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    activeMemberCount: v.number(),
    insideMemberCount: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_event_team", ["eventId", "teamId"]),

  attendanceSessionParticipants: defineTable({
    eventId: v.id("events"),
    sessionId: v.id("attendanceSessions"),
    membershipId: v.id("eventMemberships"),
    expectation: attendanceSessionExpectation,
    state: sessionPresenceState,
    confirmedAt: v.optional(v.number()),
    late: v.boolean(),
    currentIntervalId: v.optional(v.id("attendancePresenceIntervals")),
    lastEventId: v.optional(v.id("attendancePresenceEvents")),
    result: v.optional(attendanceSessionResult),
    presentDurationMs: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session_membership", ["sessionId", "membershipId"])
    .index("by_session_state", ["sessionId", "state"])
    .index("by_membership", ["membershipId"])
    .index("by_membership_completed", ["membershipId", "completedAt"]),

  attendanceParticipantCurrentSessions: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("attendancePlanVersions"),
    sessionId: v.id("attendanceSessions"),
    sessionParticipantId: v.id("attendanceSessionParticipants"),
    membershipId: v.id("eventMemberships"),
    sessionStartsAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_membership_plan_start", ["membershipId", "planVersionId", "sessionStartsAt",
    ])
    .index("by_session_membership", ["sessionId", "membershipId"]),

  attendanceResultRemedyCases: defineTable({
    eventId: v.id("events"),
    sessionId: v.id("attendanceSessions"),
    membershipId: v.id("eventMemberships"),
    sessionParticipantId: v.id("attendanceSessionParticipants"),
    state: v.union(v.literal("open"), v.literal("approved"), v.literal("declined"),
    ),
    openedByPersonId: v.id("people"),
    openedByKind: v.union(v.literal("participant"), v.literal("staff")),
    description: v.string(),
    openedAgainstSessionVersion: v.number(),
    openedAgainstParticipantVersion: v.number(),
    openedAgainstResult: v.union(
      v.literal("attended"),
      v.literal("absent"),
      v.literal("partial"),
      v.literal("excused"),
      v.literal("not_expected"),
      v.literal("needs_review"),
    ),
    openedAgainstPresentDurationMs: v.number(),
    openedAgainstConfirmedAt: v.optional(v.number()),
    openedAgainstLate: v.boolean(),
    openedAgainstLastEventId: v.optional(v.id("attendancePresenceEvents")),
    resolvedByPersonId: v.optional(v.id("people")),
    resolvedAt: v.optional(v.number()),
    decisionReason: v.optional(v.string()),
    participantResolutionNote: v.optional(v.string()),
    approvedResult: v.optional(
      v.union(
        v.literal("attended"),
        v.literal("absent"),
        v.literal("partial"),
        v.literal("excused"),
        v.literal("needs_review"),
      ),
    ),
    approvedPresentDurationMs: v.optional(v.number()),
    approvedConfirmedAt: v.optional(v.number()),
    approvedLate: v.optional(v.boolean()),
    appliedParticipantVersion: v.optional(v.number()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session_membership_state", ["sessionId", "membershipId", "state",
    ])
    .index("by_session_membership_created", ["sessionId", "membershipId", "createdAt",
    ])
    .index("by_session_state_created", ["sessionId", "state", "createdAt"])
    .index("by_membership_created", ["membershipId", "createdAt"]),

  attendanceManualSheets: defineTable({
    eventId: v.id("events"),
    incidentId: v.id("incidents"),
    sessionId: v.id("attendanceSessions"),
    zoneId: v.id("attendanceZones"),
    stationId: v.id("attendanceStations"),
    stationConfigurationVersion: v.number(),
    serial: v.string(),
    revision: v.number(),
    transition: attendanceManualTransition,
    entries: v.array(
      v.object({
        lineNumber: v.number(),
        membershipId: v.id("eventMemberships"),
        participantReference: v.string(),
        referenceKind: v.union(
          v.literal("participant_reference"),
          v.literal("vit_registration_number"),
          v.literal("badge_reference"),
        ),
        participantName: v.string(),
        capturedAt: v.number(),
        operatorInitials: v.string(),
        correctionReason: v.optional(v.string()),
      }),
    ),
    status: v.union(
      v.literal("draft"),
      v.literal("submitted"),
      v.literal("imported"),
      v.literal("needs_review"),
      v.literal("rejected"),
      v.literal("cancelled"),
    ),
    enteredByPersonId: v.id("people"),
    enteredAt: v.number(),
    submittedAt: v.optional(v.number()),
    sourceStorageId: v.optional(v.id("_storage")),
    sourceFileName: v.optional(v.string()),
    sourceContentType: v.optional(v.string()),
    sourceByteCount: v.optional(v.number()),
    sourceSha256: v.optional(v.string()),
    verifiedByPersonId: v.optional(v.id("people")),
    verifiedAt: v.optional(v.number()),
    verificationReason: v.optional(v.string()),
    originalFiledByPersonId: v.optional(v.id("people")),
    originalFiledAt: v.optional(v.number()),
    importSummary: v.optional(
      v.object({
        accepted: v.number(),
        duplicate: v.number(),
        rejected: v.number(),
        needsReview: v.number(),
      }),
    ),
    rejectedByPersonId: v.optional(v.id("people")),
    rejectedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    cancelledAt: v.optional(v.number()),
    cancellationReason: v.optional(v.string()),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_serial_revision", ["eventId", "serial", "revision"])
    .index("by_session_status_created", ["sessionId", "status", "enteredAt"])
    .index("by_session_created", ["sessionId", "enteredAt"])
    .index("by_incident_status_created", ["incidentId", "status", "enteredAt"])
    .index("by_source_storage", ["sourceStorageId"]),

  attendancePresenceEvents: defineTable({
    eventId: v.id("events"),
    outing: v.optional(outingScanDecision),
    sourceKind: attendancePresenceSourceKind,
    stationId: v.optional(v.id("attendanceStations")),
    stationConfigurationVersion: v.optional(v.number()),
    zoneId: v.id("attendanceZones"),
    sessionId: v.optional(v.id("attendanceSessions")),
    deviceInstallationId: v.optional(v.id("attendanceDeviceInstallations")),
    operatorPersonId: v.id("people"),
    membershipId: v.optional(v.id("eventMemberships")),
    credentialId: v.optional(v.id("attendanceCredentials")),
    credentialKind: attendanceCredentialKind,
    clientOperationId: v.string(),
    requestFingerprint: v.string(),
    deviceSequence: v.optional(v.number()),
    capturedAt: v.number(),
    receivedAt: v.number(),
    isOfflineReplay: v.boolean(),
    transition: attendancePresenceTransition,
    outcome: attendancePresenceOutcome,
    reasonCode: v.string(),
    previousState: v.optional(v.string()),
    nextState: v.optional(v.string()),
    correctionKind: v.optional(attendanceCorrectionKind),
    operatorReason: v.optional(v.string()),
    linkedParticipantVersion: v.optional(v.number()),
    linkedEventId: v.optional(v.id("attendancePresenceEvents")),
    manualSheetId: v.optional(v.id("attendanceManualSheets")),
    manualSheetLineNumber: v.optional(v.number()),
  })
    .index("by_operator_operation", ["operatorPersonId", "clientOperationId"])
    .index("by_device_sequence", ["deviceInstallationId", "deviceSequence"])
    .index("by_membership_time", ["membershipId", "receivedAt"])
    .index("by_station_time", ["stationId", "receivedAt"])
    .index("by_session_time", ["sessionId", "receivedAt"])
    .index("by_session_membership_time", ["sessionId", "membershipId", "receivedAt",
    ])
    .index("by_manual_sheet_line", ["manualSheetId", "manualSheetLineNumber"]),

  attendancePresenceIntervals: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    zoneId: v.id("attendanceZones"),
    sessionId: v.optional(v.id("attendanceSessions")),
    kind: v.union(v.literal("venue"), v.literal("session")),
    status: v.union(v.literal("open"), v.literal("closed"), v.literal("voided"),
    ),
    openedByEventId: v.id("attendancePresenceEvents"),
    openedAt: v.number(),
    closedByEventId: v.optional(v.id("attendancePresenceEvents")),
    closedAt: v.optional(v.number()),
    voidedByEventId: v.optional(v.id("attendancePresenceEvents")),
    voidedAt: v.optional(v.number()),
    lastReconciledByEventId: v.optional(v.id("attendancePresenceEvents")),
  })
    .index("by_membership_status", ["membershipId", "status"])
    .index("by_session_status", ["sessionId", "status"])
    .index("by_session_membership", ["sessionId", "membershipId"]),

  attendanceSessionCounterShards: defineTable({
    eventId: v.id("events"),
    sessionId: v.id("attendanceSessions"),
    shard: v.number(),
    expected: v.number(),
    confirmationDue: v.number(),
    present: v.number(),
    temporarilyOut: v.number(),
    complete: v.number(),
    excused: v.number(),
    needsReview: v.number(),
    late: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_session_shard", ["sessionId", "shard"]),

  attendanceZoneCounterShards: defineTable({
    eventId: v.id("events"),
    zoneId: v.id("attendanceZones"),
    shard: v.number(),
    inside: v.number(),
    unknown: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_zone_shard", ["zoneId", "shard"]),

  attendanceRollCalls: defineTable({
    eventId: v.id("events"),
    sessionId: v.id("attendanceSessions"),
    zoneId: v.id("attendanceZones"),
    kind: v.union(v.literal("incident"), v.literal("drill")),
    name: v.string(),
    reason: v.string(),
    state: v.union(v.literal("active"), v.literal("closed")),
    sessionVersion: v.number(),
    expectedCount: v.number(),
    snapshotAt: v.number(),
    snapshotChecksum: v.string(),
    snapshotCounts: attendanceRollCallCounts,
    startedByPersonId: v.id("people"),
    closedByPersonId: v.optional(v.id("people")),
    closedAt: v.optional(v.number()),
    closeReason: v.optional(v.string()),
    finalCounts: v.optional(attendanceRollCallCounts),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_started", ["eventId", "snapshotAt"])
    .index("by_event_state_started", ["eventId", "state", "snapshotAt"])
    .index("by_zone_state_started", ["zoneId", "state", "snapshotAt"])
    .index("by_session_started", ["sessionId", "snapshotAt"]),

  attendanceRollCallCounterShards: defineTable({
    eventId: v.id("events"),
    rollCallId: v.id("attendanceRollCalls"),
    shard: v.number(),
    expected: v.number(),
    notArrived: v.number(),
    inside: v.number(),
    temporarilyOut: v.number(),
    departed: v.number(),
    elsewhere: v.number(),
    unknown: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_roll_call_shard", ["rollCallId", "shard"]),

  attendanceExports: defineTable({
    eventId: v.id("events"),
    sessionId: v.id("attendanceSessions"),
    sessionVersion: v.number(),
    requestedByPersonId: v.id("people"),
    purpose: v.string(),
    fields: v.array(attendanceExportField),
    status: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed"),
    ),
    expiresAt: v.number(),
    requestedAt: v.number(),
    workId: v.optional(v.string()),
    snapshotAt: v.optional(v.number()),
    rowCount: v.optional(v.number()),
    objectKey: v.optional(v.string()),
    storageRegion: v.optional(v.string()),
    storageBucket: v.optional(v.string()),
    byteCount: v.optional(v.number()),
    sha256: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    failureCode: v.optional(v.string()),
    version: v.number(),
  })
    .index("by_session_requester_created", ["sessionId", "requestedByPersonId", "requestedAt",
    ])
    .index("by_event_status_created", ["eventId", "status", "requestedAt"]),

  emergencyPacks: defineTable({
    eventId: v.id("events"),
    requestedByPersonId: v.id("people"),
    purpose: v.string(),
    serialPrefix: v.string(),
    spareAttendanceSheetCount: v.number(),
    spareReviewSheetCount: v.number(),
    status: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed"),
    ),
    expiresAt: v.number(),
    requestedAt: v.number(),
    workId: v.optional(v.string()),
    snapshotAt: v.optional(v.number()),
    snapshotChecksum: v.optional(v.string()),
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
    objectKey: v.optional(v.string()),
    objectVersionId: v.optional(v.string()),
    storageRegion: v.optional(v.string()),
    storageBucket: v.optional(v.string()),
    byteCount: v.optional(v.number()),
    sha256: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    failureCode: v.optional(v.string()),
    version: v.number(),
  })
    .index("by_event_created", ["eventId", "requestedAt"])
    .index("by_event_serial_prefix", ["eventId", "serialPrefix"])
    .index("by_event_status_created", ["eventId", "status", "requestedAt"]),

  reviewAggregationPolicies: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    status: v.union(v.literal("published"), v.literal("superseded")),
    rounds: v.array(
      v.object({ roundId: v.id("reviewRounds"), weight: v.number() }),
    ),
    checksum: v.string(),
    publishedByPersonId: v.id("people"),
    publishedAt: v.number(),
    reason: v.string(),
  })
    .index("by_event_version", ["eventId", "version"])
    .index("by_event_status", ["eventId", "status"]),

  reviewRubricVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    name: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    scoreMinimum: v.number(),
    scoreMaximum: v.number(),
    aggregationFormula: v.literal("criterion_mean_weighted_v1"),
    spreadThreshold: v.number(),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  reviewRubricCriteria: defineTable({
    eventId: v.id("events"),
    rubricVersionId: v.id("reviewRubricVersions"),
    stableKey: v.string(),
    label: v.string(),
    question: v.string(),
    guidance: v.string(),
    weight: v.number(),
    displayOrder: v.number(),
    anchors: v.object({
      zero: v.string(),
      one: v.string(),
      two: v.string(),
      three: v.string(),
      four: v.string(),
    }),
    createdAt: v.number(),
  })
    .index("by_rubric_order", ["rubricVersionId", "displayOrder"])
    .index("by_rubric_key", ["rubricVersionId", "stableKey"]),

  reviewRounds: defineTable({
    eventId: v.id("events"),
    rubricVersionId: v.id("reviewRubricVersions"),
    stableKey: v.string(),
    name: v.string(),
    sequence: v.number(),
    status: reviewRoundStatus,
    reviewerReportAt: v.number(),
    clockInOpensAt: v.number(),
    noShowGraceSeconds: v.number(),
    startsAt: v.number(),
    endsAt: v.number(),
    correctionRequestsCloseAt: v.number(),
    reviewDurationSeconds: v.number(),
    ordinaryExtensionSeconds: v.number(),
    maximumOrdinaryExtensions: v.number(),
    missedCallGraceSeconds: v.number(),
    requiredCallAttempts: v.number(),
    substituteResponseSeconds: v.number(),
    missedReentryPolicy: v.union(
      v.literal("preserve_queue_time"),
      v.literal("queue_end"),
      v.literal("manual"),
    ),
    requiredPanelSize: v.number(),
    staffing: reviewStaffingPolicy,
    minimumScorersPerCriterion: v.number(),
    minimumPresentParticipants: v.number(),
    requiresSharedCommitments: v.boolean(),
    requiresFinalComment: v.boolean(),
    minimumReviewerBuild: v.number(),
    requiresCamera: v.boolean(),
    requiresNotifications: v.boolean(),
    version: v.number(),
    configurationChecksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
    openedAt: v.optional(v.number()),
    closingAt: v.optional(v.number()),
    closingByPersonId: v.optional(v.id("people")),
    activeCloseSnapshotId: v.optional(v.id("roundCloseSnapshots")),
    activeRoundExportId: v.optional(v.id("roundExports")),
    closedAt: v.optional(v.number()),
    closedByPersonId: v.optional(v.id("people")),
  })
    .index("by_event_status_start", ["eventId", "status", "startsAt"])
    .index("by_status_start", ["status", "startsAt"])
    .index("by_event_key", ["eventId", "stableKey"]),

  reviewProjectBriefs: defineTable({
    eventId: v.id("events"), teamId: v.id("teams"), projectVersionId: v.id("projectVersions"),
    assessment: projectReviewAssessment, sourceChecksum: v.string(), model: v.string(), version: v.number(),
    updatedByPersonId: v.id("people"), updatedAt: v.number(),
  }).index("by_event_team", ["eventId", "teamId"]),

  reviewTeamPlans: defineTable({
    eventId: v.id("events"), roundId: v.id("reviewRounds"), teamId: v.id("teams"), panelId: v.id("reviewPanels"),
    backupPanelId: v.optional(v.id("reviewPanels")), rationale: v.string(), version: v.number(),
    updatedByPersonId: v.id("people"), updatedAt: v.number(),
  }).index("by_round_team", ["roundId", "teamId"]),

  reviewProgressions: defineTable({
    eventId: v.id("events"), roundId: v.id("reviewRounds"),
    mode: v.union(v.literal("all_advance"), v.literal("elimination")),
    version: v.number(), closeSnapshotId: v.optional(v.id("roundCloseSnapshots")), publishedAt: v.optional(v.number()),
    scoreReference: v.optional(reviewProgressionScoreReference),
    updatedByPersonId: v.id("people"), updatedAt: v.number(), reason: v.string(),
  }).index("by_event_round", ["eventId", "roundId"]),

  reviewProgressionEntries: defineTable({
    eventId: v.id("events"), roundId: v.id("reviewRounds"), progressionId: v.id("reviewProgressions"), teamId: v.id("teams"),
    outcome: v.union(v.literal("advance"), v.literal("eliminate")), reason: v.string(),
  }).index("by_progression_team", ["progressionId", "teamId"]),

  reviewRoundPauses: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    incidentId: v.id("incidents"),
    state: v.union(v.literal("active"), v.literal("resolved")),
    reason: v.string(),
    pausedByPersonId: v.id("people"),
    pausedAt: v.number(),
    resumedByPersonId: v.optional(v.id("people")),
    resumedAt: v.optional(v.number()),
    resumeReason: v.optional(v.string()),
    version: v.number(),
  })
    .index("by_round_state", ["roundId", "state"])
    .index("by_incident_state", ["incidentId", "state"])
    .index("by_event_state_paused", ["eventId", "state", "pausedAt"]),

  reviewerVenuePolicies: defineTable({
    eventId: v.id("events"),
    ...venuePolicyFields,
    version: v.number(),
    updatedByPersonId: v.id("people"),
    updatedAt: v.number(),
  }).index("by_eventId", ["eventId"]),

  reviewerVenuePresence: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    reviewerDeviceId: v.id("reviewerDevices"),
    policyVersion: v.number(),
    trackingGeneration: v.number(),
    trackingStartedAt: v.number(),
    monitoringEnabled: v.boolean(),
    status: reviewerVenueStatus,
    observation: v.union(
      v.literal("inside"),
      v.literal("outside"),
      v.literal("uncertain"),
    ),
    sampledAt: v.optional(v.number()),
    receivedAt: v.optional(v.number()),
    outsideSince: v.optional(v.number()),
    departureId: v.optional(v.id("reviewerVenueDepartures")),
    nextCheckAt: v.optional(v.number()),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_eventId_personId", ["eventId", "personId"])
    .index("by_nextCheckAt", ["nextCheckAt"]),

  reviewerVenueDepartures: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    presenceId: v.id("reviewerVenuePresence"),
    policyVersion: v.number(),
    state: v.union(
      v.literal("open"),
      v.literal("reported"),
      v.literal("returned"),
      v.literal("cancelled"),
    ),
    leftAt: v.number(),
    reportedAt: v.optional(v.number()),
    reason: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    notificationState: v.union(
      v.literal("pending"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("unavailable"),
    ),
    notificationAttempts: v.number(),
    notificationAttemptId: v.optional(v.string()),
    notificationClaimUntil: v.optional(v.number()),
    notificationError: v.optional(v.string()),
    reminderStartedAt: v.optional(v.number()),
    notifiedAt: v.optional(v.number()),
    callDeliveryId: v.optional(v.id("outboundCallDeliveries")),
    updatedAt: v.number(),
  }).index("by_eventId_personId_leftAt", ["eventId", "personId", "leftAt"]),

  reviewerProfiles: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    contactPhone: v.optional(v.string()),
    seniority: v.union(v.literal("board"), v.literal("sc"), v.literal("jc")),
    strength: v.number(),
    technicalDomains: v.array(v.string()),
    productDomains: v.array(v.string()),
    languages: v.array(v.string()),
    criterionKeys: v.array(v.string()),
    // Legacy storage only; training is no longer part of reviewer readiness.
    trainingStatus: v.optional(v.union(v.literal("pending"), v.literal("complete"), v.literal("blocked"))),
    status: v.union(v.literal("active"), v.literal("inactive")),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_event_person", ["eventId", "personId"]),

  reviewerPoolEntries: defineTable({
    eventId: v.id("events"),
    emailNormalized: v.string(),
    displayName: v.string(),
    seniority: v.union(v.literal("board"), v.literal("sc"), v.literal("jc")),
    domain: v.string(),
    skills: v.string(),
    resumeUrl: v.string(),
    githubReference: v.string(),
    importedAt: v.number(),
  }).index("by_eventId_and_emailNormalized", ["eventId", "emailNormalized"]),

  reviewConfirmationRequests: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    opensAt: v.number(),
    closesAt: v.number(),
    state: v.union(
      v.literal("scheduled"),
      v.literal("open"),
      v.literal("closed"),
    ),
    version: v.number(),
    createdAt: v.number(),
  }).index("by_roundId", ["roundId"]),

  reviewerRoundConfirmations: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    personId: v.id("people"),
    status: v.union(
      v.literal("pending"),
      v.literal("confirmed"),
      v.literal("unavailable"),
    ),
    windows: v.array(v.object({ startsAt: v.number(), endsAt: v.number() })),
    version: v.number(),
    respondedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_roundId_and_personId", ["roundId", "personId"])
    .index("by_eventId_and_personId", ["eventId", "personId"]),

  reviewConfirmationNotifications: defineTable({
    confirmationId: v.id("reviewerRoundConfirmations"),
    purpose: v.union(v.literal("availability"), v.literal("shift_reminder")),
    confirmationVersion: v.number(),
    shiftStartsAt: v.optional(v.number()),
    state: v.union(
      v.literal("pending"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("unavailable"),
      v.literal("cancelled"),
    ),
    attempts: v.number(),
    attemptId: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    deviceId: v.optional(v.id("reviewerDevices")),
    tokenFingerprint: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_confirmationId", ["confirmationId"])
    .index("by_confirmation_purpose_shift", [
      "confirmationId",
      "purpose",
      "shiftStartsAt",
    ]),

  reviewQueuePolicies: defineTable({
    routingPreference: v.union(
      v.literal("skills_then_wait"),
      v.literal("shortest_wait"),
    ),
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    automaticCallUp: v.boolean(),
    teamHeadsUpSeconds: v.number(),
    voiceCalls: v.boolean(),
    scoringBufferSeconds: v.number(),
    operatorPersonId: v.id("people"),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_round", ["roundId"]),
  reviewQueuePanelChecks: defineTable({
    roundId: v.id("reviewRounds"),
    panelId: v.id("reviewPanels"),
    status: v.string(),
    checkedAt: v.number(),
  }).index("by_round_panel", ["roundId", "panelId"]),
  reviewTeamNotices: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    teamId: v.id("teams"),
    panelId: v.id("reviewPanels"),
    teamRoundStateId: v.id("teamRoundStates"),
    queueVersion: v.number(),
    kind: v.union(v.literal("up_next"), v.literal("called")),
    message: v.string(),
    createdAt: v.number(),
  })
    .index("by_state_version_kind", [
      "teamRoundStateId",
      "queueVersion",
      "kind",
    ])
    .index("by_round_team_created", ["roundId", "teamId", "createdAt"]),

  reviewerDevices: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    installationId: v.string(),
    name: v.string(),
    platform: v.union(v.literal("android"), v.literal("ios")),
    appBuild: v.number(),
    cameraReady: v.boolean(),
    encryptedDraftReady: v.boolean(),
    pushToken: v.optional(v.string()),
    pushTokenFingerprint: v.optional(v.string()),
    pushProvider: v.optional(v.union(v.literal("fcm"), v.literal("apns"))),
    pushEnvironment: v.optional(v.union(v.literal("development"), v.literal("production")),
    ),
    pushTokenStatus: v.union(
      v.literal("not_registered"),
      v.literal("active"),
      v.literal("invalid"),
    ),
    pushTokenUpdatedAt: v.number(),
    pushTokenInvalidatedAt: v.optional(v.number()),
    pushTokenFailureCode: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("revoked")),
    version: v.number(),
    registeredAt: v.number(),
    lastSeenAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_event_installation", ["eventId", "installationId"])
    .index("by_event_push_fingerprint", ["eventId", "pushTokenFingerprint"])
    .index("by_event_person_status", ["eventId", "personId", "status"])
    .index("by_event_person_status_seen", ["eventId", "personId", "status", "lastSeenAt",
    ]),

  reviewerClockIns: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    reviewerPersonId: v.id("people"),
    reviewerDeviceId: v.id("reviewerDevices"),
    status: reviewerClockInStatus,
    unavailableReason: v.optional(v.string()),
    expectedReturnAt: v.optional(v.number()),
    clockedInAt: v.number(),
    clockedOutAt: v.optional(v.number()),
    lastHeartbeatAt: v.number(),
    version: v.number(),
  })
    .index("by_round_person", ["roundId", "reviewerPersonId"])
    .index("by_round_status", ["roundId", "status"])
    .index("by_person_status", ["reviewerPersonId", "status"])
    .index("by_event_status_heartbeat", ["eventId", "status", "lastHeartbeatAt",
    ]),

  reviewPanels: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    stableKey: v.string(),
    name: v.string(),
    coordinatorPersonId: v.id("people"),
    status: reviewPanelStatus,
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_round_status", ["roundId", "status"])
    .index("by_round_key", ["roundId", "stableKey"])
    .index("by_event_name", ["eventId", "name"])
    .index("by_event_status_updated", ["eventId", "status", "updatedAt"]),

  reviewPanelMembers: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    panelId: v.id("reviewPanels"),
    personId: v.id("people"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
    assignedCriterionIds: v.array(v.id("reviewRubricCriteria")),
    seatSeniority: v.union(v.literal("lead"), v.literal("sc"), v.literal("jc")),
    isCoordinator: v.boolean(),
    status: v.union(v.literal("active"), v.literal("replaced"), v.literal("removed"),
    ),
    assignedAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    .index("by_panel_status", ["panelId", "status"])
    .index("by_panel_status_ended", ["panelId", "status", "endedAt"])
    .index("by_round_person_status", ["roundId", "personId", "status"])
    .index("by_event_person_status", ["eventId", "personId", "status"])
    .index("by_person_status", ["personId", "status"]),

  reviewRoundReserves: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    personId: v.id("people"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
    status: reviewRoundReserveStatus,
    pageCount: v.number(),
    lastPagedAt: v.optional(v.number()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_round_status", ["roundId", "status"])
    .index("by_round_person", ["roundId", "personId"])
    .index("by_event_person_status", ["eventId", "personId", "status"])
    .index("by_person_status", ["personId", "status"]),

  reviewerConflicts: defineTable({
    eventId: v.id("events"),
    reviewerPersonId: v.id("people"),
    teamId: v.id("teams"),
    kind: v.union(v.literal("declared"), v.literal("reported"), v.literal("policy"),
    ),
    reason: v.string(),
    status: v.union(v.literal("active"), v.literal("resolved")),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    resolvedByPersonId: v.optional(v.id("people")),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_reviewer_team_status", ["reviewerPersonId", "teamId", "status"])
    .index("by_event_team_status", ["eventId", "teamId", "status"]),

  teamRoundStates: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    teamId: v.id("teams"),
    panelId: v.optional(v.id("reviewPanels")),
    state: teamRoundState,
    queuedAt: v.optional(v.number()),
    calledAt: v.optional(v.number()),
    callAttemptCount: v.number(),
    lastCallAttemptAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    holdReason: v.optional(v.string()),
    stateBeforeHold: v.optional(teamRoundState),
    skipReason: v.optional(v.string()),
    heldAt: v.optional(v.number()),
    missedAt: v.optional(v.number()),
    movedFromPanelId: v.optional(v.id("reviewPanels")),
    lastMovedAt: v.optional(v.number()),
    priority: v.number(),
    version: v.number(),
    updatedByPersonId: v.id("people"),
    updatedAt: v.number(),
  })
    .index("by_round_team", ["roundId", "teamId"])
    .index("by_round_state_priority_queued", ["roundId", "state", "priority", "queuedAt",
    ])
    .index("by_panel_state_priority_queued", ["panelId", "state", "priority", "queuedAt",
    ]),

  reviewQuestionPolicies: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    policy: reviewQuestionPolicy,
    operatorPersonId: v.id("people"),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_round", ["roundId"]),
  reviewQuestionSets: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    teamId: v.id("teams"),
    policyVersion: v.number(),
    policy: reviewQuestionPolicy,
    operatorPersonId: v.id("people"),
    sourceChecksum: v.string(),
    snapshot: v.object(reviewEvidenceCheckpointFields),
    state: v.union(
      v.literal("queued"),
      v.literal("collecting"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("stale"),
    ),
    attempt: v.number(),
    leaseExpiresAt: v.optional(v.number()),
    payloadChecksum: v.optional(v.string()),
    requestJson: v.optional(v.string()),
    collectionComplete: v.optional(v.boolean()),
    lastSourceCheckAt: v.optional(v.number()),
    analysisLevel: v.optional(v.number()),
    analysisSummary: v.optional(v.string()),
    coverage: v.optional(reviewEvidenceCoverage),
    sources: v.optional(v.array(reviewQuestionSource.omit("text"))),
    questions: v.optional(v.array(reviewSuggestedQuestion)),
    failureCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_round_team_created", ["roundId", "teamId", "createdAt"])
    .index("by_event_updated", ["eventId", "updatedAt"])
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_round_team_source_policy", [
      "roundId",
      "teamId",
      "sourceChecksum",
      "policyVersion",
    ]),

  reviewQuestionCollections: defineTable({
    jobId: v.id("reviewQuestionSets"),
    attempt: v.number(),
    sourceId: v.string(),
    kind: v.literal("github"),
    state: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("complete"),
    ),
    manifestId: v.optional(v.id("_storage")),
    offset: v.number(),
    leaseExpiresAt: v.optional(v.number()),
    failures: v.number(),
  }).index("by_job_attempt_state", ["jobId", "attempt", "state"]),
  reviewQuestionParts: defineTable({
    jobId: v.id("reviewQuestionSets"),
    teamId: v.id("teams"),
    attempt: v.number(),
    key: v.string(),
    level: v.number(),
    state: v.union(
      v.literal("queued"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("consumed"),
    ),
    sources: v.array(reviewQuestionSource),
    references: v.array(reviewQuestionSource.omit("text")),
    analysis: v.optional(reviewEvidenceAnalysis),
    cacheKey: v.string(),
    cached: v.boolean(),
    payloadChecksum: v.optional(v.string()),
    partAttempt: v.number(),
    leaseExpiresAt: v.optional(v.number()),
  })
    .index("by_team_cache_state", ["teamId", "cacheKey", "state"])
    .index("by_job_attempt_key", ["jobId", "attempt", "key"])
    .index("by_job_attempt_level_state", [
      "jobId",
      "attempt",
      "level",
      "state",
    ]),
  reviewEvidenceCheckpointSets: defineTable(reviewEvidenceCheckpointFields)
    .index("by_round_team_time", ["roundId", "teamId", "createdAt"])
    .index("by_team_round_sequence_created", ["teamId", "roundSequence", "createdAt",
    ])
    .index("by_event_created", ["eventId", "createdAt"]),

  reviewSessions: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    panelId: v.id("reviewPanels"),
    teamId: v.id("teams"),
    projectVersionId: v.id("projectVersions"),
    questionSetId: v.optional(v.id("reviewQuestionSets")),
    evidenceCheckpointSetId: v.id("reviewEvidenceCheckpointSets"),
    rubricVersionId: v.id("reviewRubricVersions"),
    panelVersion: v.number(),
    status: reviewSessionStatus,
    startedAt: v.optional(v.number()),
    plannedEndAt: v.optional(v.number()),
    extensionCount: v.number(),
    extensionSeconds: v.number(),
    sharedFindings: v.optional(v.string()),
    sharedCommitments: v.optional(v.string()),
    sharedNotesVersion: v.number(),
    sharedNotesByPersonId: v.optional(v.id("people")),
    completedAt: v.optional(v.number()),
    completedByManualReviewRecordId: v.optional(v.id("manualReviewRecords")),
    cancelledAt: v.optional(v.number()),
    version: v.number(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_question_set", ["questionSetId"])
    .index("by_round_team_status", ["roundId", "teamId", "status"])
    .index("by_panel_status", ["panelId", "status"])
    .index("by_round_status_updated", ["roundId", "status", "updatedAt"])
    .index("by_team_created", ["teamId", "createdAt"])
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_event_status_updated", ["eventId", "status", "updatedAt"]),

  reviewParticipantAvailabilityWaivers: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    teamId: v.id("teams"),
    reviewSessionId: v.id("reviewSessions"),
    requiredCount: v.number(),
    observedCount: v.number(),
    grantedByPersonId: v.id("people"),
    grantIds: v.array(v.id("permissionGrants")),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_review", ["reviewSessionId"])
    .index("by_event_created", ["eventId", "createdAt"]),

  reviewAssignments: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    panelId: v.id("reviewPanels"),
    reviewSessionId: v.id("reviewSessions"),
    reviewerPersonId: v.id("people"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
    assignedCriterionIds: v.array(v.id("reviewRubricCriteria")),
    isCoordinator: v.boolean(),
    status: v.union(v.literal("assigned"), v.literal("conflict"), v.literal("removed"),
    ),
    assignedAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    .index("by_session_person", ["reviewSessionId", "reviewerPersonId"])
    .index("by_round_session", ["roundId", "reviewSessionId"])
    .index("by_event_person_status", ["eventId", "reviewerPersonId", "status"])
    .index("by_person_status", ["reviewerPersonId", "status"]),

  reviewPresence: defineTable({
    eventId: v.id("events"),
    reviewSessionId: v.id("reviewSessions"),
    reviewerPersonId: v.id("people"),
    reviewerDeviceId: v.optional(v.id("reviewerDevices")),
    method: v.union(v.literal("qr"), v.literal("fallback_code"), v.literal("board_override"),
    ),
    tokenVersion: v.number(),
    confirmedAt: v.number(),
    overrideByPersonId: v.optional(v.id("people")),
    overrideReason: v.optional(v.string()),
  }).index("by_session_reviewer", ["reviewSessionId", "reviewerPersonId"]),

  reviewTeamQrTokens: defineTable({
    eventId: v.id("events"),
    reviewSessionId: v.id("reviewSessions"),
    teamId: v.id("teams"),
    tokenDigest: v.string(),
    manualCodeDigest: v.string(),
    tokenVersion: v.number(),
    state: v.union(v.literal("active"), v.literal("superseded"), v.literal("expired"),
    ),
    expiresAt: v.number(),
    issuedByMembershipId: v.id("eventMemberships"),
    issuedAt: v.number(),
  })
    .index("by_digest", ["tokenDigest"])
    .index("by_manual_digest", ["manualCodeDigest"])
    .index("by_session_state", ["reviewSessionId", "state"])
    .index("by_session_version", ["reviewSessionId", "tokenVersion"]),

  reviewerPageChains: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    panelId: v.id("reviewPanels"),
    reviewSessionId: v.optional(v.id("reviewSessions")),
    missingPanelMemberId: v.id("reviewPanelMembers"),
    requiredCriterionIds: v.array(v.id("reviewRubricCriteria")),
    reason: v.string(),
    responseWindowSeconds: v.number(),
    state: reviewerPageChainState,
    currentRank: v.number(),
    version: v.number(),
    createdByPersonId: v.id("people"),
    pageGrantIds: v.array(v.id("permissionGrants")),
    assignmentGrantIds: v.array(v.id("permissionGrants")),
    resolvedScopeType: v.union(v.literal("panel"), v.literal("review")),
    resolvedScopeId: v.string(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_panel_state", ["panelId", "state"])
    .index("by_panel_created", ["panelId", "createdAt"])
    .index("by_session_state", ["reviewSessionId", "state"]),

  reviewerPages: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    panelId: v.id("reviewPanels"),
    reviewSessionId: v.optional(v.id("reviewSessions")),
    pageChainId: v.id("reviewerPageChains"),
    targetPersonId: v.id("people"),
    targetEventAccessSubjectId: v.id("eventAccessSubjects"),
    reserveId: v.id("reviewRoundReserves"),
    requiredCriterionIds: v.array(v.id("reviewRubricCriteria")),
    rank: v.number(),
    reason: v.string(),
    state: reviewerPageState,
    expiresAt: v.number(),
    version: v.number(),
    createdAt: v.number(),
    openedAt: v.optional(v.number()),
    respondedAt: v.optional(v.number()),
    responseReason: v.optional(v.string()),
    acceptedPanelMemberId: v.optional(v.id("reviewPanelMembers")),
    acceptedReviewAssignmentId: v.optional(v.id("reviewAssignments")),
  })
    .index("by_chain_state_rank", ["pageChainId", "state", "rank"])
    .index("by_person_state_expiry", ["targetPersonId", "state", "expiresAt"])
    .index("by_event_person_state_expiry", ["eventId", "targetPersonId", "state", "expiresAt",
    ])
    .index("by_reserve_state", ["reserveId", "state"])
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_event_person_created", ["eventId", "targetPersonId", "createdAt",
    ])
    .index("by_event_state_expiry", ["eventId", "state", "expiresAt"]),

  reviewerPushDeliveries: defineTable({
    eventId: v.id("events"),
    pageId: v.id("reviewerPages"),
    targetPersonId: v.id("people"),
    reviewerDeviceId: v.id("reviewerDevices"),
    purpose: v.literal("substitute_page"),
    logicalAttempt: v.optional(v.number()),
    tokenFingerprint: v.optional(v.string()),
    state: reviewerPushDeliveryState,
    attemptCount: v.number(),
    attemptId: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    providerMessageId: v.optional(v.string()),
    providerErrorCode: v.optional(v.string()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_page", ["pageId"])
    .index("by_page_attempt", ["pageId", "logicalAttempt"])
    .index("by_device_state", ["reviewerDeviceId", "state"]),

  outboundCallConsents: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    purpose: v.union(v.literal("reviewer_substitute_page"), v.literal("participant_event_update"),
      v.literal("reviewer_venue_absence"),
    ),
    destinationPhoneE164: v.optional(v.string()),
    state: v.union(v.literal("granted"), v.literal("revoked")),
    consentPolicyVersion: v.string(),
    scriptPolicyVersion: v.string(),
    version: v.number(),
    grantedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_event_person_purpose", ["eventId", "personId", "purpose"]),

  outboundCallDeliveries: defineTable({
    eventId: v.id("events"),
    targetPersonId: v.id("people"),
    sourceType: v.union(v.literal("reviewer_page"), v.literal("participant_notification"),
      v.literal("admission_offer_reminder"),
      v.literal("review_team_notice"),
      v.literal("participant_outing"),
      v.literal("reviewer_shift_reminder"),
      v.literal("reviewer_venue_departure"),
    ),
    sourceId: v.string(),
    shiftReminder: v.optional(v.object({ confirmationVersion: v.number(), shiftStartsAt: v.number() })),
    purpose: v.union(v.literal("reviewer_shift_reminder"), v.literal("reviewer_substitute_page"), v.literal("participant_event_update"),
      v.literal("reviewer_venue_absence"),
    ),
    destinationPhoneE164: v.optional(v.string()),
    venueConfirmation: v.optional(venueConfirmationCall),
    venueResponse: v.optional(venueCallResponseValue.omit("transcript")),
    responseEventId: v.optional(v.id("outboundCallProviderEvents")),
    venueResponseEffect: v.optional(venueResponseEffect),
    responseRecordedAt: v.optional(v.number()),
    script: v.string(),
    locale: v.string(),
    scriptPolicyVersion: v.string(),
    consentId: v.optional(v.id("outboundCallConsents")),
    consentVersion: v.optional(v.number()),
    authorizationGrantIds: v.array(v.id("permissionGrants")),
    state: outboundCallDeliveryState,
    attemptCount: v.number(),
    attemptId: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    providerCallId: v.optional(v.string()),
    providerErrorCode: v.optional(v.string()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_source", ["eventId", "sourceType", "sourceId", "purpose"])
    .index("by_target_state", ["targetPersonId", "state"])
    .index("by_event_state_updated", ["eventId", "state", "updatedAt"]),

  outboundCallProviderEvents: defineTable({
    eventId: v.id("events"),
    deliveryId: v.id("outboundCallDeliveries"),
    providerEventId: v.string(),
    eventType: v.union(
      v.literal("call.queued"),
      v.literal("call.initiated"),
      v.literal("call.ringing"),
      v.literal("call.answered"),
      v.literal("call.completed"),
      v.literal("call.busy"),
      v.literal("call.no_answer"),
      v.literal("call.cancelled"),
      v.literal("call.failed"),
    ),
    providerCallId: v.optional(v.string()),
    providerErrorCode: v.optional(v.string()),
    venueResponse: v.optional(venueCallResponseValue),
    providerAt: v.number(),
    receivedAt: v.number(),
  })
    .index("by_provider_event", ["providerEventId"])
    .index("by_delivery_provider_at", ["deliveryId", "providerAt"]),

  scorecards: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    reviewSessionId: v.id("reviewSessions"),
    reviewerPersonId: v.id("people"),
    assignmentId: v.id("reviewAssignments"),
    rubricVersionId: v.id("reviewRubricVersions"),
    status: scorecardStatus,
    ratings: v.array(
      v.object({
        criterionId: v.id("reviewRubricCriteria"),
        score: v.number(),
        evidenceNote: v.optional(v.string()),
      }),
    ),
    privateNote: v.optional(v.string()),
    finalComment: v.optional(v.string()),
    draftVersion: v.number(),
    submittedVersionId: v.optional(v.id("scorecardVersions")),
    activeCorrectionCaseId: v.optional(v.id("scorecardCorrectionCases")),
    submittedAt: v.optional(v.number()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session_reviewer", ["reviewSessionId", "reviewerPersonId"])
    .index("by_session_status", ["reviewSessionId", "status"])
    .index("by_round_session", ["roundId", "reviewSessionId"])
    .index("by_round_status_updated", ["roundId", "status", "updatedAt"])
    .index("by_reviewer_status", ["reviewerPersonId", "status"])
    .index("by_event_reviewer_status", ["eventId", "reviewerPersonId", "status",
    ])
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_event_reviewer_created", ["eventId", "reviewerPersonId", "createdAt",
    ]),

  scorecardVersions: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    reviewSessionId: v.id("reviewSessions"),
    scorecardId: v.id("scorecards"),
    reviewerPersonId: v.id("people"),
    version: v.number(),
    rubricVersionId: v.id("reviewRubricVersions"),
    ratings: v.array(
      v.object({
        criterionId: v.id("reviewRubricCriteria"),
        score: v.number(),
        evidenceNote: v.optional(v.string()),
      }),
    ),
    privateNote: v.optional(v.string()),
    finalComment: v.optional(v.string()),
    checksum: v.string(),
    clientOperationId: v.string(),
    manualReviewRecordId: v.optional(v.id("manualReviewRecords")),
    correctionCaseId: v.optional(v.id("scorecardCorrectionCases")),
    supersedesVersionId: v.optional(v.id("scorecardVersions")),
    submittedAt: v.number(),
  })
    .index("by_scorecard_version", ["scorecardId", "version"])
    .index("by_session_reviewer", ["reviewSessionId", "reviewerPersonId"])
    .index("by_round_session", ["roundId", "reviewSessionId"]),

  manualReviewRecords: defineTable({
    eventId: v.id("events"),
    incidentId: v.id("incidents"),
    roundId: v.id("reviewRounds"),
    reviewSessionId: v.id("reviewSessions"),
    teamId: v.id("teams"),
    panelId: v.id("reviewPanels"),
    evidenceCheckpointSetId: v.id("reviewEvidenceCheckpointSets"),
    rubricVersionId: v.id("reviewRubricVersions"),
    panelVersion: v.number(),
    expectedRoundVersion: v.number(),
    expectedReviewVersion: v.number(),
    serial: v.string(),
    revision: v.number(),
    startedAt: v.number(),
    endedAt: v.number(),
    unavailableReason: v.string(),
    reviewerEntries: v.array(
      v.object({
        assignmentId: v.id("reviewAssignments"),
        scorecardId: v.id("scorecards"),
        reviewerPersonId: v.id("people"),
        reviewerName: v.string(),
        expectedScorecardVersion: v.number(),
        signatureConfirmed: v.boolean(),
        ratings: v.array(
          v.object({
            criterionId: v.id("reviewRubricCriteria"),
            score: v.number(),
            evidenceNote: v.optional(v.string()),
          }),
        ),
        privateNote: v.optional(v.string()),
        finalComment: v.optional(v.string()),
      }),
    ),
    sharedFindings: v.optional(v.string()),
    sharedCommitments: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("submitted"),
      v.literal("imported"),
      v.literal("rejected"),
      v.literal("cancelled"),
    ),
    enteredByPersonId: v.id("people"),
    enteredAt: v.number(),
    submittedAt: v.optional(v.number()),
    sourceStorageId: v.optional(v.id("_storage")),
    sourceFileName: v.optional(v.string()),
    sourceContentType: v.optional(v.string()),
    sourceByteCount: v.optional(v.number()),
    sourceSha256: v.optional(v.string()),
    verifiedByPersonId: v.optional(v.id("people")),
    verifiedAt: v.optional(v.number()),
    verificationReason: v.optional(v.string()),
    originalFiledByPersonId: v.optional(v.id("people")),
    originalFiledAt: v.optional(v.number()),
    evaluationId: v.optional(v.id("reviewEvaluations")),
    importedScorecardVersionIds: v.optional(v.array(v.id("scorecardVersions"))),
    rejectedByPersonId: v.optional(v.id("people")),
    rejectedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    cancelledAt: v.optional(v.number()),
    cancellationReason: v.optional(v.string()),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_serial_revision", ["eventId", "serial", "revision"])
    .index("by_review_status_created", ["reviewSessionId", "status", "enteredAt",
    ])
    .index("by_review_created", ["reviewSessionId", "enteredAt"])
    .index("by_round_status_created", ["roundId", "status", "enteredAt"])
    .index("by_incident_status_created", ["incidentId", "status", "enteredAt"])
    .index("by_source_storage", ["sourceStorageId"]),

  reviewEvaluations: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    reviewSessionId: v.id("reviewSessions"),
    teamId: v.id("teams"),
    rubricVersionId: v.id("reviewRubricVersions"),
    criterionResults: v.array(
      v.object({
        criterionId: v.id("reviewRubricCriteria"),
        inputScorecardVersionIds: v.array(v.id("scorecardVersions")),
        scoreCount: v.number(),
        scoreSum: v.number(),
        meanScore: v.number(),
        weightedPoints: v.number(),
        spreadFlag: v.boolean(),
      }),
    ),
    totalPoints: v.number(),
    state: reviewEvaluationState,
    inputChecksum: v.string(),
    invalidatedAt: v.optional(v.number()),
    invalidatedByPersonId: v.optional(v.id("people")),
    invalidationReason: v.optional(v.string()),
    version: v.number(),
    computedAt: v.number(),
  })
    .index("by_session", ["reviewSessionId"])
    .index("by_round_state", ["roundId", "state"])
    .index("by_round_team", ["roundId", "teamId"]),

  scorecardCorrectionCases: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    reviewSessionId: v.id("reviewSessions"),
    scorecardId: v.id("scorecards"),
    kind: scorecardCorrectionKind,
    category: scorecardCorrectionCategory,
    reason: v.string(),
    evidenceReference: v.optional(v.string()),
    state: scorecardCorrectionState,
    originalVersionId: v.id("scorecardVersions"),
    replacementVersionId: v.optional(v.id("scorecardVersions")),
    voidDisposition: v.optional(v.union(v.literal("exclude"), v.literal("replacement_review")),
    ),
    requestedByPersonId: v.id("people"),
    requestedAt: v.number(),
    decidedByPersonId: v.optional(v.id("people")),
    decidedAt: v.optional(v.number()),
    decisionReason: v.optional(v.string()),
    closedAt: v.optional(v.number()),
    version: v.number(),
  })
    .index("by_scorecard_state", ["scorecardId", "state"])
    .index("by_scorecard_kind_requested", ["scorecardId", "kind", "requestedAt",
    ])
    .index("by_round_state", ["roundId", "state"])
    .index("by_session_kind", ["reviewSessionId", "kind"]),

  roundCloseSnapshots: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    rubricVersionId: v.id("reviewRubricVersions"),
    revision: v.number(),
    roundConfigurationChecksum: v.string(),
    resultCount: v.number(),
    exclusionCount: v.number(),
    withdrawnCount: v.number(),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
  })
    .index("by_round_revision", ["roundId", "revision"])
    .index("by_event_created", ["eventId", "createdAt"]),

  roundCloseEntries: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    closeSnapshotId: v.id("roundCloseSnapshots"),
    teamId: v.id("teams"),
    payload: v.union(
      v.object({
        kind: v.literal("result"),
        reviewSessionId: v.id("reviewSessions"),
        evaluationId: v.id("reviewEvaluations"),
        evaluationInputChecksum: v.string(),
        criterionResults: v.array(
          v.object({
            criterionId: v.id("reviewRubricCriteria"),
            scoreCount: v.number(),
            scoreSum: v.number(),
            meanScore: v.number(),
            weightedPoints: v.number(),
            spreadFlag: v.boolean(),
          }),
        ),
        totalPoints: v.number(),
      }),
      v.object({
        kind: v.literal("excluded"),
        reviewSessionId: v.id("reviewSessions"),
        correctionCaseId: v.id("scorecardCorrectionCases"),
        category: v.string(),
      }),
      v.object({
        kind: v.literal("withdrawn"),
      }),
      v.object({
        kind: v.literal("skipped"),
        reason: v.string(),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_snapshot_team", ["closeSnapshotId", "teamId"])
    .index("by_round_team", ["roundId", "teamId"]),

  roundExports: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    closeSnapshotId: v.id("roundCloseSnapshots"),
    revision: v.number(),
    exportFormatVersion: v.number(),
    state: roundExportState,
    closingRoundVersion: v.number(),
    workId: v.optional(v.string()),
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
    files: v.optional(
      v.object({
        storageRegion: v.string(),
        storageBucket: v.string(),
        json: v.object({
          objectKey: v.string(),
          objectVersionId: v.string(),
          byteCount: v.number(),
          sha256: v.string(),
        }),
        csv: v.object({
          objectKey: v.string(),
          objectVersionId: v.string(),
          byteCount: v.number(),
          sha256: v.string(),
        }),
      }),
    ),
    checksum: v.string(),
    requestedByPersonId: v.id("people"),
    requestedAt: v.number(),
    uploadedAt: v.optional(v.number()),
    verifiedByPersonId: v.optional(v.id("people")),
    verifiedAt: v.optional(v.number()),
    verificationReason: v.optional(v.string()),
    failedAt: v.optional(v.number()),
    failureCode: v.optional(v.string()),
    supersededByPersonId: v.optional(v.id("people")),
    supersededAt: v.optional(v.number()),
    supersedeReason: v.optional(v.string()),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_round_revision", ["roundId", "revision"])
    .index("by_round_state", ["roundId", "state"])
    .index("by_snapshot", ["closeSnapshotId"])
    .index("by_event_state_updated", ["eventId", "state", "updatedAt"]),

  integrationPolicyVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    policyVersion: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    requiredGitHubTopic: v.string(),
    maxActiveGitHubRepositoriesPerTeam: v.number(),
    githubFreezeAt: v.optional(v.number()),
    // Retained for existing policy records; new policies no longer configure Figma.
    maxActiveFigmaFilesPerTeam: v.optional(v.number()),
    figmaFreezeAt: v.optional(v.number()),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  teamFigmaLinks: defineTable({
    eventId: v.id("events"), teamId: v.id("teams"), fileUrl: v.optional(v.string()),
    version: v.number(), updatedByPersonId: v.id("people"), updatedAt: v.number(),
  }).index("by_event_team", ["eventId", "teamId"]).index("by_team", ["teamId"]),

  githubSetupIntents: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    personId: v.id("people"),
    stateDigest: v.string(),
    requestedInstallationId: v.optional(v.string()),
    returnPath: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("verifying"),
      v.literal("discovered"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("expired"),
    ),
    attemptId: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    installationConnectionId: v.optional(v.id("githubInstallationConnections")),
    failureCode: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_state_digest", ["stateDigest"])
    .index("by_status", ["status"])
    .index("by_team_status", ["teamId", "status"]),

  githubStarSetupIntents: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    personId: v.id("people"),
    stateDigest: v.string(),
    // Present only until the one-time callback is consumed or expires.
    pkceVerifierCiphertext: v.optional(v.string()),
    redirectUri: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("verifying"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("expired"),
    ),
    attemptId: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    authorizationId: v.optional(v.id("githubStarAuthorizations")),
    failureCode: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_state_digest", ["stateDigest"])
    .index("by_membership_status", ["membershipId", "status"])
    .index("by_status", ["status"]),

  githubStarAuthorizations: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    personId: v.id("people"),
    githubUserId: v.string(),
    githubLogin: v.string(),
    accessTokenCiphertext: v.string(),
    expiresAt: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("starring"),
      v.literal("revoking"),
      v.literal("revoked"),
    ),
    attemptId: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_membership", ["eventId", "membershipId"])
    .index("by_event_github_user", ["eventId", "githubUserId"]),

  githubStarCompletions: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    personId: v.id("people"),
    githubUserId: v.string(),
    githubLogin: v.string(),
    repositoryOwner: v.string(),
    repositoryName: v.string(),
    completedAt: v.number(),
  })
    .index("by_event_membership", ["eventId", "membershipId"])
    .index("by_event_github_user", ["eventId", "githubUserId"]),

  githubRepositoryAuthorizations: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    connectionId: v.id("githubInstallationConnections"),
    personId: v.id("people"),
    accessTokenCiphertext: v.string(),
    expiresAt: v.number(),
  }).index("by_connection_person", ["connectionId", "personId"]),

  githubInstallationConnections: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    installationId: v.string(),
    accountId: v.string(),
    accountLogin: v.string(),
    targetType: v.union(v.literal("User"), v.literal("Organization"), v.literal("Enterprise"),
    ),
    repositorySelection: v.union(v.literal("all"), v.literal("selected")),
    state: githubInstallationState,
    connectedByPersonId: v.id("people"),
    connectedAt: v.number(),
    lastVerifiedAt: v.number(),
    version: v.number(),
  })
    .index("by_team_state", ["teamId", "state"])
    .index("by_team_installation", ["teamId", "installationId"])
    .index("by_installation_state", ["installationId", "state"]),

  githubRepositoryBindings: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    installationConnectionId: v.id("githubInstallationConnections"),
    repositoryId: v.string(),
    repositoryNodeId: v.string(),
    owner: v.string(),
    name: v.string(),
    fullName: v.string(),
    url: v.string(),
    isPrivate: v.boolean(),
    isFork: v.boolean(),
    defaultBranch: v.string(),
    kind: repositoryKind,
    customKind: v.optional(v.string()),
    purpose: v.string(),
    trackedBranch: v.string(),
    rootPath: v.optional(v.string()),
    displayOrder: v.number(),
    requiredTopic: v.string(),
    topicState: githubRepositoryTopicState,
    state: githubRepositoryBindingState,
    baselineSha: v.optional(v.string()),
    currentHeadSha: v.optional(v.string()),
    pendingHeadSha: v.optional(v.string()),
    lastProviderPushedAt: v.optional(v.number()),
    lastWebhookAt: v.optional(v.number()),
    lastReconciledAt: v.optional(v.number()),
    syncRevision: v.number(),
    syncedRevision: v.number(),
    syncState: githubRepositorySyncState,
    syncLeaseId: v.optional(v.string()),
    syncLeaseExpiresAt: v.optional(v.number()),
    syncErrorCode: v.optional(v.string()),
    version: v.number(),
    providerCreatedAt: v.number(),
    connectedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_team_state", ["teamId", "state"])
    .index("by_event_repository", ["eventId", "repositoryId"])
    .index("by_connection_state", ["installationConnectionId", "state"])
    .index("by_event_state_updated", ["eventId", "state", "updatedAt"])
    .index("by_event_sync_state_updated", ["eventId", "syncState", "updatedAt"])
    .index("by_event_topic_state_updated", ["eventId", "topicState", "updatedAt",
    ])
    .index("by_event_state_sync_updated", ["eventId", "state", "syncState", "updatedAt",
    ])
    .index("by_event_state_sync_lease", ["eventId", "state", "syncState", "syncLeaseExpiresAt",
    ])
    .index("by_event_state_topic_updated", ["eventId", "state", "topicState", "updatedAt",
    ]),

  githubRepositoryMetrics: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    repositoryBindingId: v.id("githubRepositoryBindings"),
    baselineSha: v.string(),
    currentHeadSha: v.string(),
    pushCount: v.number(),
    commitCount: v.number(),
    additions: v.number(),
    deletions: v.number(),
    changedFiles: v.number(),
    observedCommitShas: v.array(v.string()),
    commitIdentityComplete: v.boolean(),
    languageBytes: v.array(v.object({ language: v.string(), bytes: v.number() }),
    ),
    completeness: githubRepositoryCoverage,
    compareTruncated: v.boolean(),
    lastProviderCommitAt: v.optional(v.number()),
    capturedAt: v.number(),
    version: v.number(),
  }).index("by_binding", ["repositoryBindingId"]),

  githubRepositorySnapshots: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    repositoryBindingId: v.id("githubRepositoryBindings"),
    previousSnapshotId: v.optional(v.id("githubRepositorySnapshots")),
    reason: v.union(
      v.literal("baseline"),
      v.literal("push"),
      v.literal("manual"),
      v.literal("reconcile"),
    ),
    headSha: v.string(),
    topicState: githubRepositoryTopicState,
    commitCount: v.number(),
    additions: v.number(),
    deletions: v.number(),
    changedFiles: v.number(),
    observedCommitShas: v.array(v.string()),
    commitIdentityComplete: v.boolean(),
    languageBytes: v.array(v.object({ language: v.string(), bytes: v.number() }),
    ),
    completeness: githubRepositoryCoverage,
    compareTruncated: v.boolean(),
    providerCommitAt: v.optional(v.number()),
    capturedAt: v.number(),
  })
    .index("by_binding_time", ["repositoryBindingId", "capturedAt"])
    .index("by_team_time", ["teamId", "capturedAt"]),

  githubTeamMetrics: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    health: integrationProviderHealth,
    installationCount: v.number(),
    repositoryCount: v.number(),
    completeRepositoryCount: v.number(),
    topicPresentCount: v.number(),
    topicMissingCount: v.number(),
    topicUnknownCount: v.number(),
    kindCounts: v.array(v.object({ kind: repositoryKind, count: v.number() })),
    pushCount: v.number(),
    uniqueObservedCommitCount: v.number(),
    commitOverlapCount: v.number(),
    commitIdentityComplete: v.boolean(),
    additions: v.number(),
    deletions: v.number(),
    changedFiles: v.number(),
    languageBytes: v.array(v.object({ language: v.string(), bytes: v.number() }),
    ),
    completeness: githubRepositoryCoverage,
    incompleteRepositoryCount: v.number(),
    lastActivityAt: v.optional(v.number()),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_team", ["teamId"])
    .index("by_event_updated", ["eventId", "updatedAt"]),

  githubWebhookDeliveries: defineTable({
    deliveryId: v.string(),
    eventName: v.string(),
    installationId: v.optional(v.string()),
    repositoryId: v.optional(v.string()),
    payloadHash: v.string(),
    state: v.union(v.literal("accepted"), v.literal("ignored"), v.literal("rejected"),
    ),
    reasonCode: v.string(),
    receivedAt: v.number(),
  }).index("by_delivery", ["deliveryId"]),

  githubPushEvents: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    repositoryBindingId: v.id("githubRepositoryBindings"),
    deliveryId: v.string(),
    ref: v.string(),
    beforeSha: v.string(),
    afterSha: v.string(),
    created: v.boolean(),
    deleted: v.boolean(),
    forced: v.boolean(),
    pushedCommitCount: v.number(),
    providerAt: v.optional(v.number()),
    receivedAt: v.number(),
  })
    .index("by_binding_time", ["repositoryBindingId", "receivedAt"])
    .index("by_delivery", ["deliveryId"]),

  operationsHealthSnapshots: defineTable({
    eventId: v.id("events"),
    snapshot: operationsHealthSnapshot,
    eventVersion: v.number(),
    state: v.union(v.literal("ready"), v.literal("stale")),
    staleAt: v.number(),
  }).index("by_event", ["eventId"]),

  /** Each background job is single-owner without making unrelated jobs contend on one row. */
  operationsBackgroundLeases: defineTable({
    key: v.literal("operations_background"),
    holder: v.union(v.literal("health_refresh"), v.literal("autonomy_tick")),
    leaseId: v.string(),
    leaseExpiresAt: v.number(),
  }).index("by_key_and_holder", ["key", "holder"]),

  /** Append-only, redacted observations that form the intelligence world model. */
  operationsIntelligenceFacts: defineTable({
    eventId: v.id("events"),
    factKey: v.string(),
    source: v.literal("operations_health"),
    correlationKey: v.string(),
    signalKey: operationsHealthSignalKey,
    area: operationsHealthArea,
    severity: operationsHealthSeverity,
    title: v.string(),
    detail: v.string(),
    owner: v.string(),
    nextAction: v.string(),
    count: v.number(),
    atLeast: v.boolean(),
    occurredAt: v.number(),
    observedAt: v.number(),
    checksum: v.string(),
  })
    .index("by_event_fact_key", ["eventId", "factKey"])
    .index("by_event_correlation_observed_at", ["eventId", "correlationKey", "observedAt",
    ]),

  /** A durable situation assembled from related facts; identities are never people. */
  operationsIntelligenceEpisodes: defineTable({
    eventId: v.id("events"),
    correlationKey: v.string(),
    lifecycle: operationsEpisodeLifecycle,
    state: operationsEpisodeState,
    severity: operationsHealthSeverity,
    title: v.string(),
    summary: v.string(),
    owner: v.string(),
    nextAction: v.string(),
    firstObservedAt: v.number(),
    lastObservedAt: v.number(),
    clearPassCount: v.number(),
    factCount: v.number(),
    signalCount: v.number(),
    relevanceScore: v.number(),
    confidence: v.number(),
    observationChecksum: v.string(),
    revision: v.number(),
    analysisState: operationsEpisodeAnalysisState,
    analysisSummary: v.optional(v.string()),
    suggestedAction: v.optional(v.string()),
    analysisOperationId: v.optional(v.string()),
    analysisChecksum: v.optional(v.string()),
    analysisAgentVersion: v.optional(v.string()),
    analysisModel: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_event_updated_at", ["eventId", "updatedAt"])
    .index("by_event_lifecycle_relevance", ["eventId", "lifecycle", "relevanceScore",
    ])
    .index("by_event_correlation_lifecycle", ["eventId", "correlationKey", "lifecycle",
    ])
    .index("by_analysis_kind_updated_at", ["analysisState.kind", "updatedAt"]),

  operationsIntelligenceEpisodeFacts: defineTable({
    eventId: v.id("events"),
    episodeId: v.id("operationsIntelligenceEpisodes"),
    factId: v.id("operationsIntelligenceFacts"),
    factKey: v.string(),
    linkedAt: v.number(),
  })
    .index("by_episode_fact_key", ["episodeId", "factKey"])
    .index("by_episode_linked_at", ["episodeId", "linkedAt"]),

  operationsIntelligenceHypotheses: defineTable({
    eventId: v.id("events"),
    episodeId: v.id("operationsIntelligenceEpisodes"),
    analysisRevision: v.number(),
    ordinal: v.number(),
    stance: operationsEpisodeHypothesisStance,
    statement: v.string(),
    confidence: v.number(),
    evidenceFactKeys: v.array(v.string()),
    createdAt: v.number(),
  }).index("by_episode_revision_ordinal", ["episodeId", "analysisRevision", "ordinal",
  ]),

  operationsIntelligenceCounterfactuals: defineTable({
    eventId: v.id("events"),
    episodeId: v.id("operationsIntelligenceEpisodes"),
    analysisRevision: v.number(),
    ordinal: v.number(),
    intervention: v.string(),
    expectedState: operationsEpisodeExpectedState,
    probability: v.number(),
    rationale: v.string(),
    evidenceFactKeys: v.array(v.string()),
    createdAt: v.number(),
  }).index("by_episode_revision_ordinal", ["episodeId", "analysisRevision", "ordinal",
  ]),

  operationsIntelligencePredictions: defineTable({
    eventId: v.id("events"),
    episodeId: v.id("operationsIntelligenceEpisodes"),
    analysisRevision: v.number(),
    ordinal: v.number(),
    statement: v.string(),
    expectedState: operationsEpisodeExpectedState,
    probability: v.number(),
    horizonAt: v.number(),
    evidenceFactKeys: v.array(v.string()),
    outcome: operationsEpisodePredictionOutcome,
    createdAt: v.number(),
  })
    .index("by_episode_revision_ordinal", ["episodeId", "analysisRevision", "ordinal",
    ])
    .index("by_outcome_kind_horizon_at", ["outcome.kind", "horizonAt"])
    .index("by_event_outcome_kind_horizon_at", ["eventId", "outcome.kind", "horizonAt",
    ]),

  operationsIntelligenceOutcomes: defineTable({
    eventId: v.id("events"),
    episodeId: v.id("operationsIntelligenceEpisodes"),
    predictionId: v.optional(v.id("operationsIntelligencePredictions")),
    kind: v.union(
      v.literal("episode_resolved"),
      v.literal("prediction_confirmed"),
      v.literal("prediction_disconfirmed"),
      v.literal("prediction_expired"),
    ),
    summary: v.string(),
    observedAt: v.number(),
  }).index("by_episode_observed_at", ["episodeId", "observedAt"]),

  operationsIntelligenceBriefs: defineTable({
    eventId: v.id("events"),
    requestedByPersonId: v.id("people"),
    state: v.union(
      v.literal("pending"),
      v.literal("dispatching"),
      v.literal("accepted"),
      v.literal("succeeded"),
      v.literal("failed"),
    ),
    sourceSnapshot: operationsHealthSnapshot,
    sourceChecksum: v.string(),
    workId: v.optional(v.string()),
    workerSubmissionId: v.optional(v.string()),
    workerAcceptedAt: v.optional(v.number()),
    headline: v.optional(v.string()),
    summary: v.optional(v.string()),
    priorities: v.optional(v.array(operationsBriefPriority)),
    agentVersion: v.optional(v.string()),
    model: v.optional(v.string()),
    failureCode: v.optional(
      v.union(
        v.literal("dispatch_failed"),
        v.literal("agent_timed_out"),
        v.literal("model_did_not_publish"),
        v.literal("callback_rejected"),
      ),
    ),
    requestedAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    version: v.number(),
  })
    .index("by_event_requested", ["eventId", "requestedAt"])
    .index("by_event_state_updated", ["eventId", "state", "updatedAt"]),

  /** Authoritative ingress ledger for every operator-to-copilot turn. */
  operationsCopilotTurns: defineTable({
    eventId: v.id("events"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
    conversationId: v.string(),
    turnId: v.string(),
    message: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("delivery_unknown"),
      v.literal("conflict"),
    ),
    submissionId: v.optional(v.string()),
    acceptedAt: v.optional(v.number()),
    deduplicated: v.optional(v.boolean()),
    failureDetail: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_subject_turn", ["eventAccessSubjectId", "turnId"]),

  operationsAutonomyPolicyVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    enabled: v.boolean(),
    mode: operationsAutonomyMode,
    scheduleIntervalMinutes: v.number(),
    triggerSeverities: v.array(operationsHealthSeverity),
    triggerAreas: v.array(operationsHealthArea),
    escalationSeverity: operationsAutonomyEscalationSeverity,
    allowedReadTools: v.array(operationsAutonomyReadTool),
    allowedRecommendationKinds: v.array(operationsAutonomyRecommendationKind),
    accountableOwnerEventAccessSubjectId: v.id("eventAccessSubjects"),
    audience: v.literal("operations_dashboard"),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  operationsAutonomyStates: defineTable({
    eventId: v.id("events"),
    policyVersionId: v.id("operationsAutonomyPolicyVersions"),
    lifecycle: v.union(
      v.object({ kind: v.literal("active") }),
      v.object({
        kind: v.literal("disabled"),
        disabledAt: v.number(),
        disabledByPersonId: v.id("people"),
        reason: v.string(),
      }),
      v.object({ kind: v.literal("superseded"), supersededAt: v.number() }),
    ),
    nextEvaluationAt: v.number(),
    pendingWorkCount: v.number(),
    lastEvaluatedAt: v.optional(v.number()),
    lastRunAt: v.optional(v.number()),
    lastSignalAt: v.optional(v.number()),
    lastScheduleSlot: v.optional(v.number()),
    lastTriggerFingerprint: v.optional(v.string()),
    pendingCancellationAt: v.optional(v.number()),
    cycle: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_lifecycle_next_evaluation", ["lifecycle.kind", "nextEvaluationAt",
    ])
    .index("by_event", ["eventId"])
    .index("by_policy", ["policyVersionId"]),

  /** Immutable semantic triggers; distinct health states and schedule slots are never collapsed. */
  operationsAutonomyInbox: defineTable({
    eventId: v.id("events"),
    policyVersionId: v.id("operationsAutonomyPolicyVersions"),
    operationKey: v.string(),
    trigger: v.union(
      v.object({
        kind: v.literal("manual"),
        requestedByPersonId: v.id("people"),
        clientOperationId: v.string(),
      }),
      v.object({ kind: v.literal("schedule"), scheduledFor: v.number() }),
      v.object({
        kind: v.literal("signal"),
        fingerprint: v.string(),
        signalKeys: v.array(operationsAutonomySignalKey),
      }),
    ),
    sourceSnapshot: operationsAutonomySourceSnapshot,
    sourceFactHighWatermarks: v.array(
      v.object({ read: operationsAutonomyReadTool, sequence: v.number() }),
    ),
    sourceChecksum: v.string(),
    /** Technical retry scheduling keeps a busy event from starving other events. */
    nextAttemptAt: v.number(),
    lifecycle: v.union(
      v.object({ kind: v.literal("pending") }),
      v.object({ kind: v.literal("claimed"), runId: v.id("operationsAutonomyRuns"),
      }),
      v.object({ kind: v.literal("canceled"), canceledAt: v.number() }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_operation_key", ["eventId", "operationKey"])
    .index("by_event_policy_lifecycle", ["eventId", "policyVersionId", "lifecycle.kind",
    ])
    .index("by_lifecycle_next_attempt_at", ["lifecycle.kind", "nextAttemptAt"])
    .index("by_policy_lifecycle", ["policyVersionId", "lifecycle.kind"]),

  operationsAutonomyRuns: defineTable({
    eventId: v.id("events"),
    policyVersionId: v.id("operationsAutonomyPolicyVersions"),
    policyVersion: v.number(),
    policyChecksum: v.string(),
    trigger: v.union(
      v.object({
        kind: v.literal("manual"),
        requestedByPersonId: v.id("people"),
        clientOperationId: v.string(),
      }),
      v.object({ kind: v.literal("schedule"), scheduledFor: v.number() }),
      v.object({
        kind: v.literal("signal"),
        fingerprint: v.string(),
        signalKeys: v.array(operationsAutonomySignalKey),
      }),
    ),
    mode: operationsAutonomyMode,
    escalationSeverity: operationsAutonomyEscalationSeverity,
    allowedReadTools: v.array(operationsAutonomyReadTool),
    allowedRecommendationKinds: v.array(operationsAutonomyRecommendationKind),
    sourceSnapshot: operationsAutonomySourceSnapshot,
    sourceFactHighWatermarks: v.array(
      v.object({ read: operationsAutonomyReadTool, sequence: v.number() }),
    ),
    sourceChecksum: v.string(),
    operationKey: v.string(),
    admission: v.union(
      v.object({ kind: v.literal("not_accepted") }),
      v.object({
        kind: v.literal("accepted"),
        submissionId: v.string(),
        currentSubmissionId: v.string(),
        acceptedAt: v.number(),
      }),
    ),
    executor: v.union(
      v.object({ kind: v.literal("unknown") }),
      v.object({ kind: v.literal("known"), agentVersion: v.string(), model: v.string(),
      }),
    ),
    lifecycle: v.union(
      v.object({ kind: v.literal("pending") }),
      v.object({
        kind: v.literal("active"),
        leaseId: v.string(),
        leaseExpiresAt: v.number(),
      }),
      v.object({
        kind: v.union(v.literal("succeeded"), v.literal("no_op"), v.literal("escalated"),
        ),
        completedAt: v.number(),
      }),
      v.object({
        kind: v.literal("failed"),
        failureCode: v.union(operationsAutonomyFailureCode, v.literal("dispatch_failed"),
        ),
        completedAt: v.number(),
      }),
      v.object({
        kind: v.literal("canceled"),
        reason: v.union(
          v.literal("kill_switch"),
          v.literal("policy_superseded"),
          v.literal("owner_revoked"),
          v.literal("event_not_live"),
        ),
        completedAt: v.number(),
      }),
    ),
    attemptCount: v.number(),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_operation_key", ["eventId", "operationKey"])
    .index("by_event_policy_lifecycle", ["eventId", "policyVersionId", "lifecycle.kind",
    ])
    .index("by_lifecycle_created_at", ["lifecycle.kind", "createdAt"])
    .index("by_lifecycle_lease_expires_at", ["lifecycle.kind", "lifecycle.leaseExpiresAt",
    ])
    .index("by_event_created_at", ["eventId", "createdAt"])
    .index("by_policy_created_at", ["policyVersionId", "createdAt"]),

  operationsAutonomyRunCheckpoints: defineTable({
    eventId: v.id("events"),
    runId: v.id("operationsAutonomyRuns"),
    sequence: v.number(),
    phase: operationsAutonomyRunPhase,
    toolCallsUsed: v.number(),
    delegationsUsed: v.number(),
    readBytesUsed: v.number(),
    recommendationsProposed: v.number(),
    observedSignalKeys: v.array(operationsAutonomySignalKey),
    activeRead: v.union(
      v.object({ kind: v.literal("none") }),
      v.object({
        kind: v.literal("reserved"),
        operationId: v.string(),
        sequence: v.number(),
        fingerprint: v.string(),
        maximumBytes: v.number(),
      }),
    ),
    updatedAt: v.number(),
    version: v.number(),
  })
    .index("by_run", ["runId"])
    .index("by_event_updated_at", ["eventId", "updatedAt"]),

  operationsAutonomyRunSupervision: defineTable({
    eventId: v.id("events"),
    runId: v.id("operationsAutonomyRuns"),
    outboundAttempt: v.union(
      v.object({ kind: v.literal("idle") }),
      v.object({
        kind: v.literal("in_flight"),
        attemptId: v.string(),
        operation: v.union(v.literal("dispatch"), v.literal("continuation")),
        signedAt: v.number(),
        startedAt: v.number(),
        expiresAt: v.number(),
      }),
    ),
    lifecycle: v.union(
      v.object({ kind: v.literal("active"), nextActionAt: v.number() }),
      v.object({
        kind: v.literal("abort_pending"),
        nextActionAt: v.number(),
        reason: v.union(
          v.literal("kill_switch"),
          v.literal("policy_superseded"),
          v.literal("owner_revoked"),
          v.literal("event_not_live"),
        ),
        operationId: v.string(),
        attemptCount: v.number(),
      }),
      v.object({ kind: v.literal("terminal") }),
    ),
    updatedAt: v.number(),
  })
    .index("by_run", ["runId"])
    .index("by_lifecycle_next_action_at", ["lifecycle.kind", "lifecycle.nextActionAt",
    ]),

  /** Monotonic owners for immutable, redacted autonomy read facts. */
  operationsAutonomyReadFactStates: defineTable(
    v.union(
      v.object({
        eventId: v.id("events"),
        source: v.union(v.literal("operations_attention"), v.literal("review_exceptions"),
        ),
        sequence: v.number(),
        updatedAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: v.literal("support_load"),
        sequence: v.number(),
        byState: v.object({
          open: v.number(),
          investigating: v.number(),
          waiting: v.number(),
          resolved: v.number(),
          closed: v.number(),
        }),
        openByCategory: v.array(v.object({ category: supportCaseCategory, count: v.number() }),
        ),
        unassignedActiveCount: v.number(),
        oldestOpenAt: v.optional(v.number()),
        updatedAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: operationsAutonomyDeepReadSource,
        sequence: v.number(),
        updatedAt: v.number(),
      }),
    ),
  ).index("by_event_source", ["eventId", "source"]),

  /** Complete redacted temporal versions; closed intervals preserve every frozen high-watermark. */
  operationsAutonomyReadFacts: defineTable(
    v.union(
      v.object({
        eventId: v.id("events"),
        source: v.literal("operations_attention"),
        entityKey: v.string(),
        sequence: v.number(),
        effectiveThroughSequence: v.optional(v.number()),
        value: operationsAutonomyAttentionFact,
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: v.literal("intake_jobs"),
        entityKey: v.string(),
        sequence: v.number(),
        effectiveThroughSequence: v.optional(v.number()),
        value: operationsAutonomyIntakeJobFact,
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: v.literal("admission_jobs"),
        entityKey: v.string(),
        sequence: v.number(),
        effectiveThroughSequence: v.optional(v.number()),
        value: operationsAutonomyAdmissionJobFact,
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: v.literal("participant_deliveries"),
        entityKey: v.string(),
        sequence: v.number(),
        effectiveThroughSequence: v.optional(v.number()),
        value: operationsAutonomyParticipantDeliveryFact,
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: v.literal("integration_jobs"),
        entityKey: v.string(),
        sequence: v.number(),
        effectiveThroughSequence: v.optional(v.number()),
        value: operationsAutonomyIntegrationJobFact,
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: v.literal("round_export_jobs"),
        entityKey: v.string(),
        sequence: v.number(),
        effectiveThroughSequence: v.optional(v.number()),
        value: operationsAutonomyRoundExportJobFact,
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: v.literal("synesthesia_operations"),
        entityKey: v.string(),
        sequence: v.number(),
        effectiveThroughSequence: v.optional(v.number()),
        value: operationsAutonomySynesthesiaOperationFact,
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: v.literal("incident_readiness"),
        entityKey: v.string(),
        sequence: v.number(),
        effectiveThroughSequence: v.optional(v.number()),
        value: operationsAutonomyIncidentReadinessFact,
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: v.literal("attendance_operations"),
        entityKey: v.string(),
        sequence: v.number(),
        effectiveThroughSequence: v.optional(v.number()),
        value: operationsAutonomyAttendanceOperationFact,
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: v.literal("review_exceptions"),
        entityKey: v.string(),
        sequence: v.number(),
        effectiveThroughSequence: v.optional(v.number()),
        value: v.union(
          v.object({ kind: v.literal("absent") }),
          operationsAutonomyReviewExceptionFact,
        ),
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        source: v.literal("support_load"),
        entityKey: v.string(),
        sequence: v.number(),
        effectiveThroughSequence: v.optional(v.number()),
        value: operationsAutonomySupportFact,
        createdAt: v.number(),
      }),
    ),
  )
    .index("by_event_source_sequence", ["eventId", "source", "sequence"])
    .index("by_event_source_sequence_entity", ["eventId", "source", "sequence", "entityKey",
    ])
    .index("by_event_source_entity_sequence", ["eventId", "source", "entityKey", "sequence",
    ]),

  /** One immutable traversal freezes either a bounded projection or a fact-ledger high-watermark. */
  operationsAutonomyReadTraversals: defineTable(
    v.union(
      v.object({
        eventId: v.id("events"),
        runId: v.id("operationsAutonomyRuns"),
        snapshot: v.string(),
        read: operationsAutonomyReadTool,
        generatedAt: v.number(),
        kind: v.literal("frozen"),
        dataJson: v.string(),
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        runId: v.id("operationsAutonomyRuns"),
        snapshot: v.string(),
        read: v.union(
          v.literal("operations_attention"),
          v.literal("review_exceptions"),
          v.literal("support_load"),
          v.literal("intake_jobs"),
          v.literal("admission_jobs"),
          v.literal("participant_deliveries"),
          v.literal("integration_jobs"),
          v.literal("round_export_jobs"),
          v.literal("synesthesia_operations"),
          v.literal("incident_readiness"),
          v.literal("attendance_operations"),
        ),
        generatedAt: v.number(),
        kind: v.literal("facts"),
        highWatermark: v.number(),
        summaryJson: v.string(),
        createdAt: v.number(),
      }),
    ),
  ).index("by_run_snapshot", ["runId", "snapshot"]),

  operationsAutonomyOperationReceipts: defineTable(
    v.union(
      v.object({
        eventId: v.id("events"),
        runId: v.id("operationsAutonomyRuns"),
        operationId: v.string(),
        sequence: v.number(),
        fingerprint: v.string(),
        kind: v.literal("read"),
        state: v.literal("reserved"),
        read: operationsAutonomyReadTool,
        maximumBytes: v.number(),
        traversalSnapshot: v.string(),
        requestedCursor: v.optional(v.string()),
        cursorStateJson: v.string(),
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        runId: v.id("operationsAutonomyRuns"),
        operationId: v.string(),
        sequence: v.number(),
        fingerprint: v.string(),
        kind: v.literal("read"),
        state: v.literal("completed"),
        read: operationsAutonomyReadTool,
        generatedAt: v.number(),
        traversalSnapshot: v.string(),
        continueCursor: v.optional(v.string()),
        nextCursorStateJson: v.optional(v.string()),
        isDone: v.boolean(),
        citationRows: v.array(v.array(v.string())),
        responseJson: v.string(),
        responseBytes: v.number(),
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        runId: v.id("operationsAutonomyRuns"),
        operationId: v.string(),
        sequence: v.number(),
        fingerprint: v.string(),
        kind: v.literal("read"),
        state: v.literal("failed"),
        read: operationsAutonomyReadTool,
        failureCode: v.union(
          v.literal("read_unavailable"),
          v.literal("read_failed"),
          v.literal("response_too_large"),
        ),
        responseJson: v.string(),
        httpStatus: v.number(),
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        runId: v.id("operationsAutonomyRuns"),
        operationId: v.string(),
        sequence: v.number(),
        fingerprint: v.string(),
        kind: v.literal("proposal"),
        recommendationId: v.id("intelligenceRecommendations"),
        responseJson: v.string(),
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        runId: v.id("operationsAutonomyRuns"),
        operationId: v.string(),
        sequence: v.number(),
        fingerprint: v.string(),
        kind: v.literal("recommendation_support"),
        evidenceSetId: v.string(),
        pageIndex: v.number(),
        pageHash: v.string(),
        responseJson: v.string(),
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        runId: v.id("operationsAutonomyRuns"),
        operationId: v.string(),
        sequence: v.number(),
        fingerprint: v.string(),
        kind: v.literal("work"),
        responseJson: v.string(),
        createdAt: v.number(),
      }),
      v.object({
        eventId: v.id("events"),
        runId: v.id("operationsAutonomyRuns"),
        operationId: v.string(),
        sequence: v.number(),
        fingerprint: v.string(),
        kind: v.literal("callback"),
        runState: operationsAutonomyRunState,
        responseJson: v.string(),
        createdAt: v.number(),
      }),
    ),
  )
    .index("by_run_operation", ["runId", "operationId"])
    .index("by_run_sequence", ["runId", "sequence"])
    .index("by_run_continue_cursor", ["runId", "continueCursor"]),

  /** One append-only, hash-chained support stream for one autonomous effect proposal. */
  operationsAutonomyRecommendationEvidenceSets: defineTable({
    eventId: v.id("events"),
    runId: v.id("operationsAutonomyRuns"),
    proposalKey: v.string(),
    evidenceSetId: v.string(),
    lifecycle: v.union(
      v.object({
        kind: v.literal("open"),
        nextPageIndex: v.number(),
        lastPageHash: v.optional(v.string()),
        lastLeafIdentity: v.optional(v.string()),
        leafCount: v.number(),
        chunkCount: v.number(),
      }),
      v.object({
        kind: v.literal("sealed"),
        seal: operationsAutonomyRecommendationEvidenceSeal,
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_run_set", ["runId", "evidenceSetId"])
    .index("by_run_proposal", ["runId", "proposalKey"]),

  operationsAutonomyRecommendationEvidenceChunks: defineTable({
    eventId: v.id("events"),
    runId: v.id("operationsAutonomyRuns"),
    evidenceSetId: v.string(),
    pageIndex: v.number(),
    previousPageHash: v.optional(v.string()),
    pageHash: v.string(),
    firstOrdinal: v.number(),
    leafCount: v.number(),
    isDone: v.boolean(),
    createdAt: v.number(),
  }).index("by_run_set_page", ["runId", "evidenceSetId", "pageIndex"]),

  operationsAutonomyRecommendationEvidenceLeaves: defineTable({
    eventId: v.id("events"),
    runId: v.id("operationsAutonomyRuns"),
    evidenceSetId: v.string(),
    ordinal: v.number(),
    identity: v.string(),
    citation: operationsAutonomyRecommendationCitation,
    createdAt: v.number(),
  })
    .index("by_run_set_ordinal", ["runId", "evidenceSetId", "ordinal"])
    .index("by_run_set_identity", ["runId", "evidenceSetId", "identity"]),

  operationsAutonomyContinuations: defineTable({
    eventId: v.id("events"),
    runId: v.id("operationsAutonomyRuns"),
    workItemId: v.string(),
    causedByOperationId: v.string(),
    priorSubmissionId: v.optional(v.string()),
    lifecycle: v.union(
      v.object({ kind: v.literal("awaiting_prior") }),
      v.object({
        kind: v.literal("pending"),
        nextAttemptAt: v.number(),
      }),
      v.object({
        kind: v.literal("accepted"),
        submissionId: v.string(),
        acceptedAt: v.number(),
      }),
      v.object({
        kind: v.literal("canceled"),
        canceledAt: v.number(),
      }),
    ),
    attemptCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_run_work_item", ["runId", "workItemId"])
    .index("by_run_prior_submission", ["runId", "priorSubmissionId"])
    .index("by_run_created_at", ["runId", "createdAt"])
    .index("by_run_lifecycle_created_at", ["runId", "lifecycle.kind", "createdAt",
    ])
    .index("by_lifecycle_next_attempt", ["lifecycle.kind", "lifecycle.nextAttemptAt",
    ]),

  /** Only an authenticated operator can settle or execute an agent proposal. */
  intelligenceRecommendations: defineTable({
    eventId: v.id("events"),
    /** Stable key that deduplicates at-least-once tool delivery. */
    proposalKey: v.string(),
    /** Trusted identity of the normalized command target and frozen version. */
    effectKey: v.string(),
    provenance: v.union(
      v.object({
        kind: v.literal("copilot"),
        conversationId: v.string(),
        citations: v.array(intelligenceRecommendationCitation),
      }),
      v.object({
        kind: v.literal("autonomy"),
        runId: v.id("operationsAutonomyRuns"),
        evidenceSet: operationsAutonomyRecommendationEvidenceSeal,
      }),
    ),
    arguments: intelligenceRecommendationArguments,
    /** One sentence describing the effect of approval. */
    statement: v.string(),
    reasoning: v.string(),
    /** Recommendations without citations are rejected at the boundary. */
    status: intelligenceRecommendationStatus,
    agentVersion: v.string(),
    model: v.string(),
    proposedAt: v.number(),
    decidedByPersonId: v.optional(v.id("people")),
    decidedAt: v.optional(v.number()),
    /** Operator rejection reason or revision suggestion. */
    operatorNote: v.optional(v.string()),
    executedTargetType: v.optional(v.string()),
    executedTargetId: v.optional(v.string()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_proposal", ["eventId", "proposalKey"])
    .index("by_event_effect_status", ["eventId", "effectKey", "status"])
    .index("by_event_status_proposed", ["eventId", "status", "proposedAt"])
    .index("by_event_decided_at", ["eventId", "decidedAt"])
    .index("by_event_copilot_conversation_proposed", [
      "eventId",
      "provenance.kind",
      "provenance.conversationId",
      "proposedAt",
    ])
    .index("by_event_autonomy_run_proposed", [
      "eventId",
      "provenance.kind",
      "provenance.runId",
      "proposedAt",
    ]),

  /** Every autonomous observation remains auditable even when its effect deduplicates. */
  intelligenceRecommendationAutonomyObservations: defineTable({
    eventId: v.id("events"),
    recommendationId: v.id("intelligenceRecommendations"),
    runId: v.id("operationsAutonomyRuns"),
    evidenceSetId: v.string(),
    evidenceSet: operationsAutonomyRecommendationEvidenceSeal,
    statement: v.string(),
    reasoning: v.string(),
    agentVersion: v.string(),
    model: v.string(),
    observedAt: v.number(),
  })
    .index("by_recommendation_observed_at", ["recommendationId", "observedAt"])
    .index("by_recommendation_run_set", ["recommendationId", "runId", "evidenceSetId",
    ]),

  /** Durable attention item; recurrence after resolution creates a new identity. */
  operationsAttentionItems: defineTable({
    eventId: v.id("events"),
    roundId: v.optional(v.id("reviewRounds")),
    detectorKey: attentionDetectorKey,
    /** Stable detector-and-subject key; changing readings must not create new items. */
    dedupeKey: v.string(),
    subjectType: attentionSubjectType,
    subjectId: v.string(),
    severity: attentionSeverity,
    statement: v.string(),
    route: v.string(),
    actionLabel: v.string(),
    /** Grant required to read this item. */
    visibility: v.object({
      permissionKey: v.string(),
      scopeType: attentionScopeType,
      scopeId: v.string(),
    }),
    /** Detector input retained for later review. */
    evidenceJson: v.string(),
    /** Prefilled command data; execution still rechecks authorization and current state. */
    proposal: v.optional(attentionProposal),
    state: attentionItemState,
    /** Number of times the condition has recurred. */
    recurrenceCount: v.number(),
    firstObservedAt: v.number(),
    lastObservedAt: v.number(),
    /** Set while the condition is absent and cleared if it returns. */
    clearedSince: v.optional(v.number()),
    acknowledgedByPersonId: v.optional(v.id("people")),
    acknowledgedAt: v.optional(v.number()),
    dismissedByPersonId: v.optional(v.id("people")),
    dismissedAt: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    version: v.number(),
  })
    .index("by_event_state_severity_first", ["eventId", "state", "severity", "firstObservedAt",
    ])
    .index("by_event_state_severity_round_first", [
      "eventId",
      "state",
      "severity",
      "roundId",
      "firstObservedAt",
    ])
    .index("by_event_dedupe", ["eventId", "dedupeKey"])
    .index("by_round_state_severity_first", [
      "roundId",
      "state",
      "severity",
      "firstObservedAt",
      "subjectId",
    ])
    .index("by_state_round", ["state", "roundId"]),

  /** Serializes out-of-order action snapshots without touching review-floor records. */
  operationsAttentionSweepStates: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    state: v.union(v.literal("active"), v.literal("settled")),
    lastReconciledAt: v.number(),
    version: v.number(),
  })
    .index("by_round", ["roundId"])
    .index("by_event_state", ["eventId", "state"])
    .index("by_state", ["state"]),

  benefits: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    description: v.optional(v.string()),
    link: v.optional(v.string()),
    scope: v.union(v.literal("team"), v.literal("person")),
    codeMode: v.union(v.literal("shared"), v.literal("unique")),
    sharedCode: v.optional(v.string()),
    codeCount: v.number(),
    availableCodeCount: v.number(),
    grantCount: v.number(),
    latestGrantRunId: v.optional(v.id("benefitGrantRuns")),
    status: v.union(v.literal("active"), v.literal("archived")),
    version: v.number(),
    createdByPersonId: v.id("people"),
    updatedByPersonId: v.id("people"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_event_status", ["eventId", "status"]),

  benefitCodes: defineTable({
    eventId: v.id("events"),
    benefitId: v.id("benefits"),
    code: v.string(),
    state: v.union(v.literal("available"), v.literal("assigned")),
    grantId: v.optional(v.id("benefitGrants")),
    createdAt: v.number(),
  })
    .index("by_benefit_state", ["benefitId", "state"])
    .index("by_benefit_code", ["benefitId", "code"]),

  benefitGrants: defineTable({
    eventId: v.id("events"),
    benefitId: v.id("benefits"),
    teamId: v.optional(v.id("teams")),
    membershipId: v.optional(v.id("eventMemberships")),
    code: v.string(),
    grantedByPersonId: v.id("people"),
    createdAt: v.number(),
  })
    .index("by_benefit", ["benefitId", "createdAt"])
    .index("by_benefit_team", ["benefitId", "teamId"])
    .index("by_benefit_membership", ["benefitId", "membershipId"])
    .index("by_team", ["teamId"])
    .index("by_membership", ["membershipId"]),

  benefitGrantRuns: defineTable({
    eventId: v.id("events"),
    benefitId: v.id("benefits"),
    scope: v.union(v.literal("team"), v.literal("person")),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("complete"),
    ),
    teamStatusIndex: v.number(),
    cursor: v.optional(v.string()),
    scannedCount: v.number(),
    grantedCount: v.number(),
    alreadyHadCount: v.number(),
    outOfCodesCount: v.number(),
    reason: v.string(),
    authorizingGrantIds: v.array(v.id("permissionGrants")),
    requestedByPersonId: v.id("people"),
    clientOperationId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_benefit_created", ["benefitId", "createdAt"]),

  operationResults: defineTable({
    eventId: v.id("events"),
    actorPersonId: v.id("people"),
    clientOperationId: v.string(),
    commandName: v.string(),
    requestFingerprint: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    resultJson: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_actor_operation", ["actorPersonId", "clientOperationId"]),

  auditEvents: defineTable({
    eventId: v.id("events"),
    actorPersonId: v.id("people"),
    authorizingPermissionKey: v.string(),
    authorizingGrantIds: v.array(v.id("permissionGrants")),
    resolvedScopeType: scopeType,
    resolvedScopeId: v.optional(v.string()),
    action: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    previousSummary: v.optional(v.string()),
    nextSummary: v.string(),
    reason: v.string(),
    serverTime: v.number(),
  })
    .index("by_event_time", ["eventId", "serverTime"])
    .index("by_target_time", ["targetType", "targetId", "serverTime"]),

  /**
   * One finished round of one arcade game, by one person. A person may replay a
   * game as often as they like, so this table keeps every round and the
   * leaderboard reads the best of them. Scores are per person, never per team.
   */
  gameRounds: defineTable({
    eventId: v.id("events"),
    /** A `gameKeys` value from the domain catalogue. */
    gameKey: v.string(),
    personId: v.id("people"),
    membershipId: v.id("eventMemberships"),
    score: v.number(),
    playedAt: v.number(),
  })
    // One person's own rounds for that game, best read from the end.
    .index("by_event_game_person", ["eventId", "gameKey", "personId", "score"]),

  /**
   * An opened play of one game, issued before the round and spent when it is
   * reported.
   *
   * The browser reports its own score, so the run is what a report is held
   * against: it is stamped by the server when play begins, belongs to one
   * person, and is consumed once. That gives a reported score a real elapsed
   * time to be plausible against and stops one run being spent repeatedly.
   */
  gameRuns: defineTable({
    eventId: v.id("events"),
    gameKey: v.string(),
    personId: v.id("people"),
    startedAt: v.number(),
    /** When the round was reported. Unset while the run is still open. */
    consumedAt: v.optional(v.number()),
  })
    // The open runs of one person, to expire and to spend.
    .index("by_person_game", ["personId", "gameKey", "startedAt"]),

  /**
   * One person's best round of one game, kept alongside `gameRounds` so the
   * leaderboard reads people directly.
   *
   * Ranking straight from `gameRounds` would have to walk the score index and
   * skip repeat rows, and one person with enough high replays would crowd
   * everyone else out of any bounded scan. A row per person per game makes the
   * board an exact read of the first `n` rows instead.
   */
  gamePersonBests: defineTable({
    eventId: v.id("events"),
    gameKey: v.string(),
    personId: v.id("people"),
    bestScore: v.number(),
    achievedAt: v.number(),
  })
    // The leaderboard: the best of each person, highest first.
    .index("by_event_game_score", ["eventId", "gameKey", "bestScore"])
    // The row to compare against when a person finishes another round.
    .index("by_event_game_person", ["eventId", "gameKey", "personId"]),
});
