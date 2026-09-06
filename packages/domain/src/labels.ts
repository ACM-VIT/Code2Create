/** Exhaustive user-facing labels for stored state keys. */

import type {
  ApplicationDecision,
  ParticipantGender,
  ParticipantClass,
  RepositoryKind,
  StudyYear,
  VitResidenceType,
} from "./index.ts";

export type TeamRoundState =
  | "unassigned"
  | "queued"
  | "called"
  | "at_table"
  | "in_review"
  | "completed"
  | "held"
  | "missed"
  | "withdrawn"
  | "skipped";

export const teamRoundStateOperatorLabels: Record<TeamRoundState, string> = {
  unassigned: "Waiting for the desk",
  queued: "In queue",
  called: "Panel on the way",
  at_table: "Panel with team",
  in_review: "In review",
  completed: "Review complete",
  held: "On hold",
  missed: "Missed the call",
  withdrawn: "Withdrawn",
  skipped: "Review skipped",
};

export const teamRoundStateParticipantLabels: Record<TeamRoundState, string> = {
  unassigned: "Waiting for the review desk",
  queued: "In queue",
  called: "Reviewers on the way",
  at_table: "Reviewers arrived",
  in_review: "Review in progress",
  completed: "Complete",
  held: "On hold",
  missed: "Missed call",
  withdrawn: "Withdrawn",
  skipped: "Review skipped",
};

export type ReviewSessionStatus =
  "awaiting_presence" | "active" | "scoring" | "completed"
  | "cancelled";

export const reviewSessionStatusLabels: Record<ReviewSessionStatus, string> = {
  awaiting_presence: "Waiting for reviewers to scan in",
  active: "Under way",
  scoring: "Discussion finished · entering scores",
  completed: "Complete",
  cancelled: "Cancelled",
};

export type ReviewRoundStatus = "draft" | "published" | "open" | "closing" | "closed";

export const reviewRoundStatusLabels: Record<ReviewRoundStatus, string> = {
  draft: "Draft",
  published: "Published, not open",
  open: "Open",
  closing: "Closing",
  closed: "Closed",
};

export type ReviewerClockInViewStatus =
  | "not_clocked_in"
  | "present"
  | "temporarily_unavailable"
  | "clocked_out"
  | "no_show";

export const reviewerClockInStatusLabels: Record<ReviewerClockInViewStatus, string> = {
  not_clocked_in: "Not clocked in",
  present: "Present",
  temporarily_unavailable: "Temporarily unavailable",
  clocked_out: "Clocked out",
  no_show: "Marked no-show",
};

export type ReviewRoundReserveStatus = "available" | "paged" | "assigned" | "removed";

export const reviewRoundReserveStatusLabels: Record<ReviewRoundReserveStatus, string> = {
  available: "Available",
  paged: "Page sent",
  assigned: "Assigned",
  removed: "Removed",
};

export type ReviewerPageChainState = "active" | "filled" | "exhausted" | "cancelled";

export const reviewerPageChainStateLabels: Record<ReviewerPageChainState, string> = {
  active: "Paging reserves",
  filled: "Seat filled",
  exhausted: "No compatible reserve answered",
  cancelled: "Cancelled",
};

export type ReviewerPageState =
  "sent"
  | "opened"
  | "accepted"
  | "declined"
  | "expired"
  | "cancelled";

export const reviewerPageStateLabels: Record<ReviewerPageState, string> = {
  sent: "sent",
  opened: "opened",
  accepted: "accepted",
  declined: "declined",
  expired: "expired",
  cancelled: "cancelled",
};

export type ReviewerPushDeliveryState =
  | "unavailable"
  | "pending"
  | "sending"
  | "retry_wait"
  | "provider_accepted"
  | "failed"
  | "superseded";

export const reviewerPushDeliveryStateLabels: Record<ReviewerPushDeliveryState, string> = {
  unavailable: "Notification unavailable",
  pending: "Notification queued",
  sending: "Sending notification",
  retry_wait: "Notification waiting to retry",
  provider_accepted: "Notification accepted for delivery",
  failed: "Notification failed",
  superseded: "Notification no longer needed",
};

type OutboundCallDeliveryState =
  | "unavailable"
  | "pending"
  | "sending"
  | "retry_wait"
  | "provider_accepted"
  | "queued"
  | "initiated"
  | "ringing"
  | "answered"
  | "completed"
  | "busy"
  | "no_answer"
  | "cancelled"
  | "failed"
  | "ambiguous";

