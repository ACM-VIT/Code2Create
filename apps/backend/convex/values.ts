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

export const attendanceStationMode = v.union(
  v.literal("venue_entry"),
  v.literal("venue_exit"),
  v.literal("session_confirm"),
  v.literal("zone_entry"),
  v.literal("zone_exit"),
  v.literal("roving"),
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
