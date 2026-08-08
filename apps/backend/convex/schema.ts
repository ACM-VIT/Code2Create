import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  admissionDecision,
  admissionExperienceBand,
  admissionReviewAssignmentState,
  applicationState,
  attendanceCredentialKind,
  attendanceExportField,
  attendanceManualTransition,
  attendanceStationMode,
  barcodeSymbology,
  criterionAssessment,
  eventPhaseKey,
  eventRole,
  intakeAnswerLength,
  intakeQuestionPurpose,
  memberRole,
  noveltyBand,
  noveltyCorpusImportState,
  noveltyCorpusStatus,
  noveltyPreviewState,
  participantClass,
  projectCheckpointKey,
  permissionBundleEntry,
  permissionDelegation,
  rehearsalRunState,
  rehearsalScenarioState,
  rehearsalWorkstream,
  repositoryKind,
  reviewRoundStatus,
  reviewSessionStatus,
  scorecardStatus,
  scopeType,
  sessionPresenceState,
  songQueueMode,
  songRequestState,
  studyYear,
  supportCaseCategory,
  supportCaseState,
  synesthesiaWindowKind,
  synesthesiaWindowStatus,
  teamRoundState,
  teamStatus,
  venueCheckInStatus,
  venueIdentityCheckMethod,
  venuePresenceState,
} from "./values";
import {
  operationsBriefPriority,
  operationsHealthArea,
  operationsHealthSeverity,
  operationsHealthSnapshot,
} from "./lib/operationsIntelligenceValidators";

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