export const outboundCallDeliveryStateLabels: Record<OutboundCallDeliveryState, string> = {
  unavailable: "Phone call unavailable",
  pending: "Phone call queued",
  sending: "Starting phone call",
  retry_wait: "Phone call waiting to retry",
  provider_accepted: "Phone call accepted",
  queued: "Phone call queued",
  initiated: "Phone call started",
  ringing: "Phone ringing",
  answered: "Phone call answered",
  completed: "Phone call completed",
  busy: "Phone was busy",
  no_answer: "Phone was not answered",
  cancelled: "Phone call cancelled",
  failed: "Phone call failed",
  ambiguous: "Phone call outcome unknown",
};

export type ScorecardStatus = "draft" | "submitted" | "correction_open" | "void";

export const scorecardStatusLabels: Record<ScorecardStatus, string> = {
  draft: "Not submitted",
  submitted: "Submitted",
  correction_open: "Correction open",
  void: "Voided",
};

export type TeamStatus =
  | "forming"
  | "profile_in_progress"
  | "submitted"
  | "admitted"
  | "confirmed"
  | "checked_in"
  | "active"
  | "completed"
  | "withdrawn"
  | "disqualified";

export const teamStatusLabels: Record<TeamStatus, string> = {
  forming: "Forming",
  profile_in_progress: "Filling in profiles",
  submitted: "Application submitted",
  admitted: "Offered a place",
  confirmed: "Place confirmed",
  checked_in: "Checked in",
  active: "Building",
  completed: "Finished",
  withdrawn: "Withdrawn",
  disqualified: "Disqualified",
};

export type ApplicationState =
  | "submitted"
  | "under_review"
  | "accepted"
  | "waitlisted"
  | "declined"
  | "offer_sent"
  | "confirmed"
  | "offer_expired"
  | "withdrawn";

export const applicationStateLabels: Record<ApplicationState, string> = {
  submitted: "Needs review",
  under_review: "Review in progress",
  accepted: "Accepted, offer not sent",
  waitlisted: "Waitlisted",
  declined: "Not selected",
  offer_sent: "Waiting for confirmation",
  confirmed: "Confirmed",
  offer_expired: "Offer expired",
  withdrawn: "Withdrawn",
};

export const applicationDecisionLabels: Record<ApplicationDecision, string> = {
  accept: "Accept",
  waitlist: "Waitlist",
  decline: "Do not select",
};

/** Past-tense labels for published decisions. */
export const applicationDecisionOutcomeLabels: Record<ApplicationDecision, string> = {
  accept: "Accepted",
  waitlist: "Waitlisted",
  decline: "Not selected",
};

export type AdmissionExperienceBand =
  | "first_year"
  | "early_year"
  | "later_year"
  | "postgraduate_or_professional"
  | "mixed_or_external";

export const admissionExperienceBandLabels: Record<AdmissionExperienceBand, string> = {
  first_year: "First year",
  early_year: "Second or early year",
  later_year: "Later year",
  postgraduate_or_professional: "Postgraduate or working professional",
  mixed_or_external: "Mixed years or external team",
};

export type AdmissionOfferState = "offered" | "confirmed" | "declined" | "expired" | "revoked";

export const admissionOfferStateLabels: Record<AdmissionOfferState, string> = {
  offered: "Waiting for the team to accept",
  confirmed: "Accepted by the team",
  declined: "Declined by the team",
  expired: "Expired without an answer",
  revoked: "Withdrawn by an organizer",
};

export type AdmissionReviewAssignmentState = "active" | "completed" | "cancelled";

export const admissionReviewAssignmentStateLabels: Record<AdmissionReviewAssignmentState, string> =
  {
    active: "Has not reviewed yet",
    completed: "Review submitted",
    cancelled: "Cancelled",
  };

export type AdmissionRecommendationState =
  | "pending"
  | "running"
  | "succeeded"
  | "refused"
  | "invalid"
  | "timed_out"
  | "rate_limited"
  | "failed"
  | "stale"
  | "disabled";

export const admissionRecommendationStateLabels: Record<AdmissionRecommendationState, string> = {
  pending: "Being prepared",
  running: "Being prepared",
  succeeded: "Ready",
  refused: "Could not be prepared",
  invalid: "Could not be prepared",
  timed_out: "Try again later",
  rate_limited: "Try again later",
  failed: "Could not be prepared",
  stale: "Out of date since the team edited its project",
  disabled: "Turned off for this event",
};

export type AdmissionAiDisposition = "used" | "cleared" | "overridden" | "stale" | "unavailable";

