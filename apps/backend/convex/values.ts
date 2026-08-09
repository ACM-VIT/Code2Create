import { type Infer, v } from "convex/values";

export const participantClass = v.union(
  v.literal("vit_student"),
  v.literal("external_participant"),
);

export const studyYear = v.union(
  v.literal("first"),
  v.literal("second"),
  v.literal("third"),
  v.literal("fourth"),
  v.literal("fifth_or_later"),
  v.literal("postgraduate"),
  v.literal("not_applicable"),
);

export const memberRole = v.union(v.literal("lead"), v.literal("member"));

export const eventRole = v.union(
  v.literal("supreme"),
  v.literal("board"),
  v.literal("sc"),
  v.literal("jc"),
  v.literal("external_judge"),
);

export const eventPhaseKey = v.union(
  v.literal("introduction"),
  v.literal("ideation"),
  v.literal("build"),
  v.literal("intermediate_update"),
  v.literal("final_update"),
);

export type EventPhaseKey = Infer<typeof eventPhaseKey>;

export const projectCheckpointKey = v.union(
  v.literal("ideation"),
  v.literal("intermediate_update"),
  v.literal("final_update"),
);

export type ProjectCheckpointKey = Infer<typeof projectCheckpointKey>;

export const intakeQuestionPurpose = v.union(
  v.literal("user"),
  v.literal("problem"),
  v.literal("experience"),
  v.literal("event_goal"),
  v.literal("tradeoff"),
  v.literal("risk"),
  v.literal("track_fit"),
);

export type IntakeQuestionPurpose = Infer<typeof intakeQuestionPurpose>;

export const intakeAnswerLength = v.union(
  v.literal("short"),
  v.literal("medium"),
);

export type IntakeAnswerLength = Infer<typeof intakeAnswerLength>;

export const noveltyBand = v.union(
  v.literal("familiar"),
  v.literal("developing"),
  v.literal("distinct"),
);

export const noveltyCorpusStatus = v.union(
  v.literal("draft"),
  v.literal("published"),
  v.literal("superseded"),
  v.literal("retired"),
);

export const noveltyCorpusImportState = v.union(
  v.literal("empty"),
  v.literal("running"),
  v.literal("ready"),
  v.literal("failed"),
);

export const noveltyPreviewState = v.union(
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("unavailable"),
  v.literal("failed"),
  v.literal("stale"),
);

export const scopeType = v.union(
  v.literal("event"),
  v.literal("self"),
  v.literal("person"),
  v.literal("team"),
  v.literal("application"),
  v.literal("round"),
  v.literal("panel"),
  v.literal("review"),
  v.literal("page"),
  v.literal("scorecard"),
  v.literal("attendance_plan"),
  v.literal("attendance_session"),
  v.literal("station"),
  v.literal("incident"),
  v.literal("evidence_checkpoint"),
  v.literal("permission_bundle"),
  v.literal("roster_entry"),
  v.literal("synesthesia_window"),
  v.literal("song_request"),
  v.literal("floor_plan"),
  v.literal("floor_zone"),
  v.literal("support_case"),
  v.literal("rehearsal_run"),
);

export const permissionDelegation = v.object({
  permissionKey: v.string(),
  scopeType,
  scopeId: v.optional(v.string()),
  target: v.union(
    v.object({
      kind: v.literal("exact_person"),
      personId: v.id("people"),
    }),
    v.object({ kind: v.literal("any_event_person") }),
  ),
});

export const supportCaseCategory = v.union(
  v.literal("identity"),
  v.literal("team"),
  v.literal("project_intake"),
  v.literal("track_configuration"),
  v.literal("attendance_credential"),
  v.literal("missing_scan"),
  v.literal("scanner_device"),
  v.literal("table_location"),
  v.literal("integration"),
  v.literal("queue"),
  v.literal("reviewer_device"),
  v.literal("scorecard"),
  v.literal("accessibility"),
  v.literal("safety"),
);

