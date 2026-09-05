import { type Infer, v } from "convex/values";

export const participantClass = v.union(
  v.literal("vit_student"),
  v.literal("external_participant"),
);
export type ParticipantClass = Infer<typeof participantClass>;

export const participantGender = v.union(v.literal("male"), v.literal("female"),
);
export type ParticipantGender = Infer<typeof participantGender>;

export const vitResidenceType = v.union(v.literal("day_scholar"), v.literal("hosteller"),
);
export type VitResidenceType = Infer<typeof vitResidenceType>;

export const participantEligibilityStatus = v.union(
  v.literal("pending"),
  v.literal("eligible"),
  v.literal("rejected"),
  v.literal("suspended"),
);
export type ParticipantEligibilityStatus = Infer<typeof participantEligibilityStatus>;

export const participantOnboardingStatus = v.union(
  v.literal("profile_required"),
  v.literal("github_required"),
  v.literal("team_required"),
  v.literal("project_required"),
  v.literal("ready_to_submit"),
  v.literal("submitted"),
  v.literal("selected"),
  v.literal("offer_pending"),
  v.literal("accepted"),
);

export const participantPhoneVerificationStatus = v.union(
  v.literal("queued"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("verified"),
  v.literal("send_failed"),
  v.literal("locked"),
  v.literal("superseded"),
);
export type ParticipantPhoneVerificationStatus = Infer<typeof participantPhoneVerificationStatus>;

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

export const participantAssistantPhase = v.union(
  v.literal("idea_submission"),
  v.literal("in_event"),
);

export type ParticipantAssistantPhase = Infer<typeof participantAssistantPhase>;

export const participantAssistantRequestState = v.union(
  v.literal("scheduled"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);

export type ParticipantAssistantRequestState = Infer<typeof participantAssistantRequestState>;

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
);

export type IntakeQuestionPurpose = Infer<typeof intakeQuestionPurpose>;

export const intakeAnswerLength = v.union(v.literal("short"), v.literal("medium"),
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
  v.literal("attendance_credential"),
  v.literal("missing_scan"),
  v.literal("scanner_device"),
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

export const permissionGrantStatus = v.union(
  v.literal("scheduled"),
  v.literal("active"),
  v.literal("revoked"),
  v.literal("expired"),
  v.literal("superseded"),
);

export const permissionGrantSourceType = v.union(
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
export type TeamStatus = Infer<typeof teamStatus>;

export const projectDraftStage = v.union(
  v.literal("opening"),
  v.literal("follow_up"),
  v.literal("additional_information"),
  v.literal("review"),
  v.literal("submitted"),
);

export const reviewEvaluationState = v.union(v.literal("complete"), v.literal("void"),
);

export const roundExportState = v.union(
  v.literal("generating"),
  v.literal("uploaded"),
  v.literal("verified"),
  v.literal("failed"),
  v.literal("superseded"),
);

export const scorecardCorrectionKind = v.union(v.literal("correction"), v.literal("void"),
);

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
);

export const terminalAdmissionDecision = v.union(
  v.literal("accept"),
  v.literal("waitlist"),
  v.literal("decline"),
);

export const admissionDecisionStage = v.union(
  v.literal("unrecorded"),
  v.literal("recorded"),
  v.literal("released"),
);

export const participantEmailTemplateKey = v.union(
  v.literal("accept"),
  v.literal("waitlist"),
  v.literal("decline"),
  v.literal("offer"),
  v.literal("offer_confirmed"),
  v.literal("offer_declined"),
  v.literal("offer_expired"),
  v.literal("external_event_pass"),
);

export const participantEmailProvider = v.union(
  v.literal("cloudflare_email"),
  v.literal("aws_ses"),
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
  v.literal("external_pass"),
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

export const attendanceSessionKind = v.union(
  v.literal("hacking"),
  v.literal("briefing"),
  v.literal("review_preparation"),
  v.literal("overnight_access"),
  v.literal("workshop"),
  v.literal("other"),
);

export const attendanceSessionRequirement = v.union(
  v.literal("required"),
  v.literal("optional"),
  v.literal("information_only"),
);
export type AttendanceSessionRequirement = Infer<typeof attendanceSessionRequirement>;

export const attendanceSessionStatus = v.union(
  v.literal("scheduled"),
  v.literal("preparing"),
  v.literal("ready"),
  v.literal("open"),
  v.literal("closing"),
  v.literal("closed"),
  v.literal("cancelled"),
);
export type AttendanceSessionStatus = Infer<typeof attendanceSessionStatus>;

export const attendanceExpectationBuildState = v.union(
  v.literal("not_started"),
  v.literal("running"),
  v.literal("complete"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const attendanceSessionJobKind = v.union(
  v.literal("build_expectations"),
  v.literal("finalize_results"),
  v.literal("cancel_results"),
);

export const attendanceSessionJobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("complete"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const attendanceStationStatus = v.union(
  v.literal("inactive"),
  v.literal("active"),
  v.literal("disabled"),
);
export type AttendanceStationStatus = Infer<typeof attendanceStationStatus>;

export const attendanceScanTransition = v.union(
  v.literal("venue_entry"),
  v.literal("venue_exit"),
  v.literal("session_confirm"),
  v.literal("zone_entry"),
  v.literal("zone_exit"),
);

export const attendancePresenceSourceKind = v.union(
  v.literal("scanner"),
  v.literal("staff_reconciliation"),
  v.literal("manual_import"),
);

export const attendancePresenceTransition = v.union(
  v.literal("venue_entry"),
  v.literal("venue_exit"),
  v.literal("session_confirm"),
  v.literal("zone_entry"),
  v.literal("zone_exit"),
  v.literal("manual_reconcile"),
);

export const attendancePresenceOutcome = v.union(
  v.literal("accepted"),
  v.literal("duplicate"),
  v.literal("rejected"),
  v.literal("needs_review"),
  v.literal("reconciled"),
);

export const attendanceCorrectionKind = v.union(
  v.literal("presence_confirmed"),
  v.literal("temporary_exit"),
  v.literal("marked_needs_review"),
  v.literal("voided_transition"),
);

export const attendanceStationMode = v.union(
  v.literal("venue_entry"),
  v.literal("venue_exit"),
  v.literal("session_confirm"),
  v.literal("zone_entry"),
  v.literal("zone_exit"),
  v.literal("roving"),
);

export type AttendanceStationMode = Infer<typeof attendanceStationMode>;

export const attendanceScannerCredentialKind = v.union(
  v.literal("vit_id_barcode"),
  v.literal("badge_qr"),
  v.literal("external_pass"),
);

export type AttendanceScannerCredentialKind = Infer<typeof attendanceScannerCredentialKind>;

export const venueCheckInStatus = v.union(v.literal("checked_in"), v.literal("reversed"),
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
export type VenuePresenceState = Infer<typeof venuePresenceState>;

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

export const attendanceSessionExpectation = v.union(
  v.literal("required"),
  v.literal("optional"),
  v.literal("not_expected"),
  v.literal("excused"),
);

export const attendanceSessionResult = v.union(
  v.literal("attended"),
  v.literal("absent"),
  v.literal("partial"),
  v.literal("excused"),
  v.literal("not_expected"),
  v.literal("needs_review"),
);

export const attendanceExportSnapshotRow = v.object({
  participantReference: v.optional(v.string()),
  fullName: v.optional(v.string()),
  email: v.optional(v.string()),
  participantClass: v.optional(participantClass),
  institution: v.optional(v.string()),
  yearOfStudy: v.optional(studyYear),
  vitRegistrationNumber: v.optional(v.string()),
  expectation: v.optional(attendanceSessionExpectation),
  state: v.optional(sessionPresenceState),
  result: v.optional(attendanceSessionResult),
  confirmedAt: v.optional(v.number()),
  presentDurationMs: v.optional(v.number()),
  late: v.optional(v.boolean()),
  sessionName: v.optional(v.string()),
  sessionStartsAt: v.optional(v.number()),
  sessionEndsAt: v.optional(v.number()),
});

export type AttendanceExportSnapshotRow = Infer<typeof attendanceExportSnapshotRow>;

export const reviewRoundStatus = v.union(
  v.literal("draft"),
  v.literal("published"),
  v.literal("open"),
  v.literal("closing"),
  v.literal("closed"),
);
export type ReviewRoundStatus = Infer<typeof reviewRoundStatus>;

export const eventStatus = v.union(
  v.literal("draft"),
  v.literal("registration_open"),
  v.literal("registration_closed"),
  v.literal("live"),
  v.literal("complete"),
);
export type EventStatus = Infer<typeof eventStatus>;

export const reviewPanelStatus = v.union(
  v.literal("draft"),
  v.literal("ready"),
  v.literal("needs_reviewer"),
  v.literal("paused"),
  v.literal("closed"),
);
export type ReviewPanelStatus = Infer<typeof reviewPanelStatus>;

export const reviewerClockInStatus = v.union(
  v.literal("present"),
  v.literal("temporarily_unavailable"),
  v.literal("clocked_out"),
  v.literal("no_show"),
);

export const reviewerClockInViewStatus = v.union(
  v.literal("not_clocked_in"),
  v.literal("present"),
  v.literal("temporarily_unavailable"),
  v.literal("clocked_out"),
  v.literal("no_show"),
);

export const reviewRoundReserveStatus = v.union(
  v.literal("available"),
  v.literal("paged"),
  v.literal("assigned"),
  v.literal("removed"),
);

export const reviewerPageChainState = v.union(
  v.literal("active"),
  v.literal("filled"),
  v.literal("exhausted"),
  v.literal("cancelled"),
);

export const reviewerPageState = v.union(
  v.literal("sent"),
  v.literal("opened"),
  v.literal("accepted"),
  v.literal("declined"),
  v.literal("expired"),
  v.literal("cancelled"),
);

export const reviewerPushDeliveryState = v.union(
  v.literal("unavailable"),
  v.literal("pending"),
  v.literal("sending"),
  v.literal("retry_wait"),
  v.literal("provider_accepted"),
  v.literal("failed"),
  v.literal("superseded"),
);

export const outboundCallDeliveryState = v.union(
  v.literal("unavailable"),
  v.literal("pending"),
  v.literal("sending"),
  v.literal("retry_wait"),
  v.literal("provider_accepted"),
  v.literal("queued"),
  v.literal("initiated"),
  v.literal("ringing"),
  v.literal("answered"),
  v.literal("completed"),
  v.literal("busy"),
  v.literal("no_answer"),
  v.literal("cancelled"),
  v.literal("failed"),
  v.literal("ambiguous"),
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

export const reviewStaffingPolicy = v.object({
  seniorSeats: v.number(),
  juniorSeats: v.number(),
  allowSeniorLeadFallback: v.boolean(),
  automaticReplacement: v.boolean(),
  juniorRotationReviews: v.number(),
  reviewerArrivalSeconds: v.number(),
  assignmentReminderSeconds: v.number(),
  assignmentReminderCalls: v.boolean(),
});

export const reviewSessionStatus = v.union(
  v.literal("awaiting_presence"),
  v.literal("active"),
  v.literal("scoring"),
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

export const integrationMetricCompleteness = v.union(
  v.literal("complete"),
  v.literal("partial"),
  v.literal("unknown"),
);

export const githubInstallationState = v.union(
  v.literal("active"),
  v.literal("suspended"),
  v.literal("revoked"),
);

export const githubRepositoryBindingState = v.union(
  v.literal("setup"),
  v.literal("active"),
  v.literal("inaccessible"),
  v.literal("revoked"),
  v.literal("archived"),
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

export const figmaFileSyncState = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("ready"),
  v.literal("rate_limited"),
  v.literal("error"),
);

export const figmaCredentialState = v.union(
  v.literal("active"),
  v.literal("revoked"),
  v.literal("error"),
);

export const figmaCredentialConnectionState = v.union(v.literal("active"), v.literal("revoked"),
);

export const figmaFileBindingState = v.union(
  v.literal("active"),
  v.literal("inaccessible"),
  v.literal("revoked"),
  v.literal("archived"),
);

export const figmaWebhookState = v.union(
  v.literal("pending"),
  v.literal("active"),
  v.literal("unavailable"),
  v.literal("error"),
);

export const figmaPreviewState = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("ready"),
  v.literal("partial"),
  v.literal("rate_limited"),
  v.literal("failed"),
);

export const rosterEntryStatus = v.union(
  v.literal("pending"),
  v.literal("claimed"),
  v.literal("revoked"),
  v.literal("superseded"),
  v.literal("expired"),
);

export const teamRosterEntryStatus = v.union(
  v.literal("pending"),
  v.literal("waiting_for_lead"),
  v.literal("identity_conflict"),
  v.literal("choice_required"),
  v.literal("claimed"),
  v.literal("revoked"),
  v.literal("superseded"),
);
export type TeamRosterEntryStatus = Infer<typeof teamRosterEntryStatus>;

export const attentionSeverity = v.union(
  v.literal("critical"),
  v.literal("attention"),
  v.literal("watch"),
);

/** Attention identity combines a stable detector key with its subject, never a reading. */
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

/** The sweep resolves cleared conditions; dismissal hides an item while updates continue. */
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

/** Closed proposal commands mirror ordinary mutations and include stale-write versions. */
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

export const youtubeVideo = v.object({
  videoId: v.string(),
  title: v.string(),
  channelTitle: v.string(),
  durationSeconds: v.number(),
  thumbnailUrl: v.optional(v.string()),
  ageRestricted: v.boolean(),
  embeddable: v.boolean(),
});
export type YouTubeVideo = Infer<typeof youtubeVideo>;

export const reviewEvidenceCheckpointFields = {
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
      preview: v.optional(v.object({
        state: v.string(), discoveredNodes: v.number(), selectedNodes: v.number(), truncated: v.boolean(),
        renders: v.array(v.object({ factId: v.id("figmaNodeFacts"), sha256: v.string() })),
      })),
      fileName: v.string(),
      fileUrl: v.string(),
      role: v.string(),
      editorType: v.string(),
      stateAtCapture: v.string(),
    }),
  ),
  expectedResourceCount: v.number(),
  capturedResourceCount: v.number(),
  completeness: v.union(
    v.literal("complete"),
    v.literal("partial"),
    v.literal("missing"),
  ),
  checksum: v.string(),
  createdByPersonId: v.id("people"),
  createdAt: v.number(),
};

export const reviewQuestionPolicy = v.object({
  enabled: v.boolean(),
  visualAnalysis: v.boolean(),
  refreshSeconds: v.number(),
  maximumQuestions: v.number(),
  parallelAnalyses: v.number(),
  batchCharacters: v.number(),
  maximumAttempts: v.number(),
  preparationTimeoutSeconds: v.number(),
  model: v.string(),
  instructions: v.string(),
});
export const reviewQuestionImage = v.object({ factId: v.string(), sha256: v.string() });
export const reviewQuestionSource = v.object({
  image: v.optional(reviewQuestionImage),
  id: v.string(),
  kind: v.union(
    v.literal("project"),
    v.literal("checkpoint"),
    v.literal("github"),
    v.literal("figma"),
  ),
  title: v.string(),
  url: v.optional(v.string()),
  text: v.string(),
  coverage: v.union(
    v.literal("captured"),
    v.literal("partial"),
    v.literal("unavailable"),
  ),
});
export const reviewSuggestedQuestion = v.object({
  question: v.string(),
  reason: v.string(),
  criterionKey: v.string(),
  sourceIds: v.array(v.string()),
});

export const reviewEvidenceFinding = v.object({
  category: v.union(
    ...(
      [
        "research",
        "architecture",
        "implementation",
        "testing",
        "design",
        "reproducibility",
        "progress",
        "uncertainty",
      ] as const
    ).map((value) => v.literal(value)),
  ),
  observation: v.string(),
  followUp: v.string(),
  sourceIds: v.array(v.string()),
});
export const reviewEvidenceAnalysis = v.object({
  examinedSourceIds: v.array(v.string()),
  summary: v.string(),
  findings: v.array(reviewEvidenceFinding),
});
export const reviewEvidenceCoverage = v.object({
  discovered: v.number(),
  captured: v.number(),
  excluded: v.number(),
  unavailable: v.number(),
  chunks: v.number(),
  analysedChunks: v.number(),
  cachedBatches: v.number(),
});