export const admissionAiDispositionLabels: Record<AdmissionAiDisposition, string> = {
  used: "I agreed with the recommendation",
  cleared: "I did not use the recommendation",
  overridden: "I went against the recommendation",
  stale: "The recommendation was out of date",
  unavailable: "There was no recommendation",
};

export type CriterionAssessment = "meets" | "partly_meets" | "not_yet_clear";

export const criterionAssessmentLabels: Record<CriterionAssessment, string> = {
  meets: "Meets",
  partly_meets: "Partly meets",
  not_yet_clear: "Not yet clear",
};

export const participantClassLabels: Record<ParticipantClass, string> = {
  vit_student: "VIT student",
  external_participant: "External participant",
};

export const participantGenderLabels: Record<ParticipantGender, string> = {
  male: "Male",
  female: "Female",
};

export const vitResidenceTypeLabels: Record<VitResidenceType, string> = {
  day_scholar: "Day scholar",
  hosteller: "Hosteller",
};

export const studyYearLabels: Record<StudyYear, string> = {
  first: "First year",
  second: "Second year",
  third: "Third year",
  fourth: "Fourth year",
  fifth_or_later: "Fifth year or later",
  postgraduate: "Postgraduate",
  not_applicable: "Not a student",
};

export type SupportCaseState = "open" | "investigating" | "waiting" | "resolved" | "closed";

export const supportCaseStateLabels: Record<SupportCaseState, string> = {
  open: "Open",
  investigating: "Being looked at",
  waiting: "Waiting on a reply",
  resolved: "Resolved",
  closed: "Closed",
};

export type SessionPresenceState =
  | "not_expected"
  | "confirmation_due"
  | "present"
  | "temporarily_out"
  | "complete"
  | "excused"
  | "needs_review";

export const sessionPresenceStateLabels: Record<SessionPresenceState, string> = {
  not_expected: "Not expected",
  confirmation_due: "Has not checked in",
  present: "Present",
  temporarily_out: "Temporarily out",
  complete: "Attended",
  excused: "Excused",
  needs_review: "Needs a decision",
};

export type AttendanceSessionResult =
  | "attended"
  | "absent"
  | "partial"
  | "excused"
  | "not_expected"
  | "needs_review";

export const attendanceSessionResultLabels: Record<AttendanceSessionResult, string> = {
  attended: "Attended",
  absent: "Absent",
  partial: "Partially attended",
  excused: "Excused",
  not_expected: "Not expected",
  needs_review: "Needs review",
};

export type VenuePresenceState =
  "not_arrived"
  | "inside"
  | "temporarily_out"
  | "departed"
  | "unknown";

export const venuePresenceStateLabels: Record<VenuePresenceState, string> = {
  not_arrived: "Not arrived",
  inside: "In the venue",
  temporarily_out: "Temporarily out",
  departed: "Left",
  unknown: "Unknown",
};

export type RollCallPresenceState =
  | "not_arrived"
  | "inside"
  | "temporarily_out"
  | "departed"
  | "elsewhere"
  | "unknown";

export const rollCallPresenceStateLabels: Record<RollCallPresenceState, string> = {
  not_arrived: "Not arrived",
  inside: "Inside",
  temporarily_out: "Temporarily out",
  departed: "Departed",
  elsewhere: "Elsewhere",
  unknown: "Unknown",
};

export type AttendancePresenceSourceKind = "scanner" | "staff_reconciliation" | "manual_import";

export type AttendancePresenceTransition =
  | "venue_entry"
  | "venue_exit"
  | "session_confirm"
  | "zone_entry"
  | "zone_exit"
  | "manual_reconcile";

export type AttendancePresenceOutcome =
  "accepted"
  | "duplicate"
  | "rejected"
  | "needs_review"
  | "reconciled";

export type AttendanceCorrectionKind =
  | "presence_confirmed"
  | "temporary_exit"
  | "marked_needs_review"
  | "voided_transition";

export const attendancePresenceSourceLabels: Record<AttendancePresenceSourceKind, string> = {
  scanner: "Scanner",
  staff_reconciliation: "Correction",
  manual_import: "Paper import",
};

export const attendancePresenceTransitionLabels: Record<AttendancePresenceTransition, string> = {
  venue_entry: "Arrived",
  venue_exit: "Left",
  session_confirm: "Session check-in",
  zone_entry: "Returned",
  zone_exit: "Temporary exit",
  manual_reconcile: "Correction",
};

export const attendancePresenceOutcomeLabels: Record<AttendancePresenceOutcome, string> = {
  accepted: "Recorded",
  duplicate: "Already recorded",
  rejected: "Not recorded",
  needs_review: "Needs review",
  reconciled: "Corrected",
};