export const supportCaseState = v.union(
  v.literal("open"),
  v.literal("investigating"),
  v.literal("waiting"),
  v.literal("resolved"),
  v.literal("closed"),
);

export const rehearsalRunState = v.union(
  v.literal("draft"),
  v.literal("active"),
  v.literal("completed"),
  v.literal("cancelled"),
);

export const rehearsalScenarioState = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("passed"),
  v.literal("failed"),
  v.literal("blocked"),
);

export const rehearsalWorkstream = v.union(
  v.literal("auth_access"),
  v.literal("intake_admissions"),
  v.literal("communications"),
  v.literal("attendance"),
  v.literal("floor"),
  v.literal("reviewer_app"),
  v.literal("review_operations"),
  v.literal("integrations"),
  v.literal("reliability"),
  v.literal("synesthesia"),
  v.literal("support"),
);

export type RehearsalRunState = Infer<typeof rehearsalRunState>;
export type RehearsalScenarioState = Infer<typeof rehearsalScenarioState>;
export type RehearsalWorkstream = Infer<typeof rehearsalWorkstream>;

export const synesthesiaWindowKind = v.union(
  v.literal("arrival"),
  v.literal("working_session"),
  v.literal("late_night"),
  v.literal("morning_reset"),
  v.literal("judging"),
  v.literal("closing"),
  v.literal("custom"),
);

export const synesthesiaWindowStatus = v.union(
  v.literal("draft"),
  v.literal("published"),
  v.literal("closed"),
);

export const songRequestState = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("queued"),
  v.literal("playing"),
  v.literal("played"),
  v.literal("skipped"),
  v.literal("rejected"),
  v.literal("hidden"),
);

export const songQueueMode = v.union(
  v.literal("normal"),
  v.literal("pinned"),
  v.literal("deferred"),
);

export const permissionBundleScopeSource = v.union(
  v.literal("event"),
  v.literal("target"),
  v.literal("binding"),
);

export const permissionBundleEntry = v.object({
  permissionKey: v.string(),
  scopeType,
  scopeSource: permissionBundleScopeSource,
  bindingKey: v.optional(v.string()),
  validityRule: v.literal("bundle"),
});

export const teamStatus = v.union(
  v.literal("forming"),
  v.literal("profile_in_progress"),
  v.literal("submitted"),
  v.literal("admitted"),
  v.literal("confirmed"),
  v.literal("checked_in"),
  v.literal("active"),
  v.literal("completed"),
  v.literal("withdrawn"),
  v.literal("disqualified"),
);

export const reviewEvaluationState = v.union(v.literal("complete"), v.literal("void"));

export const roundExportState = v.union(
  v.literal("generating"),
  v.literal("uploaded"),
  v.literal("verified"),
  v.literal("failed"),
  v.literal("superseded"),
);

export const scorecardCorrectionKind = v.union(v.literal("correction"), v.literal("void"));

export const scorecardCorrectionCategory = v.union(
  v.literal("reviewer_error"),
  v.literal("technical_error"),
  v.literal("wrong_team"),
  v.literal("duplicate_review"),
  v.literal("confirmed_conflict"),
  v.literal("judge_ineligible"),
  v.literal("other"),
);

export const scorecardCorrectionState = v.union(
  v.literal("requested"),
  v.literal("open"),
  v.literal("rejected"),
  v.literal("closed"),
);

export const applicationState = v.union(
  v.literal("submitted"),
  v.literal("under_review"),
  v.literal("needs_information"),
  v.literal("accepted"),
  v.literal("waitlisted"),
  v.literal("declined"),
  v.literal("offer_sent"),
  v.literal("confirmed"),
  v.literal("offer_expired"),
  v.literal("withdrawn"),
);

export const admissionDecision = v.union(
  v.literal("accept"),
  v.literal("waitlist"),
  v.literal("decline"),
  v.literal("needs_information"),
);