export default defineSchema({
  events: defineTable({
    slug: v.string(),
    name: v.string(),
    timezone: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("registration_open"),
      v.literal("registration_closed"),
      v.literal("live"),
      v.literal("complete"),
    ),
    vitEmailDomains: v.array(v.string()),
    publishedParticipantPolicyId: v.optional(v.id("participantPolicyVersions")),
    publishedTrackCatalogId: v.optional(v.id("trackCatalogVersions")),
    publishedEventPhaseScheduleId: v.optional(v.id("eventPhaseScheduleVersions")),
    publishedProjectCheckpointPlanId: v.optional(v.id("projectCheckpointPlanVersions")),
    publishedIntakePolicyId: v.optional(v.id("intakePolicyVersions")),
    publishedNoveltyCorpusVersionId: v.optional(v.id("noveltyCorpusVersions")),
    publishedAdmissionPolicyId: v.optional(v.id("admissionPolicyVersions")),
    publishedAdmissionModelConfigId: v.optional(v.id("admissionModelConfigVersions")),
    publishedAttendancePlanVersionId: v.optional(v.id("attendancePlanVersions")),
    publishedFloorPlanVersionId: v.optional(v.id("floorPlanVersions")),
    publishedIntegrationPolicyId: v.optional(v.id("integrationPolicyVersions")),
    publishedOperationsIntelligencePolicyId: v.optional(
      v.id("operationsIntelligencePolicyVersions"),
    ),
    publishedCommunicationsPolicyId: v.optional(v.id("communicationsPolicyVersions")),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
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
    phoneField: v.union(
      v.literal("not_collected"),
      v.literal("optional"),
      v.literal("required"),
    ),
    vitRegistrationNumberField: v.union(
      v.literal("not_collected"),
      v.literal("optional"),
      v.literal("required"),
    ),
    vitProgrammeField: v.union(
      v.literal("not_collected"),
      v.literal("optional"),
      v.literal("required"),
    ),
    vitCampusField: v.union(
      v.literal("not_collected"),
      v.literal("optional"),
      v.literal("required"),
    ),
    externalCityField: v.union(
      v.literal("not_collected"),
      v.literal("optional"),
      v.literal("required"),
    ),
    externalCountryField: v.union(
      v.literal("not_collected"),
      v.literal("optional"),
      v.literal("required"),
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

  trackCatalogVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    requiredCoreTrackCount: v.number(),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  trackVersions: defineTable({
    eventId: v.id("events"),
    catalogVersionId: v.id("trackCatalogVersions"),
    stableKey: v.string(),
    slug: v.string(),
    displayName: v.string(),
    description: v.string(),
    examples: v.array(v.string()),
    displayOrder: v.number(),
    type: v.union(v.literal("core"), v.literal("sponsor")),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("retired"),
    ),
    eligibilityText: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_catalog_type_order", ["catalogVersionId", "type", "displayOrder"])
    .index("by_catalog_key", ["catalogVersionId", "stableKey"]),

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
    status: v.union(v.literal("draft"), v.literal("published"), v.literal("retired")),
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
    status: v.union(v.literal("draft"), v.literal("published"), v.literal("retired")),
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
        maxOutputTokens: v.number(),
        timeoutMs: v.number(),
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
    notificationProvider: v.literal("cloudflare_email"),
    notificationSubject: v.string(),
    notificationIntro: v.string(),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

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
    nearestSimilarity: v.optional(v.number()),
    nearestThemeLabel: v.optional(v.string()),
    reflectionPrompt: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    failureCategory: v.optional(v.string()),
    requestedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_team_requested", ["teamId", "requestedAt"])
    .index("by_team_fingerprint_requested", ["teamId", "inputFingerprint", "requestedAt"])
    .index("by_team_client_request", ["teamId", "clientRequestId"])
    .index("by_event_state_requested", ["eventId", "state", "requestedAt"]),

  people: defineTable({
    authUserId: v.string(),
    googleSubject: v.string(),
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
    status: v.union(v.literal("active"), v.literal("suspended"), v.literal("closed")),
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
    .index("by_event_person", ["eventId", "personId"])
    .index("by_event_email", ["eventId", "emailNormalized"])
    .index("by_event_link_status_email", [
      "eventId",
      "linkedBy",
      "status",
      "emailNormalized",
    ])
    .index("by_event_status_email", ["eventId", "status", "emailNormalized"]),

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
    permissionGrantBatchIds: v.optional(v.array(v.id("permissionGrantBatches"))),
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

  eventMemberships: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
    participantClass,
    eligibilityStatus: v.union(
      v.literal("pending"),
      v.literal("eligible"),
      v.literal("rejected"),
      v.literal("suspended"),
    ),
    onboardingStatus: v.union(
      v.literal("profile_required"),
      v.literal("team_required"),
      v.literal("project_required"),
      v.literal("ready_to_submit"),
      v.literal("submitted"),
      v.literal("selected"),
      v.literal("offer_pending"),
      v.literal("accepted"),
    ),
    acceptedParticipantPolicyVersionIds: v.array(v.id("participantPolicyVersions")),
    googleHostedDomain: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_person", ["eventId", "personId"])
    .index("by_person", ["personId"])
    .index("by_event_status", ["eventId", "eligibilityStatus"])
    .index("by_event_onboarding_status", ["eventId", "onboardingStatus"]),

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
    sourceType: v.union(
      v.literal("production_seed"),
      v.literal("roster"),
      v.literal("manual"),
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
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("retired"),
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
    resolvedBindings: v.optional(
      v.array(v.object({ key: v.string(), scopeId: v.string() })),
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
    .index("by_event_target_created", ["eventId", "targetPersonId", "createdAt"])
    .index("by_event_bundle_version_status_created", [
      "eventId",
      "bundleVersionId",
      "status",
      "createdAt",
    ]),

  participantProfiles: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    participantClass,
    fullName: v.string(),
    preferredName: v.optional(v.string()),
    phone: v.optional(v.string()),
    institution: v.string(),
    yearOfStudy: studyYear,
    currentRole: v.optional(v.string()),
    vitRegistrationNumber: v.optional(v.string()),
    vitProgramme: v.optional(v.string()),
    vitCampus: v.optional(v.string()),
    externalCity: v.optional(v.string()),
    externalCountry: v.optional(v.string()),
    profileVersion: v.number(),
    updatedAt: v.number(),
  })
    .index("by_membership", ["membershipId"])
    .index("by_event_class", ["eventId", "participantClass"])
    .index("by_event_vit_registration", ["eventId", "vitRegistrationNumber"]),

  teams: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    publicCode: v.string(),
    leadMembershipId: v.id("eventMemberships"),
    status: teamStatus,
    membershipLocked: v.boolean(),
    trackLocked: v.boolean(),
    lockedProjectVersionId: v.optional(v.id("projectVersions")),
    lockedAt: v.optional(v.number()),
    lockParticipantPolicyVersionId: v.optional(v.id("participantPolicyVersions")),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_code", ["eventId", "publicCode"])
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
    source: v.union(v.literal("created"), v.literal("code"), v.literal("invitation")),
  })
    .index("by_team_status", ["teamId", "status"])
    .index("by_event_membership_status", ["eventId", "membershipId", "status"])
    .index("by_team_membership_status", ["teamId", "membershipId", "status"]),

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

  floorPlanVersions: defineTable({
    eventId: v.id("events"),
    planNumber: v.number(),
    name: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    mappingState: v.union(
      v.literal("setup"),
      v.literal("open"),
      v.literal("frozen"),
    ),
    checksum: v.string(),
    version: v.number(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedByPersonId: v.optional(v.id("people")),
    publishedAt: v.optional(v.number()),
    frozenByPersonId: v.optional(v.id("people")),
    frozenAt: v.optional(v.number()),
    freezeReason: v.optional(v.string()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_number", ["eventId", "planNumber"]),

  floorZones: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("floorPlanVersions"),
    stableKey: v.string(),
    name: v.string(),
    displayOrder: v.number(),
    createdAt: v.number(),
  })
    .index("by_plan_order", ["planVersionId", "displayOrder"])
    .index("by_plan_key", ["planVersionId", "stableKey"]),

  floorSpots: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("floorPlanVersions"),
    zoneId: v.id("floorZones"),
    stableKey: v.string(),
    label: v.string(),
    x: v.number(),
    y: v.number(),
    accessible: v.boolean(),
    status: v.union(v.literal("available"), v.literal("closed")),
    displayOrder: v.number(),
    createdAt: v.number(),
  })
    .index("by_plan_order", ["planVersionId", "displayOrder"])
    .index("by_zone_order", ["zoneId", "displayOrder"])
    .index("by_plan_key", ["planVersionId", "stableKey"]),

  teamFloorLocations: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("floorPlanVersions"),
    teamId: v.id("teams"),
    zoneId: v.id("floorZones"),
    spotId: v.id("floorSpots"),
    state: v.union(v.literal("active"), v.literal("superseded")),
    method: v.union(v.literal("team_qr_scan"), v.literal("override")),
    supersedesLocationId: v.optional(v.id("teamFloorLocations")),
    version: v.number(),
    mappedByPersonId: v.id("people"),
    mappedAt: v.number(),
    reason: v.optional(v.string()),
    supersededAt: v.optional(v.number()),
    supersededByLocationId: v.optional(v.id("teamFloorLocations")),
  })
    .index("by_team_state", ["teamId", "state"])
    .index("by_spot_state", ["spotId", "state"])
    .index("by_plan_state", ["planVersionId", "state"])
    .index("by_zone_state_mapped", ["zoneId", "state", "mappedAt"]),

  floorTeamQrTokens: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("floorPlanVersions"),
    teamId: v.id("teams"),
    tokenDigest: v.string(),
    manualCodeDigest: v.string(),
    tokenVersion: v.number(),
    state: v.union(
      v.literal("active"),
      v.literal("used"),
      v.literal("superseded"),
      v.literal("expired"),
    ),
    expiresAt: v.number(),
    issuedByMembershipId: v.id("eventMemberships"),
    issuedAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_digest", ["tokenDigest"])
    .index("by_manual_digest", ["manualCodeDigest"])
    .index("by_team_state", ["teamId", "state"]),

  floorMappingClaims: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("floorPlanVersions"),
    teamId: v.id("teams"),
    destinationZoneId: v.id("floorZones"),
    tokenId: v.id("floorTeamQrTokens"),
    operatorPersonId: v.id("people"),
    mode: v.union(v.literal("map"), v.literal("override")),
    expectedLocationId: v.optional(v.id("teamFloorLocations")),
    expectedLocationVersion: v.optional(v.number()),
    state: v.union(v.literal("active"), v.literal("completed"), v.literal("expired")),
    version: v.number(),
    expiresAt: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    locationId: v.optional(v.id("teamFloorLocations")),
  })
    .index("by_operator_state", ["operatorPersonId", "state"])
    .index("by_team_state", ["teamId", "state"]),

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
    status: v.union(
      v.literal("scheduled"),
      v.literal("active"),
      v.literal("revoked"),
      v.literal("expired"),
      v.literal("superseded"),
    ),
    sourceType: v.union(
      v.literal("production_seed"),
      v.literal("participant_membership"),
      v.literal("team_membership"),
      v.literal("team_lead"),
      v.literal("role_template"),
      v.literal("bundle"),
      v.literal("application_assignment"),
      v.literal("panel_assignment"),
      v.literal("reserve_assignment"),
      v.literal("page_assignment"),
      v.literal("station_assignment"),
      v.literal("event_subject"),
      v.literal("manual"),
      v.literal("delegated"),
    ),
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
    .index("by_subject_permission_status", [
      "eventAccessSubjectId",
      "permissionKey",
      "status",
    ])
    .index("by_person_status", ["eventId", "personId", "status"])
    .index("by_source", ["eventId", "sourceType", "sourceId", "status"])
    .index("by_status_valid_from", ["status", "validFrom"])
    .index("by_status_valid_until", ["status", "validUntil"])
    .index("by_grant_batch", ["grantBatchId"]),

  supportCases: defineTable({
    eventId: v.id("events"),
    publicCode: v.string(),
    category: supportCaseCategory,
    description: v.string(),
    origin: v.union(
      v.literal("participant"),
      v.literal("reviewer"),
      v.literal("staff"),
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
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_event_code", ["eventId", "publicCode"])
    .index("by_event_updated", ["eventId", "updatedAt"])
    .index("by_event_state_updated", ["eventId", "state", "updatedAt"])
    .index("by_event_reporter_updated", ["eventId", "reporterPersonId", "updatedAt"])
    .index("by_event_owner_state_updated", [
      "eventId",
      "ownerPersonId",
      "state",
      "updatedAt",
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
    createdAt: v.number(),
  })
    .index("by_case_time", ["supportCaseId", "createdAt"])
    .index("by_event_time", ["eventId", "createdAt"]),

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
    severity: v.union(
      v.literal("service_disruption"),
      v.literal("major"),
      v.literal("critical"),
    ),
    affectedService: v.union(
      v.literal("attendance_backend"),
      v.literal("review_backend"),
    ),
    state: v.union(
      v.literal("open"),
      v.literal("monitoring"),
      v.literal("resolved"),
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
    .index("by_event_service_opened", ["eventId", "affectedService", "openedAt"]),

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
    .index("by_event_provider_track", ["eventId", "provider", "providerTrackId"])
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
    maxVotesPerParticipant: v.number(),
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
    voteCount: v.number(),
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
    .index("by_window_requester_created", [
      "windowId",
      "requestedByMembershipId",
      "createdAt",
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
    state: v.union(v.literal("open"), v.literal("resolved"), v.literal("dismissed")),
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
    kind: v.union(v.literal("started"), v.literal("played"), v.literal("skipped")),
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

  projectDrafts: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    trackCatalogVersionId: v.id("trackCatalogVersions"),
    intakePolicyVersionId: v.id("intakePolicyVersions"),
    stage: v.union(
      v.literal("opening"),
      v.literal("track_selection"),
      v.literal("follow_up"),
      v.literal("review"),
      v.literal("submitted"),
    ),
    initialIdea: v.optional(v.string()),
    noveltyCorpusVersionId: v.optional(v.id("noveltyCorpusVersions")),
    noveltyEvaluatedInputFingerprint: v.optional(v.string()),
    noveltyScore: v.optional(v.number()),
    noveltyBand: v.optional(noveltyBand),
    noveltyNearestThemeLabel: v.optional(v.string()),
    noveltyReflectionPrompt: v.optional(v.string()),
    noveltyPreviewRequestId: v.optional(v.id("noveltyPreviewRequests")),
    noveltyEvaluatedAt: v.optional(v.number()),
    chosenCoreTrackVersionId: v.optional(v.id("trackVersions")),
    chosenSponsorTrackVersionIds: v.array(v.id("trackVersions")),
    recommendedCoreTrackVersionId: v.optional(v.id("trackVersions")),
    recommendationReason: v.optional(v.string()),
    recommendationState: v.union(
      v.literal("not_requested"),
      v.literal("pending"),
      v.literal("ready"),
      v.literal("unavailable"),
    ),
    freshnessAttestedByMembershipId: v.optional(v.id("eventMemberships")),
    freshnessAttestedAt: v.optional(v.number()),
    version: v.number(),
    lastEditedByMembershipId: v.id("eventMemberships"),
    updatedAt: v.number(),
  })
    .index("by_team", ["teamId"])
    .index("by_event_catalog", ["eventId", "trackCatalogVersionId"])
    .index("by_event_intake_policy", ["eventId", "intakePolicyVersionId"]),

  intakeAnswerVersions: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    draftId: v.id("projectDrafts"),
    promptKey: v.string(),
    generatedQuestionId: v.optional(v.id("intakeGeneratedQuestions")),
    answerVersion: v.number(),
    value: v.string(),
    supersedesAnswerVersionId: v.optional(v.id("intakeAnswerVersions")),
    status: v.union(
      v.literal("active"),
      v.literal("superseded"),
      v.literal("inactive_for_route"),
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
    source: v.union(v.literal("model"), v.literal("fallback")),
    sourceAnswerVersionIds: v.array(v.id("intakeAnswerVersions")),
    intakePolicyVersionId: v.id("intakePolicyVersions"),
    interpretationId: v.optional(v.id("intakeInterpretations")),
    matchedIdeaPatternKey: v.optional(v.string()),
    state: v.union(
      v.literal("active"),
      v.literal("answered"),
      v.literal("skipped"),
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
    recommendedCoreTrackVersionId: v.optional(v.id("trackVersions")),
    recommendationReason: v.optional(v.string()),
    recommendationSourceAnswerVersionIds: v.array(v.id("intakeAnswerVersions")),
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

  projectVersions: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    version: v.number(),
    initialIdea: v.string(),
    intakePolicyVersionId: v.id("intakePolicyVersions"),
    intakeResponses: v.array(
      v.object({
        questionId: v.id("intakeGeneratedQuestions"),
        ordinal: v.number(),
        question: v.string(),
        purposeKey: intakeQuestionPurpose,
        answerLength: intakeAnswerLength,
        source: v.union(v.literal("model"), v.literal("fallback")),
        answer: v.optional(v.string()),
        skipped: v.boolean(),
      }),
    ),
    coreTrackVersionId: v.id("trackVersions"),
    sponsorTrackVersionIds: v.array(v.id("trackVersions")),
    lockedTeamMemberIds: v.array(v.id("teamMembers")),
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
      previewedTrackVersionId: v.id("trackVersions"),
      previewedSponsorTrackVersionIds: v.array(v.id("trackVersions")),
      confirmedByMembershipId: v.id("eventMemberships"),
      confirmedAt: v.number(),
    }),
    participantPolicyVersionId: v.id("participantPolicyVersions"),
    admissionPolicyVersionId: v.id("admissionPolicyVersions"),
    admissionInformationResponses: v.optional(
      v.array(
        v.object({
          requestId: v.id("admissionInformationRequests"),
          sourceProjectVersionId: v.id("projectVersions"),
          answers: v.array(
            v.object({
              questionKey: v.string(),
              question: v.string(),
              answer: v.string(),
            }),
          ),
          respondedByMembershipId: v.id("eventMemberships"),
          respondedAt: v.number(),
        }),
      ),
    ),
    sourceDraftVersion: v.number(),
    submittedByMembershipId: v.id("eventMemberships"),
    submittedAt: v.number(),
  })
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
    .index("by_event_key_submitted", ["eventId", "checkpointKey", "submittedAt"]),

  applications: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    submittedProjectVersionId: v.id("projectVersions"),
    admissionPolicyVersionId: v.id("admissionPolicyVersions"),
    state: applicationState,
    experienceBand: admissionExperienceBand,
    aiRecommendationId: v.optional(v.id("admissionAIRecommendations")),
    aiDisposition: v.optional(
      v.union(
        v.literal("used"),
        v.literal("cleared"),
        v.literal("overridden"),
        v.literal("stale"),
        v.literal("unavailable"),
      ),
    ),
    humanDecision: v.optional(admissionDecision),
    humanReasonCode: v.optional(v.string()),
    decidedByPersonId: v.optional(v.id("people")),
    decidedAt: v.optional(v.number()),
    currentInformationRequestId: v.optional(v.id("admissionInformationRequests")),
    currentOfferId: v.optional(v.id("admissionOffers")),
    assignedReviewCount: v.number(),
    completedReviewCount: v.number(),
    contentVersion: v.number(),
    version: v.number(),
    submittedAt: v.number(),
  })
    .index("by_team", ["teamId"])
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
      v.literal("needs_information"),
      v.literal("offer"),
      v.literal("offer_confirmed"),
      v.literal("offer_declined"),
      v.literal("offer_expired"),
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
    .index("by_application_membership_created", [
      "applicationId",
      "membershipId",
      "createdAt",
    ])
    .index("by_destination_state", ["destinationId", "state"])
    .index("by_event_state_updated", ["eventId", "state", "updatedAt"])
    .index("by_event_state_claim", ["eventId", "state", "claimExpiresAt"])
    .index("by_event_state_next_attempt", ["eventId", "state", "nextAttemptAt"]),

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
    state: v.union(
      v.literal("pending"),
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
    recommendation: v.optional(admissionDecision),
    criterionAssessments: v.array(
      v.object({
        criterionKey: v.string(),
        assessment: criterionAssessment,
        sourceRefs: v.array(v.string()),
      }),
    ),
    strengths: v.array(v.string()),
    concerns: v.array(v.string()),
    proposedQuestions: v.array(v.string()),
    confidence: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"))),
    limitations: v.array(v.string()),
    providerRequestId: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    failureCategory: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_application_created", ["applicationId", "createdAt"])
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
    maxOutputTokens: v.number(),
    timeoutMs: v.number(),
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
    .index("by_application_reviewer_status", [
      "applicationId",
      "reviewerPersonId",
      "status",
    ]),

  admissionInformationRequests: defineTable({
    eventId: v.id("events"),
    applicationId: v.id("applications"),
    teamId: v.id("teams"),
    sourceProjectVersionId: v.id("projectVersions"),
    applicationContentVersion: v.number(),
    decisionReasonCode: v.string(),
    questions: v.array(
      v.object({
        questionKey: v.string(),
        question: v.string(),
      }),
    ),
    state: v.union(
      v.literal("open"),
      v.literal("answered"),
      v.literal("superseded"),
    ),
    answers: v.optional(
      v.array(
        v.object({
          questionKey: v.string(),
          answer: v.string(),
        }),
      ),
    ),
    responseProjectVersionId: v.optional(v.id("projectVersions")),
    requestedByPersonId: v.id("people"),
    requestedAt: v.number(),
    respondedByMembershipId: v.optional(v.id("eventMemberships")),
    respondedAt: v.optional(v.number()),
    supersededAt: v.optional(v.number()),
    version: v.number(),
  })
    .index("by_application_created", ["applicationId", "requestedAt"])
    .index("by_application_state", ["applicationId", "state"])
    .index("by_team_state", ["teamId", "state"]),

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
    .index("by_application_state_assigned", ["applicationId", "state", "assignedAt"])
    .index("by_application_reviewer_state", [
      "applicationId",
      "reviewerPersonId",
      "state",
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
    scope: v.union(v.literal("overall"), v.literal("track")),
    trackVersionId: v.optional(v.id("trackVersions")),
    capacity: v.number(),
    reserved: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_policy_scope_track", [
      "admissionPolicyVersionId",
      "scope",
      "trackVersionId",
    ])
    .index("by_event_scope", ["eventId", "scope"]),

  admissionOffers: defineTable({
    eventId: v.id("events"),
    applicationId: v.id("applications"),
    teamId: v.id("teams"),
    offeredTeamMemberIds: v.array(v.id("teamMembers")),
    participantCount: v.number(),
    reservedCoreTrackVersionId: v.id("trackVersions"),
    source: v.literal("accepted_decision"),
    state: v.union(
      v.literal("offered"),
      v.literal("confirmed"),
      v.literal("declined"),
      v.literal("expired"),
      v.literal("revoked"),
    ),
    sentAt: v.number(),
    expiresAt: v.number(),
    createdByPersonId: v.id("people"),
    createdByGrantIds: v.array(v.id("permissionGrants")),
    confirmedTeamMemberIds: v.optional(v.array(v.id("teamMembers"))),
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
    trackVersionId: v.id("trackVersions"),
    participantCount: v.number(),
    trackCapacityReserved: v.boolean(),
    state: v.union(v.literal("active"), v.literal("released")),
    reservedAt: v.number(),
    releasedAt: v.optional(v.number()),
    releasedReason: v.optional(
      v.union(v.literal("offer_declined"), v.literal("offer_expired"), v.literal("offer_revoked")),
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
    status: v.union(
      v.literal("active"),
      v.literal("retired"),
      v.literal("compromised"),
    ),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    retiredAt: v.optional(v.number()),
  }).index("by_event_status_version", ["eventId", "status", "version"]),

  attendanceZones: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("attendancePlanVersions"),
    stableKey: v.string(),
    name: v.string(),
    safeCapacity: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_plan_key", ["planVersionId", "stableKey"]),

  attendanceSessions: defineTable({
    eventId: v.id("events"),
    planVersionId: v.id("attendancePlanVersions"),
    stableKey: v.string(),
    name: v.string(),
    kind: v.union(
      v.literal("hacking"),
      v.literal("briefing"),
      v.literal("review_preparation"),
      v.literal("overnight_access"),
      v.literal("workshop"),
      v.literal("other"),
    ),
    requirement: v.union(
      v.literal("required"),
      v.literal("optional"),
      v.literal("information_only"),
    ),
    expectedCohort: v.union(
      v.object({ kind: v.literal("all_admitted") }),
      v.object({
        kind: v.literal("participant_classes"),
        participantClasses: v.array(participantClass),
      }),
      v.object({
        kind: v.literal("tracks"),
        trackVersionIds: v.array(v.id("trackVersions")),
      }),
      v.object({
        kind: v.literal("explicit"),
        membershipIds: v.array(v.id("eventMemberships")),
      }),
    ),
    zoneId: v.id("attendanceZones"),
    status: v.union(
      v.literal("scheduled"),
      v.literal("preparing"),
      v.literal("ready"),
      v.literal("open"),
      v.literal("closing"),
      v.literal("closed"),
      v.literal("cancelled"),
    ),
    startsAt: v.number(),
    endsAt: v.number(),
    checkInOpensAt: v.number(),
    checkInClosesAt: v.number(),
    awayAlertAfterMinutes: v.optional(v.number()),
    expectationBuildState: v.union(
      v.literal("not_started"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
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
    kind: v.union(
      v.literal("build_expectations"),
      v.literal("finalize_results"),
      v.literal("cancel_results"),
    ),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
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
    mode: attendanceStationMode,
    allowedCredentialKinds: v.array(attendanceCredentialKind),
    status: v.union(v.literal("inactive"), v.literal("active"), v.literal("disabled")),
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
    credentialKind: v.optional(
      v.union(v.literal("vit_id_barcode"), v.literal("badge_qr")),
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

  attendancePortalCredentials: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    version: v.number(),
    state: v.union(v.literal("active"), v.literal("suspended")),
    updatedAt: v.number(),
  }).index("by_membership", ["membershipId"]),

  attendancePortalQrTokens: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    portalCredentialId: v.id("attendancePortalCredentials"),
    credentialVersion: v.number(),
    sessionId: v.optional(v.id("attendanceSessions")),
    tokenHash: v.string(),
    state: v.union(v.literal("active"), v.literal("used"), v.literal("revoked")),
    issuedAt: v.number(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    usedByEventId: v.optional(v.id("attendancePresenceEvents")),
  })
    .index("by_event_token", ["eventId", "tokenHash"])
    .index("by_membership_state", ["membershipId", "state"]),

  staffedParticipantResolutions: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    portalQrTokenId: v.id("attendancePortalQrTokens"),
    stationId: v.id("attendanceStations"),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    resolvedByPersonId: v.id("people"),
    resolvedAt: v.number(),
    expiresAt: v.number(),
    venueAction: v.optional(
      v.union(v.literal("record_check_in"), v.literal("reverse_check_in")),
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
      ),
    ),
    credentialActionAt: v.optional(v.number()),
    attendanceCredentialId: v.optional(v.id("attendanceCredentials")),
  })
    .index("by_portal_token", ["portalQrTokenId"])
    .index("by_event_membership_time", ["eventId", "membershipId", "resolvedAt"]),

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
  })
    .index("by_event_team", ["eventId", "teamId"]),

  attendanceSessionParticipants: defineTable({
    eventId: v.id("events"),
    sessionId: v.id("attendanceSessions"),
    membershipId: v.id("eventMemberships"),
    expectation: v.union(
      v.literal("required"),
      v.literal("optional"),
      v.literal("not_expected"),
      v.literal("excused"),
    ),
    state: sessionPresenceState,
    confirmedAt: v.optional(v.number()),
    late: v.boolean(),
    currentIntervalId: v.optional(v.id("attendancePresenceIntervals")),
    lastEventId: v.optional(v.id("attendancePresenceEvents")),
    result: v.optional(
      v.union(
        v.literal("attended"),
        v.literal("absent"),
        v.literal("partial"),
        v.literal("excused"),
        v.literal("not_expected"),
        v.literal("needs_review"),
      ),
    ),
    presentDurationMs: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session_membership", ["sessionId", "membershipId"])
    .index("by_session_state", ["sessionId", "state"])
    .index("by_membership", ["membershipId"]),

  attendanceResultRemedyCases: defineTable({
    eventId: v.id("events"),
    sessionId: v.id("attendanceSessions"),
    membershipId: v.id("eventMemberships"),
    sessionParticipantId: v.id("attendanceSessionParticipants"),
    state: v.union(
      v.literal("open"),
      v.literal("approved"),
      v.literal("declined"),
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
    .index("by_session_membership_state", ["sessionId", "membershipId", "state"])
    .index("by_session_membership_created", ["sessionId", "membershipId", "createdAt"])
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
    sourceKind: v.union(
      v.literal("scanner"),
      v.literal("staff_reconciliation"),
      v.literal("manual_import"),
    ),
    stationId: v.optional(v.id("attendanceStations")),
    stationConfigurationVersion: v.optional(v.number()),
    zoneId: v.id("attendanceZones"),
    sessionId: v.optional(v.id("attendanceSessions")),
    deviceInstallationId: v.optional(v.id("attendanceDeviceInstallations")),
    operatorPersonId: v.id("people"),
    membershipId: v.optional(v.id("eventMemberships")),
    credentialId: v.optional(v.id("attendanceCredentials")),
    portalQrTokenId: v.optional(v.id("attendancePortalQrTokens")),
    credentialKind: attendanceCredentialKind,
    clientOperationId: v.string(),
    requestFingerprint: v.string(),
    deviceSequence: v.optional(v.number()),
    capturedAt: v.number(),
    receivedAt: v.number(),
    isOfflineReplay: v.boolean(),
    transition: v.union(
      v.literal("venue_entry"),
      v.literal("venue_exit"),
      v.literal("session_confirm"),
      v.literal("zone_entry"),
      v.literal("zone_exit"),
      v.literal("manual_reconcile"),
    ),
    outcome: v.union(
      v.literal("accepted"),
      v.literal("duplicate"),
      v.literal("rejected"),
      v.literal("needs_review"),
      v.literal("reconciled"),
    ),
    reasonCode: v.string(),
    previousState: v.optional(v.string()),
    nextState: v.optional(v.string()),
    correctionKind: v.optional(
      v.union(
        v.literal("presence_confirmed"),
        v.literal("temporary_exit"),
        v.literal("marked_needs_review"),
        v.literal("voided_transition"),
      ),
    ),
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
    .index("by_session_membership_time", [
      "sessionId",
      "membershipId",
      "receivedAt",
    ])
    .index("by_manual_sheet_line", ["manualSheetId", "manualSheetLineNumber"]),

  attendancePresenceIntervals: defineTable({
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    zoneId: v.id("attendanceZones"),
    sessionId: v.optional(v.id("attendanceSessions")),
    kind: v.union(v.literal("venue"), v.literal("session")),
    status: v.union(
      v.literal("open"),
      v.literal("closed"),
      v.literal("voided"),
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
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
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
    .index("by_session_requester_created", [
      "sessionId",
      "requestedByPersonId",
      "requestedAt",
    ])
    .index("by_event_status_created", ["eventId", "status", "requestedAt"]),

  emergencyPacks: defineTable({
    eventId: v.id("events"),
    requestedByPersonId: v.id("people"),
    purpose: v.string(),
    serialPrefix: v.string(),
    spareAttendanceSheetCount: v.number(),
    spareReviewSheetCount: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
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
    startsAt: v.number(),
    endsAt: v.number(),
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
    minimumScorersPerCriterion: v.number(),
    minimumPresentParticipants: v.number(),
    requiresSharedCommitments: v.boolean(),
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
    .index("by_event_key", ["eventId", "stableKey"]),

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

  reviewerProfiles: defineTable({
    eventId: v.id("events"),
    personId: v.id("people"),
    contactPhone: v.optional(v.string()),
    technicalDomains: v.array(v.string()),
    productDomains: v.array(v.string()),
    languages: v.array(v.string()),
    criterionKeys: v.array(v.string()),
    trainingStatus: v.union(
      v.literal("pending"),
      v.literal("complete"),
      v.literal("blocked"),
    ),
    status: v.union(v.literal("active"), v.literal("inactive")),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_event_person", ["eventId", "personId"]),

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
    pushEnvironment: v.optional(
      v.union(v.literal("development"), v.literal("production")),
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
    .index("by_event_person_status", ["eventId", "personId", "status"]),

  reviewerClockIns: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    reviewerPersonId: v.id("people"),
    reviewerDeviceId: v.id("reviewerDevices"),
    status: v.union(
      v.literal("present"),
      v.literal("temporarily_unavailable"),
      v.literal("clocked_out"),
      v.literal("no_show"),
    ),
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
    .index("by_event_status_heartbeat", ["eventId", "status", "lastHeartbeatAt"]),

  reviewPanels: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    stableKey: v.string(),
    name: v.string(),
    tableLabel: v.string(),
    coordinatorPersonId: v.id("people"),
    status: v.union(
      v.literal("draft"),
      v.literal("ready"),
      v.literal("needs_reviewer"),
      v.literal("paused"),
      v.literal("closed"),
    ),
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
    isCoordinator: v.boolean(),
    status: v.union(v.literal("active"), v.literal("replaced"), v.literal("removed")),
    assignedAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    .index("by_panel_status", ["panelId", "status"])
    .index("by_round_person_status", ["roundId", "personId", "status"])
    .index("by_person_status", ["personId", "status"]),

  reviewRoundReserves: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    personId: v.id("people"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
    status: v.union(
      v.literal("available"),
      v.literal("paged"),
      v.literal("assigned"),
      v.literal("removed"),
    ),
    pageCount: v.number(),
    lastPagedAt: v.optional(v.number()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_round_status", ["roundId", "status"])
    .index("by_round_person", ["roundId", "personId"])
    .index("by_person_status", ["personId", "status"]),

  reviewerConflicts: defineTable({
    eventId: v.id("events"),
    reviewerPersonId: v.id("people"),
    teamId: v.id("teams"),
    kind: v.union(v.literal("declared"), v.literal("reported"), v.literal("policy")),
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
    tableLabel: v.optional(v.string()),
    queuedAt: v.optional(v.number()),
    calledAt: v.optional(v.number()),
    callAttemptCount: v.number(),
    lastCallAttemptAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    holdReason: v.optional(v.string()),
    stateBeforeHold: v.optional(teamRoundState),
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
    .index("by_round_state_priority_queued", ["roundId", "state", "priority", "queuedAt"])
    .index("by_panel_state_priority_queued", ["panelId", "state", "priority", "queuedAt"]),

  reviewEvidenceCheckpointSets: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    roundSequence: v.number(),
    teamId: v.id("teams"),
    projectVersionId: v.id("projectVersions"),
    teamCheckpointSubmissionId: v.optional(v.id("teamCheckpointSubmissions")),
    previousCheckpointSetId: v.optional(v.id("reviewEvidenceCheckpointSets")),
    githubEntries: v.array(
      v.object({
        bindingId: v.id("githubRepositoryBindings"),
        snapshotId: v.optional(v.id("githubRepositorySnapshots")),
        repositoryName: v.string(),
        repositoryUrl: v.string(),
        kind: repositoryKind,
        purpose: v.string(),
        trackedBranch: v.string(),
        rootPath: v.optional(v.string()),
        requiredTopic: v.string(),
        stateAtCapture: v.string(),
      }),
    ),
    figmaEntries: v.array(
      v.object({
        bindingId: v.id("figmaFileBindings"),
        snapshotId: v.optional(v.id("figmaFileSnapshots")),
        fileName: v.string(),
        fileUrl: v.string(),
        role: v.string(),
        editorType: v.string(),
        stateAtCapture: v.string(),
      }),
    ),
    expectedResourceCount: v.number(),
    capturedResourceCount: v.number(),
    completeness: v.union(v.literal("complete"), v.literal("partial"), v.literal("missing")),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
  })
    .index("by_round_team_time", ["roundId", "teamId", "createdAt"])
    .index("by_team_round_sequence_created", ["teamId", "roundSequence", "createdAt"])
    .index("by_event_created", ["eventId", "createdAt"]),

  reviewSessions: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    panelId: v.id("reviewPanels"),
    teamId: v.id("teams"),
    projectVersionId: v.id("projectVersions"),
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
    .index("by_round_team_status", ["roundId", "teamId", "status"])
    .index("by_panel_status", ["panelId", "status"])
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
    status: v.union(v.literal("assigned"), v.literal("conflict"), v.literal("removed")),
    assignedAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    .index("by_session_person", ["reviewSessionId", "reviewerPersonId"])
    .index("by_round_session", ["roundId", "reviewSessionId"])
    .index("by_person_status", ["reviewerPersonId", "status"]),

  reviewPresence: defineTable({
    eventId: v.id("events"),
    reviewSessionId: v.id("reviewSessions"),
    reviewerPersonId: v.id("people"),
    reviewerDeviceId: v.optional(v.id("reviewerDevices")),
    method: v.union(
      v.literal("qr"),
      v.literal("fallback_code"),
      v.literal("board_override"),
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
    state: v.union(v.literal("active"), v.literal("superseded"), v.literal("expired")),
    expiresAt: v.number(),
    issuedByMembershipId: v.id("eventMemberships"),
    issuedAt: v.number(),
  })
    .index("by_digest", ["tokenDigest"])
    .index("by_manual_digest", ["manualCodeDigest"])
    .index("by_session_state", ["reviewSessionId", "state"]),

  reviewerPageChains: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    panelId: v.id("reviewPanels"),
    reviewSessionId: v.optional(v.id("reviewSessions")),
    missingPanelMemberId: v.id("reviewPanelMembers"),
    requiredCriterionIds: v.array(v.id("reviewRubricCriteria")),
    reason: v.string(),
    responseWindowSeconds: v.number(),
    state: v.union(
      v.literal("active"),
      v.literal("filled"),
      v.literal("exhausted"),
      v.literal("cancelled"),
    ),
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
    state: v.union(
      v.literal("sent"),
      v.literal("opened"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("expired"),
      v.literal("cancelled"),
    ),
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
    .index("by_reserve_state", ["reserveId", "state"])
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_event_person_created", ["eventId", "targetPersonId", "createdAt"])
    .index("by_event_state_expiry", ["eventId", "state", "expiresAt"]),

  reviewerPushDeliveries: defineTable({
    eventId: v.id("events"),
    pageId: v.id("reviewerPages"),
    targetPersonId: v.id("people"),
    reviewerDeviceId: v.id("reviewerDevices"),
    purpose: v.literal("substitute_page"),
    tokenFingerprint: v.optional(v.string()),
    state: v.union(
      v.literal("unavailable"),
      v.literal("pending"),
      v.literal("sending"),
      v.literal("retry_wait"),
      v.literal("provider_accepted"),
      v.literal("failed"),
      v.literal("superseded"),
    ),
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
    .index("by_device_state", ["reviewerDeviceId", "state"]),

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
    .index("by_reviewer_status", ["reviewerPersonId", "status"])
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_event_reviewer_created", ["eventId", "reviewerPersonId", "createdAt"]),

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
    tableLabel: v.string(),
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
    .index("by_review_status_created", ["reviewSessionId", "status", "enteredAt"])
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
    state: v.union(v.literal("complete"), v.literal("void")),
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
    kind: v.union(v.literal("correction"), v.literal("void")),
    category: v.union(
      v.literal("reviewer_error"),
      v.literal("technical_error"),
      v.literal("wrong_team"),
      v.literal("duplicate_review"),
      v.literal("confirmed_conflict"),
      v.literal("judge_ineligible"),
      v.literal("other"),
    ),
    reason: v.string(),
    evidenceReference: v.optional(v.string()),
    state: v.union(
      v.literal("requested"),
      v.literal("open"),
      v.literal("rejected"),
      v.literal("closed"),
    ),
    originalVersionId: v.id("scorecardVersions"),
    replacementVersionId: v.optional(v.id("scorecardVersions")),
    voidDisposition: v.optional(
      v.union(v.literal("exclude"), v.literal("replacement_review")),
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
    state: v.union(
      v.literal("generating"),
      v.literal("uploaded"),
      v.literal("verified"),
      v.literal("failed"),
      v.literal("superseded"),
    ),
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

  scoreReleaseVersions: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    closeSnapshotId: v.id("roundCloseSnapshots"),
    roundExportId: v.id("roundExports"),
    policyVersion: v.string(),
    includeCriterionScores: v.boolean(),
    includeTotalScore: v.boolean(),
    includeSharedFindings: v.boolean(),
    includeSharedCommitments: v.boolean(),
    checksum: v.string(),
    publishedByPersonId: v.id("people"),
    publishedAt: v.number(),
    reason: v.string(),
  }).index("by_round", ["roundId"]),

  scoreReleaseEntries: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    releaseId: v.id("scoreReleaseVersions"),
    teamId: v.id("teams"),
    reviewSessionId: v.id("reviewSessions"),
    criterionResults: v.array(
      v.object({
        criterionId: v.id("reviewRubricCriteria"),
        meanScore: v.number(),
        weightedPoints: v.number(),
      }),
    ),
    totalPoints: v.number(),
    sharedFindings: v.optional(v.string()),
    sharedCommitments: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_release_team", ["releaseId", "teamId"])
    .index("by_team_time", ["teamId", "createdAt"]),

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
    maxActiveFigmaFilesPerTeam: v.number(),
    githubFreezeAt: v.optional(v.number()),
    figmaFreezeAt: v.optional(v.number()),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  githubSetupIntents: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    personId: v.id("people"),
    stateDigest: v.string(),
    returnPath: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("verifying"),
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
    .index("by_team_status", ["teamId", "status"]),

  githubInstallationConnections: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    installationId: v.string(),
    accountId: v.string(),
    accountLogin: v.string(),
    targetType: v.union(
      v.literal("User"),
      v.literal("Organization"),
      v.literal("Enterprise"),
    ),
    repositorySelection: v.union(v.literal("all"), v.literal("selected")),
    state: v.union(
      v.literal("active"),
      v.literal("suspended"),
      v.literal("revoked"),
    ),
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
    topicState: v.union(v.literal("present"), v.literal("missing"), v.literal("unknown")),
    state: v.union(
      v.literal("setup"),
      v.literal("active"),
      v.literal("inaccessible"),
      v.literal("revoked"),
      v.literal("archived"),
    ),
    baselineSha: v.optional(v.string()),
    currentHeadSha: v.optional(v.string()),
    pendingHeadSha: v.optional(v.string()),
    lastProviderPushedAt: v.optional(v.number()),
    lastWebhookAt: v.optional(v.number()),
    lastReconciledAt: v.optional(v.number()),
    syncRevision: v.number(),
    syncedRevision: v.number(),
    syncState: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("ready"),
      v.literal("rate_limited"),
      v.literal("error"),
    ),
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
    .index("by_event_topic_state_updated", ["eventId", "topicState", "updatedAt"])
    .index("by_event_state_sync_updated", ["eventId", "state", "syncState", "updatedAt"])
    .index("by_event_state_sync_lease", [
      "eventId",
      "state",
      "syncState",
      "syncLeaseExpiresAt",
    ])
    .index("by_event_state_topic_updated", [
      "eventId",
      "state",
      "topicState",
      "updatedAt",
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
    languageBytes: v.array(v.object({ language: v.string(), bytes: v.number() })),
    completeness: v.union(v.literal("complete"), v.literal("partial"), v.literal("unknown")),
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
    reason: v.union(v.literal("baseline"), v.literal("push"), v.literal("manual"), v.literal("reconcile")),
    headSha: v.string(),
    topicState: v.union(v.literal("present"), v.literal("missing"), v.literal("unknown")),
    commitCount: v.number(),
    additions: v.number(),
    deletions: v.number(),
    changedFiles: v.number(),
    observedCommitShas: v.array(v.string()),
    commitIdentityComplete: v.boolean(),
    languageBytes: v.array(v.object({ language: v.string(), bytes: v.number() })),
    completeness: v.union(v.literal("complete"), v.literal("partial"), v.literal("unknown")),
    compareTruncated: v.boolean(),
    providerCommitAt: v.optional(v.number()),
    capturedAt: v.number(),
  })
    .index("by_binding_time", ["repositoryBindingId", "capturedAt"])
    .index("by_team_time", ["teamId", "capturedAt"]),

  githubTeamMetrics: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    health: v.union(
      v.literal("not_connected"),
      v.literal("ready"),
      v.literal("syncing"),
      v.literal("needs_attention"),
    ),
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
    languageBytes: v.array(v.object({ language: v.string(), bytes: v.number() })),
    completeness: v.union(v.literal("complete"), v.literal("partial"), v.literal("unknown")),
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
    state: v.union(v.literal("accepted"), v.literal("ignored"), v.literal("rejected")),
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

  figmaSetupIntents: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    personId: v.id("people"),
    stateDigest: v.string(),
    pkceVerifierCiphertext: v.string(),
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
    credentialId: v.optional(v.id("figmaOAuthCredentials")),
    credentialConnectionId: v.optional(v.id("figmaCredentialConnections")),
    failureCode: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_state_digest", ["stateDigest"])
    .index("by_team_status", ["teamId", "status"]),

  figmaOAuthCredentials: defineTable({
    figmaUserId: v.string(),
    accessTokenCiphertext: v.string(),
    refreshTokenCiphertext: v.string(),
    tokenExpiresAt: v.number(),
    tokenReceivedAt: v.number(),
    scopes: v.array(v.string()),
    status: v.union(v.literal("active"), v.literal("revoked"), v.literal("error")),
    authorizedByPersonId: v.id("people"),
    refreshLeaseId: v.optional(v.string()),
    refreshLeaseExpiresAt: v.optional(v.number()),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_figma_user", ["figmaUserId"]),

  figmaCredentialConnections: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    credentialId: v.id("figmaOAuthCredentials"),
    state: v.union(v.literal("active"), v.literal("revoked")),
    connectedByPersonId: v.id("people"),
    connectedAt: v.number(),
    lastVerifiedAt: v.number(),
    version: v.number(),
  })
    .index("by_team_state", ["teamId", "state"])
    .index("by_team_credential", ["teamId", "credentialId"])
    .index("by_credential_state", ["credentialId", "state"]),

  figmaFileBindings: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    credentialId: v.id("figmaOAuthCredentials"),
    credentialConnectionId: v.id("figmaCredentialConnections"),
    fileKey: v.string(),
    mainFileKey: v.optional(v.string()),
    url: v.string(),
    name: v.string(),
    role: v.string(),
    linkAccess: v.string(),
    editorType: v.string(),
    versionId: v.string(),
    observedVersionId: v.optional(v.string()),
    lastTouchedAt: v.number(),
    lastProviderObservedAt: v.optional(v.number()),
    thumbnailUrl: v.optional(v.string()),
    state: v.union(
      v.literal("active"),
      v.literal("inaccessible"),
      v.literal("revoked"),
      v.literal("archived"),
    ),
    webhookId: v.optional(v.string()),
    webhookPasscodeDigest: v.optional(v.string()),
    webhookState: v.union(
      v.literal("pending"),
      v.literal("active"),
      v.literal("unavailable"),
      v.literal("error"),
    ),
    lastProviderEventAt: v.optional(v.number()),
    lastMetadataCheckAt: v.number(),
    nextMetadataCheckAt: v.optional(v.number()),
    metadataLeaseId: v.optional(v.string()),
    metadataLeaseExpiresAt: v.optional(v.number()),
    metadataErrorCode: v.optional(v.string()),
    metadataRateLimitRetryAt: v.optional(v.number()),
    metadataRateLimitPlanTier: v.optional(v.string()),
    metadataRateLimitType: v.optional(v.string()),
    lastFullCaptureAt: v.number(),
    contentDirty: v.boolean(),
    rateLimitRetryAt: v.optional(v.number()),
    rateLimitPlanTier: v.optional(v.string()),
    rateLimitType: v.optional(v.string()),
    syncRevision: v.number(),
    syncedRevision: v.number(),
    syncState: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("ready"),
      v.literal("rate_limited"),
      v.literal("error"),
    ),
    syncLeaseId: v.optional(v.string()),
    syncLeaseExpiresAt: v.optional(v.number()),
    syncErrorCode: v.optional(v.string()),
    version: v.number(),
    connectedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_team_state", ["teamId", "state"])
    .index("by_event_file", ["eventId", "fileKey"])
    .index("by_credential_state", ["credentialId", "state"])
    .index("by_webhook", ["webhookId"])
    .index("by_event_state_updated", ["eventId", "state", "updatedAt"])
    .index("by_event_sync_state_updated", ["eventId", "syncState", "updatedAt"])
    .index("by_event_webhook_state_updated", ["eventId", "webhookState", "updatedAt"])
    .index("by_event_state_sync_updated", ["eventId", "state", "syncState", "updatedAt"])
    .index("by_event_state_sync_lease", [
      "eventId",
      "state",
      "syncState",
      "syncLeaseExpiresAt",
    ])
    .index("by_event_state_webhook_updated", [
      "eventId",
      "state",
      "webhookState",
      "updatedAt",
    ])
    .index("by_state_metadata_due", ["state", "nextMetadataCheckAt"])
    .index("by_event_state_metadata_check", [
      "eventId",
      "state",
      "lastMetadataCheckAt",
    ])
    .index("by_event_state_rate_limit", [
      "eventId",
      "state",
      "rateLimitRetryAt",
    ])
    .index("by_event_state_metadata_rate_limit", [
      "eventId",
      "state",
      "metadataRateLimitRetryAt",
    ]),

  figmaFileMetrics: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    figmaFileBindingId: v.id("figmaFileBindings"),
    pageCount: v.number(),
    frameCount: v.number(),
    componentCount: v.number(),
    componentSetCount: v.number(),
    styleCount: v.number(),
    nodeCount: v.number(),
    prototypeInteractionCount: v.number(),
    commentCount: v.number(),
    unresolvedCommentCount: v.number(),
    versionCount: v.number(),
    completeness: v.union(v.literal("complete"), v.literal("partial"), v.literal("unknown")),
    capturedAt: v.number(),
    version: v.number(),
  }).index("by_binding", ["figmaFileBindingId"]),

  figmaTeamMetrics: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    health: v.union(
      v.literal("not_connected"),
      v.literal("ready"),
      v.literal("syncing"),
      v.literal("needs_attention"),
    ),
    authorizationCount: v.number(),
    fileCount: v.number(),
    completeFileCount: v.number(),
    incompleteFileCount: v.number(),
    dirtyCount: v.number(),
    webhookActiveCount: v.number(),
    webhookUnavailableCount: v.number(),
    rateLimitedCount: v.number(),
    previewReadyCount: v.number(),
    previewPendingCount: v.number(),
    previewAttentionCount: v.number(),
    selectedPreviewCount: v.number(),
    availablePreviewCount: v.number(),
    pageCount: v.number(),
    frameCount: v.number(),
    componentCount: v.number(),
    componentSetCount: v.number(),
    styleCount: v.number(),
    nodeCount: v.number(),
    prototypeInteractionCount: v.number(),
    commentCount: v.number(),
    unresolvedCommentCount: v.number(),
    versionCount: v.number(),
    completeness: v.union(v.literal("complete"), v.literal("partial"), v.literal("unknown")),
    oldestMetadataCheckAt: v.optional(v.number()),
    lastCaptureAt: v.optional(v.number()),
    lastActivityAt: v.optional(v.number()),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_team", ["teamId"])
    .index("by_event_updated", ["eventId", "updatedAt"]),

  figmaFileSnapshots: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    figmaFileBindingId: v.id("figmaFileBindings"),
    previousSnapshotId: v.optional(v.id("figmaFileSnapshots")),
    reason: v.union(v.literal("baseline"), v.literal("provider_event"), v.literal("manual"), v.literal("reconcile")),
    providerVersionId: v.string(),
    providerLastTouchedAt: v.number(),
    pageCount: v.number(),
    frameCount: v.number(),
    componentCount: v.number(),
    componentSetCount: v.number(),
    styleCount: v.number(),
    nodeCount: v.number(),
    prototypeInteractionCount: v.number(),
    commentCount: v.number(),
    unresolvedCommentCount: v.number(),
    versionCount: v.number(),
    completeness: v.union(v.literal("complete"), v.literal("partial"), v.literal("unknown")),
    artifactId: v.optional(v.id("integrationArtifacts")),
    capturedAt: v.number(),
  })
    .index("by_binding_time", ["figmaFileBindingId", "capturedAt"])
    .index("by_team_time", ["teamId", "capturedAt"]),

  figmaSnapshotActivity: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    figmaFileBindingId: v.id("figmaFileBindings"),
    snapshotId: v.id("figmaFileSnapshots"),
    providerVersionId: v.string(),
    versionCount: v.number(),
    capturedVersionCount: v.number(),
    versionsComplete: v.boolean(),
    commentCount: v.number(),
    capturedCommentCount: v.number(),
    commentsComplete: v.boolean(),
    replyCount: v.number(),
    resolvedThreadCount: v.number(),
    unresolvedThreadCount: v.number(),
    capturedAt: v.number(),
  }).index("by_snapshot", ["snapshotId"]),

  figmaVersionFacts: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    figmaFileBindingId: v.id("figmaFileBindings"),
    snapshotId: v.id("figmaFileSnapshots"),
    providerVersionId: v.string(),
    versionId: v.string(),
    label: v.string(),
    description: v.string(),
    descriptionTruncated: v.boolean(),
    userId: v.string(),
    userHandle: v.string(),
    providerCreatedAt: v.number(),
    displayOrder: v.number(),
  }).index("by_snapshot_order", ["snapshotId", "displayOrder"]),

  figmaCommentFacts: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    figmaFileBindingId: v.id("figmaFileBindings"),
    snapshotId: v.id("figmaFileSnapshots"),
    providerVersionId: v.string(),
    commentId: v.string(),
    parentCommentId: v.optional(v.string()),
    userId: v.string(),
    userHandle: v.string(),
    message: v.string(),
    messageTruncated: v.boolean(),
    providerCreatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
    orderId: v.optional(v.number()),
    reactionCount: v.number(),
    displayOrder: v.number(),
  }).index("by_snapshot_order", ["snapshotId", "displayOrder"]),

  figmaPreviewSets: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    figmaFileBindingId: v.id("figmaFileBindings"),
    snapshotId: v.id("figmaFileSnapshots"),
    providerVersionId: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("ready"),
      v.literal("partial"),
      v.literal("rate_limited"),
      v.literal("failed"),
    ),
    discoveredNodeCount: v.number(),
    selectedNodeCount: v.number(),
    availableCount: v.number(),
    failedCount: v.number(),
    truncated: v.boolean(),
    renderLeaseId: v.optional(v.string()),
    renderLeaseExpiresAt: v.optional(v.number()),
    retryAt: v.optional(v.number()),
    failureCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_snapshot", ["snapshotId"])
    .index("by_binding_time", ["figmaFileBindingId", "createdAt"])
    .index("by_event_state_updated", ["eventId", "state", "updatedAt"])
    .index("by_event_state_lease", ["eventId", "state", "renderLeaseExpiresAt"]),

  figmaNodeFacts: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    figmaFileBindingId: v.id("figmaFileBindings"),
    snapshotId: v.id("figmaFileSnapshots"),
    previewSetId: v.id("figmaPreviewSets"),
    providerVersionId: v.string(),
    pageId: v.string(),
    pageName: v.string(),
    pageOrder: v.number(),
    nodeId: v.string(),
    nodeName: v.string(),
    nodeType: v.string(),
    nodeOrder: v.number(),
    descendantCount: v.number(),
    semanticHash: v.string(),
    sourceWidth: v.optional(v.number()),
    sourceHeight: v.optional(v.number()),
    changeState: v.union(
      v.literal("new"),
      v.literal("changed"),
      v.literal("unchanged"),
      v.literal("unknown"),
    ),
    render: v.union(
      v.object({ state: v.literal("pending") }),
      v.object({
        state: v.literal("available"),
        objectKey: v.string(),
        storageRegion: v.string(),
        storageBucket: v.string(),
        contentType: v.literal("image/png"),
        byteCount: v.number(),
        sha256: v.string(),
        width: v.number(),
        height: v.number(),
      }),
      v.object({ state: v.literal("failed"), failureCode: v.string() }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_preview_page_order", ["previewSetId", "pageOrder", "nodeOrder"])
    .index("by_preview_node", ["previewSetId", "nodeId"])
    .index("by_snapshot_page_order", ["snapshotId", "pageOrder", "nodeOrder"]),

  integrationArtifacts: defineTable({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    provider: v.union(v.literal("github"), v.literal("figma")),
    figmaFileBindingId: v.optional(v.id("figmaFileBindings")),
    resourceKey: v.string(),
    providerVersionId: v.string(),
    objectKey: v.string(),
    storageRegion: v.string(),
    storageBucket: v.string(),
    contentType: v.string(),
    contentEncoding: v.optional(v.string()),
    uncompressedBytes: v.number(),
    storedBytes: v.number(),
    sha256: v.string(),
    state: v.union(v.literal("available"), v.literal("quarantined"), v.literal("deleted")),
    createdAt: v.number(),
  })
    .index("by_figma_binding_time", ["figmaFileBindingId", "createdAt"])
    .index("by_team_provider_time", ["teamId", "provider", "createdAt"])
    .index("by_object_key", ["objectKey"]),

  figmaWebhookDeliveries: defineTable({
    deliveryKey: v.string(),
    webhookId: v.string(),
    fileKey: v.optional(v.string()),
    eventType: v.string(),
    providerAt: v.number(),
    state: v.union(v.literal("accepted"), v.literal("ignored"), v.literal("rejected")),
    reasonCode: v.string(),
    receivedAt: v.number(),
  }).index("by_delivery", ["deliveryKey"]),

  operationsIntelligencePolicyVersions: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("superseded"),
      v.literal("retired"),
    ),
    enabled: v.boolean(),
    triggerSeverities: v.array(operationsHealthSeverity),
    triggerAreas: v.array(operationsHealthArea),
    cooldownMinutes: v.number(),
    maximumBriefsPerLocalDay: v.number(),
    relevanceMinutes: v.number(),
    accountableOwner: v.string(),
    audience: v.literal("operations_dashboard"),
    checksum: v.string(),
    createdByPersonId: v.id("people"),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_event_status", ["eventId", "status"])
    .index("by_event_version", ["eventId", "version"]),

  operationsIntelligenceAutomationStates: defineTable({
    eventId: v.id("events"),
    policyVersionId: v.id("operationsIntelligencePolicyVersions"),
    state: v.union(v.literal("active"), v.literal("disabled"), v.literal("superseded")),
    nextEvaluationAt: v.number(),
    lastEvaluatedAt: v.optional(v.number()),
    lastTriggerAt: v.optional(v.number()),
    lastTriggerFingerprint: v.optional(v.string()),
    cycle: v.number(),
    localBudgetDate: v.string(),
    briefsStartedToday: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_state_next_evaluation", ["state", "nextEvaluationAt"])
    .index("by_event", ["eventId"])
    .index("by_policy", ["policyVersionId"]),

  operationsIntelligenceSignals: defineTable({
    eventId: v.id("events"),
    policyVersionId: v.id("operationsIntelligencePolicyVersions"),
    automationStateId: v.id("operationsIntelligenceAutomationStates"),
    cycle: v.number(),
    triggerFingerprint: v.string(),
    sourceSnapshot: operationsHealthSnapshot,
    sourceChecksum: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("expired"),
    ),
    briefId: v.optional(v.id("operationsIntelligenceBriefs")),
    observedAt: v.number(),
    expiresAt: v.number(),
    settledAt: v.optional(v.number()),
  })
    .index("by_event_observed", ["eventId", "observedAt"])
    .index("by_policy_cycle_fingerprint", [
      "policyVersionId",
      "cycle",
      "triggerFingerprint",
    ]),

  operationsIntelligenceBriefs: defineTable({
    eventId: v.id("events"),
    requestedByPersonId: v.optional(v.id("people")),
    origin: v.union(v.literal("manual"), v.literal("automation")),
    automationPolicyVersionId: v.optional(v.id("operationsIntelligencePolicyVersions")),
    automationSignalId: v.optional(v.id("operationsIntelligenceSignals")),
    relevanceExpiresAt: v.optional(v.number()),
    state: v.union(
      v.literal("pending"),
      v.literal("dispatching"),
      v.literal("accepted"),
      v.literal("succeeded"),
      v.literal("failed"),
    ),
    sourceSnapshot: v.optional(operationsHealthSnapshot),
    sourceChecksum: v.optional(v.string()),
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
});