export const attendanceCorrectionKindLabels: Record<AttendanceCorrectionKind, string> = {
  presence_confirmed: "Presence recorded",
  temporary_exit: "Temporary exit recorded",
  marked_needs_review: "Marked for review",
  voided_transition: "Latest scan voided",
};

export function attendanceHistoryEventLabel(event: {
  sourceKind: AttendancePresenceSourceKind;
  transition: AttendancePresenceTransition;
  outcome: AttendancePresenceOutcome;
  correctionKind?: AttendanceCorrectionKind;
}) {
  const detail = event.correctionKind
    ? attendanceCorrectionKindLabels[event.correctionKind]
    : `${attendancePresenceTransitionLabels[event.transition]} · ${attendancePresenceOutcomeLabels[event.outcome]}`;
  return `${attendancePresenceSourceLabels[event.sourceKind]}: ${detail}`;
}

/** Organisational labels only. Authorization always comes from exact grants. */
export type EventRole = "supreme" | "board" | "sc" | "jc" | "external_judge";

export const eventRoleLabels: Record<EventRole, string> = {
  supreme: "Supreme",
  board: "Board",
  sc: "SC",
  jc: "JC",
  external_judge: "External Judge",
};

export type SynesthesiaWindowStatus = "draft" | "published" | "closed";

export const synesthesiaWindowStatusLabels: Record<SynesthesiaWindowStatus, string> = {
  draft: "Draft, participants cannot see it",
  published: "Open to participants",
  closed: "Closed",
};

export type SynesthesiaWindowKind =
  | "arrival"
  | "working_session"
  | "late_night"
  | "morning_reset"
  | "judging"
  | "closing"
  | "custom";

export const synesthesiaWindowKindLabels: Record<SynesthesiaWindowKind, string> = {
  arrival: "Arrival",
  working_session: "Working session",
  late_night: "Late night",
  morning_reset: "Morning reset",
  judging: "Judging",
  closing: "Closing",
  custom: "Custom",
};

export type SynesthesiaCatalogTrackStatus = "active" | "disabled";

export const synesthesiaCatalogTrackStatusLabels: Record<SynesthesiaCatalogTrackStatus, string> = {
  active: "Participants can request it",
  disabled: "Withdrawn, nobody can request it",
};

export type SongRequestState =
  | "pending"
  | "approved"
  | "queued"
  | "playing"
  | "played"
  | "skipped"
  | "rejected"
  | "hidden";

export const songRequestStateLabels: Record<SongRequestState, string> = {
  pending: "Waiting for your decision",
  approved: "Approved, not in the queue yet",
  queued: "In the queue",
  playing: "Playing now",
  played: "Played",
  skipped: "Skipped",
  rejected: "Declined",
  hidden: "Hidden from participants",
};

export type RehearsalRunState = "draft" | "active" | "completed" | "cancelled";

export const rehearsalRunStateLabels: Record<RehearsalRunState, string> = {
  draft: "Being set up",
  active: "Under way",
  completed: "Signed off",
  cancelled: "Cancelled",
};

export type RehearsalScenarioState = "pending" | "running" | "passed" | "failed" | "blocked";

export const rehearsalScenarioStateLabels: Record<RehearsalScenarioState, string> = {
  pending: "Not tried yet",
  running: "Being tried now",
  passed: "Worked",
  failed: "Did not work",
  blocked: "Could not be tried",
};

export type RehearsalWorkstream =
  | "auth_access"
  | "intake_admissions"
  | "communications"
  | "attendance"
  | "reviewer_app"
  | "review_operations"
  | "integrations"
  | "reliability"
  | "synesthesia"
  | "support";

export const rehearsalWorkstreamLabels: Record<RehearsalWorkstream, string> = {
  auth_access: "Sign-in and access",
  intake_admissions: "Intake and admissions",
  communications: "Communications",
  attendance: "Attendance",
  reviewer_app: "Reviewer app",
  review_operations: "Review operations",
  integrations: "GitHub and Figma",
  reliability: "Reliability",
  synesthesia: "Music desk",
  support: "Support",
};

/** Includes the `expired` state derived from the four-hour lifetime. */
export type EmergencyPackStatus = "pending" | "ready" | "failed" | "expired";

export const emergencyPackStatusLabels: Record<EmergencyPackStatus, string> = {
  pending: "Being prepared",
  ready: "Ready to print",
  failed: "Could not be prepared",
  expired: "Too old to use",
};

export type ReviewEvaluationState = "complete" | "void";