export const admissionReviewAssignmentState = v.union(
  v.literal("active"),
  v.literal("completed"),
  v.literal("cancelled"),
);

export const criterionAssessment = v.union(
  v.literal("meets"),
  v.literal("partly_meets"),
  v.literal("not_yet_clear"),
);

export const admissionExperienceBand = v.union(
  v.literal("first_year"),
  v.literal("early_year"),
  v.literal("later_year"),
  v.literal("postgraduate_or_professional"),
  v.literal("mixed_or_external"),
);

export const admissionOfferState = v.union(
  v.literal("offered"),
  v.literal("confirmed"),
  v.literal("declined"),
  v.literal("expired"),
  v.literal("revoked"),
);

export const admissionInformationRequestState = v.union(
  v.literal("open"),
  v.literal("answered"),
  v.literal("superseded"),
);

export const admissionRecommendationState = v.union(
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
);

export const admissionAiDisposition = v.union(
  v.literal("used"),
  v.literal("cleared"),
  v.literal("overridden"),
  v.literal("stale"),
  v.literal("unavailable"),
);

export const repositoryKind = v.union(
  v.literal("full_product"),
  v.literal("frontend"),
  v.literal("backend_api"),
  v.literal("mobile_app"),
  v.literal("desktop_app"),
  v.literal("ai_ml"),
  v.literal("data_pipeline"),
  v.literal("hardware_firmware"),
  v.literal("infrastructure"),
  v.literal("library_sdk"),
  v.literal("docs_research"),
  v.literal("other"),
);

export const attendanceCredentialKind = v.union(
  v.literal("vit_id_barcode"),
  v.literal("badge_qr"),
  v.literal("portal_qr"),
  v.literal("manual"),
);

export const attendanceExportField = v.union(
  v.literal("participant_reference"),
  v.literal("full_name"),
  v.literal("email"),
  v.literal("participant_class"),
  v.literal("institution"),
  v.literal("year_of_study"),
  v.literal("vit_registration_number"),
  v.literal("expectation"),
  v.literal("state"),
  v.literal("result"),
  v.literal("confirmed_at"),
  v.literal("present_duration_minutes"),
  v.literal("late"),
  v.literal("session_name"),
  v.literal("session_starts_at"),
  v.literal("session_ends_at"),
);

export const barcodeSymbology = v.union(
  v.literal("aztec"),
  v.literal("ean13"),
  v.literal("ean8"),
  v.literal("qr"),
  v.literal("pdf417"),
  v.literal("upc_e"),
  v.literal("datamatrix"),
  v.literal("code39"),
  v.literal("code93"),
  v.literal("itf14"),
  v.literal("codabar"),
  v.literal("code128"),
  v.literal("upc_a"),
);

export const attendanceScanTransition = v.union(
  v.literal("venue_entry"),
  v.literal("venue_exit"),
  v.literal("session_confirm"),
  v.literal("zone_entry"),
  v.literal("zone_exit"),
);

export const venueCheckInStatus = v.union(
  v.literal("checked_in"),
  v.literal("reversed"),
);

export const venueIdentityCheckMethod = v.union(
  v.literal("vit_id"),
  v.literal("external_photo_id"),
  v.literal("approved_exception"),
);

export const attendanceManualTransition = v.union(
  v.literal("session_confirm"),
  v.literal("zone_entry"),
  v.literal("zone_exit"),
);

export const venuePresenceState = v.union(
  v.literal("not_arrived"),
  v.literal("inside"),
  v.literal("temporarily_out"),
  v.literal("departed"),
  v.literal("unknown"),
);

export const rollCallPresenceState = v.union(
  v.literal("not_arrived"),
  v.literal("inside"),
  v.literal("temporarily_out"),
  v.literal("departed"),
  v.literal("elsewhere"),
  v.literal("unknown"),
);

export const sessionPresenceState = v.union(
  v.literal("not_expected"),
  v.literal("confirmation_due"),
  v.literal("present"),
  v.literal("temporarily_out"),
  v.literal("complete"),
  v.literal("excused"),
  v.literal("needs_review"),
);

export const reviewRoundStatus = v.union(
  v.literal("draft"),
  v.literal("published"),
  v.literal("open"),
  v.literal("closing"),
  v.literal("closed"),
);

export const eventStatus = v.union(
  v.literal("draft"),
  v.literal("registration_open"),
  v.literal("registration_closed"),
  v.literal("live"),
  v.literal("complete"),
);

export const reviewPanelStatus = v.union(
  v.literal("draft"),
  v.literal("ready"),
  v.literal("needs_reviewer"),
  v.literal("paused"),
  v.literal("closed"),
);

export const teamRoundState = v.union(
  v.literal("unassigned"),
  v.literal("queued"),
  v.literal("called"),
  v.literal("at_table"),
  v.literal("in_review"),
  v.literal("completed"),
  v.literal("held"),
  v.literal("missed"),
  v.literal("withdrawn"),
);

export const reviewSessionStatus = v.union(
  v.literal("awaiting_presence"),
  v.literal("active"),
  v.literal("overdue"),
  v.literal("completed"),
  v.literal("cancelled"),
);

export const scorecardStatus = v.union(
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("correction_open"),
  v.literal("void"),
);

export const integrationProviderHealth = v.union(
  v.literal("ready"),
  v.literal("syncing"),
  v.literal("needs_attention"),
  v.literal("not_connected"),
);

export const githubRepositorySyncState = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("ready"),
  v.literal("rate_limited"),
  v.literal("error"),
);

export const githubRepositoryTopicState = v.union(
  v.literal("present"),
  v.literal("missing"),
  v.literal("unknown"),
);

export const githubRepositoryCoverage = v.union(
  v.literal("complete"),
  v.literal("partial"),
  v.literal("unknown"),
);

export const figmaPreviewState = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("ready"),
  v.literal("partial"),
  v.literal("rate_limited"),
  v.literal("failed"),
);

export const floorPlanStatus = v.union(
  v.literal("draft"),
  v.literal("published"),
  v.literal("superseded"),
  v.literal("retired"),
);

export const floorMappingState = v.union(
  v.literal("setup"),
  v.literal("open"),
  v.literal("frozen"),
);

/** The two states in which a published plan is visible to floor staff at all. */
export const floorActiveMappingState = v.union(v.literal("open"), v.literal("frozen"));

export const floorMappingMode = v.union(v.literal("map"), v.literal("override"));

export const floorTeamQrTokenState = v.union(
  v.literal("active"),
  v.literal("used"),
  v.literal("superseded"),
  v.literal("expired"),
);

export const floorMappingClaimState = v.union(
  v.literal("active"),
  v.literal("completed"),
  v.literal("expired"),
);

export const floorLocationState = v.union(v.literal("active"), v.literal("superseded"));

export const floorLocationMethod = v.union(
  v.literal("team_qr_scan"),
  v.literal("override"),
);

/**
 * The nine parts of a hall zone that an operator can say out loud. A team's
 * recorded position is a point in the zone rectangle; this is the part of that
 * rectangle the point falls in, and it is the only granularity anybody is
 * asked to believe.
 */
export const floorArea = v.union(
  v.literal("north_west"),
  v.literal("north"),
  v.literal("north_east"),
  v.literal("west"),
  v.literal("centre"),
  v.literal("east"),
  v.literal("south_west"),
  v.literal("south"),
  v.literal("south_east"),
);

export type FloorArea = Infer<typeof floorArea>;
export type FloorMappingState = Infer<typeof floorMappingState>;

export const rosterEntryStatus = v.union(
  v.literal("pending"),
  v.literal("claimed"),
  v.literal("revoked"),
  v.literal("superseded"),
  v.literal("expired"),
);