export const reviewEvaluationStateLabels: Record<ReviewEvaluationState, string> = {
  complete: "Result counted",
  void: "Result voided",
};

export type RoundExportState = "generating" | "uploaded" | "verified" | "failed" | "superseded";

export const roundExportStateLabels: Record<RoundExportState, string> = {
  generating: "Being written",
  uploaded: "Waiting to be checked",
  verified: "Checked by a second person",
  failed: "Could not be written",
  superseded: "Replaced by a newer export",
};

export type ScorecardCorrectionKind = "correction" | "void";

export const scorecardCorrectionKindLabels: Record<ScorecardCorrectionKind, string> = {
  correction: "Correction",
  void: "Void",
};

export type ScorecardCorrectionState = "requested" | "open" | "rejected" | "closed";

export const scorecardCorrectionStateLabels: Record<ScorecardCorrectionState, string> = {
  requested: "Waiting for a decision",
  open: "Reviewer is redoing it",
  rejected: "Declined",
  closed: "Settled",
};

export type ScorecardCorrectionCategory =
  | "reviewer_error"
  | "technical_error"
  | "wrong_team"
  | "duplicate_review"
  | "confirmed_conflict"
  | "judge_ineligible"
  | "other";

export const scorecardCorrectionCategoryLabels: Record<ScorecardCorrectionCategory, string> = {
  reviewer_error: "Reviewer made a mistake",
  technical_error: "Something in the app went wrong",
  wrong_team: "Scored the wrong team",
  duplicate_review: "The same review twice",
  confirmed_conflict: "Reviewer had a conflict of interest",
  judge_ineligible: "Reviewer should not have judged this",
  other: "Something else",
};

export type IntegrationProviderHealth = "ready" | "syncing" | "needs_attention" | "not_connected";

export const integrationProviderHealthLabels: Record<IntegrationProviderHealth, string> = {
  ready: "Connected",
  syncing: "Catching up",
  needs_attention: "Needs attention",
  not_connected: "Nothing connected",
};

export type GithubRepositorySyncState = "pending" | "running" | "ready" | "rate_limited" | "error";

export const githubRepositorySyncStateLabels: Record<GithubRepositorySyncState, string> = {
  pending: "Waiting to read",
  running: "Reading now",
  ready: "Up to date",
  rate_limited: "Paused by GitHub's rate limit",
  error: "Could not be read",
};

export type GithubRepositoryTopicState = "present" | "missing" | "unknown";

export const githubRepositoryTopicStateLabels: Record<GithubRepositoryTopicState, string> = {
  present: "Event topic set",
  missing: "Event topic missing",
  unknown: "Event topic not checked",
};

export type GithubRepositoryCoverage = "complete" | "partial" | "unknown";

export const githubRepositoryCoverageLabels: Record<GithubRepositoryCoverage, string> = {
  complete: "All changes counted",
  partial: "Some changes could not be counted",
  unknown: "Changes not counted yet",
};

export const repositoryKindLabels: Record<RepositoryKind, string> = {
  full_product: "Whole product",
  frontend: "Front end",
  backend_api: "Back end or API",
  mobile_app: "Mobile app",
  desktop_app: "Desktop app",
  ai_ml: "AI or machine learning",
  data_pipeline: "Data pipeline",
  hardware_firmware: "Hardware or firmware",
  infrastructure: "Infrastructure",
  library_sdk: "Library or SDK",
  docs_research: "Docs or research",
  other: "Something else",
};

export type SupportCaseCategory =
  | "identity"
  | "team"
  | "project_intake"
  | "attendance_credential"
  | "missing_scan"
  | "scanner_device"
  | "integration"
  | "queue"
  | "reviewer_device"
  | "scorecard"
  | "accessibility"
  | "safety";

/** Shared category labels used by participants and the help desk. */
export const supportCaseCategoryLabels: Record<SupportCaseCategory, string> = {
  identity: "Identity or sign-in",
  team: "Team",
  project_intake: "Idea submission",
  attendance_credential: "Check-in or ID",
  missing_scan: "Check-in scan",
  scanner_device: "Scanner device",
  integration: "GitHub or Figma",
  queue: "Judging queue",
  reviewer_device: "Reviewer device",
  scorecard: "Judge scores",
  accessibility: "Accessibility",
  safety: "Safety",
};

export const supportCaseCategoryOrder: readonly SupportCaseCategory[] = [
  "identity",
  "team",
  "project_intake",
  "attendance_credential",
  "missing_scan",
  "scanner_device",
  "integration",
  "queue",
  "reviewer_device",
  "scorecard",
  "accessibility",
  "safety",
];