export const attentionSeverity = v.union(
  v.literal("critical"),
  v.literal("attention"),
  v.literal("watch"),
);

/**
 * One key per deterministic detector. The key is half of an item's identity;
 * the other half is the subject it names, never anything that varies with the
 * reading (a count, an age, a timestamp).
 */
export const attentionDetectorKey = v.union(
  v.literal("panel_seat_empty"),
  v.literal("seat_at_risk"),
  v.literal("review_overdue"),
  v.literal("review_presence_incomplete"),
  v.literal("team_below_minimum"),
  v.literal("team_held"),
  v.literal("team_call_overdue"),
  v.literal("team_waiting_long"),
  v.literal("round_finish_forecast"),
  v.literal("panel_bottleneck"),
  v.literal("scorecard_outstanding"),
);

export const attentionSubjectType = v.union(
  v.literal("round"),
  v.literal("panel"),
  v.literal("panel_member"),
  v.literal("team"),
  v.literal("review"),
);

/**
 * `resolved` is written by the sweep when the condition clears, which is the
 * memory a recomputed list cannot have. `dismissed` is a human saying this is
 * not a problem; the sweep keeps updating it but the board stops leading with
 * it.
 */
export const attentionItemState = v.union(
  v.literal("open"),
  v.literal("acknowledged"),
  v.literal("resolved"),
  v.literal("dismissed"),
);

/** The scope kinds an attention proposal or visibility rule can resolve. */
export const attentionScopeType = v.union(
  v.literal("round"),
  v.literal("panel"),
  v.literal("review"),
  v.literal("team"),
  v.literal("person"),
);

/**
 * The closed set of commands an attention item may propose, with the exact
 * arguments the ordinary mutation takes and the target version that makes a
 * stale proposal fail like any stale operator command. `eventSlug` and
 * `clientOperationId` are absent because the confirming client owns both.
 */
export const attentionCommand = v.union(
  v.object({
    name: v.literal("reviewSubstitutions.startPageChain"),
    missingPanelMemberId: v.id("reviewPanelMembers"),
    expectedPanelVersion: v.number(),
    reason: v.string(),
  }),
  v.object({
    name: v.literal("reviewSubstitutions.markNoShow"),
    panelMemberId: v.id("reviewPanelMembers"),
    expectedPanelVersion: v.number(),
    expectedClockInVersion: v.number(),
    reason: v.string(),
  }),
  v.object({
    name: v.literal("reviewOperations.extendReview"),
    reviewSessionId: v.id("reviewSessions"),
    expectedVersion: v.number(),
    reason: v.string(),
  }),
  v.object({
    name: v.literal("reviewExceptions.resumeTeam"),
    teamRoundStateId: v.id("teamRoundStates"),
    expectedVersion: v.number(),
    reason: v.string(),
  }),
  v.object({
    name: v.literal("reviewExceptions.markMissed"),
    teamRoundStateId: v.id("teamRoundStates"),
    expectedVersion: v.number(),
    reason: v.string(),
  }),
  v.object({
    name: v.literal("reviewExceptions.moveQueuedTeam"),
    teamRoundStateId: v.id("teamRoundStates"),
    targetPanelId: v.id("reviewPanels"),
    expectedVersion: v.number(),
    reason: v.string(),
  }),
);

export const attentionProposal = v.object({
  permissionKey: v.string(),
  scopeType: attentionScopeType,
  scopeId: v.string(),
  expiresAt: v.number(),
  command: attentionCommand,
});

export type AttentionSeverity = Infer<typeof attentionSeverity>;
export type StoredAttentionCommand = Infer<typeof attentionCommand>;
export type AttentionDetectorKey = Infer<typeof attentionDetectorKey>;
export type AttentionSubjectType = Infer<typeof attentionSubjectType>;
export type AttentionItemState = Infer<typeof attentionItemState>;
export type AttentionScopeType = Infer<typeof attentionScopeType>;
