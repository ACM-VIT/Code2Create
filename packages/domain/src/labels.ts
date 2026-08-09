/**
 * User-facing wording for the domain's state vocabulary.
 *
 * Screens must render these instead of title-casing a stored value. A stored
 * value is a state-machine key chosen for the server; it reads as jargon on a
 * floor at 3am ("Marked needs review", "Agent timed out", "Begin vit enrolment").
 *
 * Each map is a `Record` over its full union, so adding a state to the domain
 * without deciding how to say it out loud fails the type check.
 *
 * Operators and participants get different wording where the same state means
 * different things to them: a queue row an operator reads as "At the table"
 * is the participant's instruction "Keep your team code open".
 */

import type {
  ApplicationDecision,
  ParticipantClass,
  RepositoryKind,
  StudyYear,
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
  | "withdrawn";

export const teamRoundStateOperatorLabels: Record<TeamRoundState, string> = {
  unassigned: "Waiting for the desk",
  queued: "In queue",
  called: "Called to the table",
  at_table: "At the table",
  in_review: "In review",
  completed: "Review complete",
  held: "On hold",
  missed: "Missed the call",
  withdrawn: "Withdrawn",
};

export const teamRoundStateParticipantLabels: Record<TeamRoundState, string> = {
  unassigned: "Waiting for the review desk",
  queued: "In queue",
  called: "Go to your table",
  at_table: "At the table",
  in_review: "Review in progress",
  completed: "Complete",
  held: "On hold",
  missed: "Missed call",
  withdrawn: "Withdrawn",
};

export type ReviewSessionStatus =
  | "awaiting_presence"
  | "active"
  | "overdue"
  | "completed"
  | "cancelled";

export const reviewSessionStatusLabels: Record<ReviewSessionStatus, string> = {
  awaiting_presence: "Waiting for reviewers to scan in",
  active: "Under way",
  overdue: "Past its planned end",
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
  | "needs_information"
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
  needs_information: "Waiting for the team",
  accepted: "Accepted, offer not sent",
  waitlisted: "Waitlisted",
  declined: "Not selected",
  offer_sent: "Waiting for confirmation",
  confirmed: "Confirmed",
  offer_expired: "Offer expired",
  withdrawn: "Withdrawn",
};

/**
 * Admission vocabulary.
 *
 * The application dossier used to title-case these in place, which put
 * "Mixed or external", "Not yet clear" and a bare "active" on the same screen
 * without saying what any of them meant for the reader's next move.
 */
export const applicationDecisionLabels: Record<ApplicationDecision, string> = {
  accept: "Accept",
  waitlist: "Waitlist",
  decline: "Do not select",
  needs_information: "Ask the team for more",
};

/**
 * The same decisions once they have been published.
 *
 * The dossier used to lowercase the imperative label into a sentence, which
 * produced "Published as accept" and "Published as do not select". A decision
 * that already happened reads as an outcome, not as an instruction.
 */
export const applicationDecisionOutcomeLabels: Record<ApplicationDecision, string> = {
  accept: "Accepted",
  waitlist: "Waitlisted",
  decline: "Not selected",
  needs_information: "Sent back to the team for more",
};

export type AdmissionExperienceBand =
  | "first_year"
  | "early_year"
  | "later_year"
  | "postgraduate_or_professional"
  | "mixed_or_external";

/** What a reviewer should expect of this team, given how far into a degree it is. */
export const admissionExperienceBandLabels: Record<AdmissionExperienceBand, string> = {
  first_year: "Judge as a first-year team",
  early_year: "Judge as an early-year team",
  later_year: "Judge as a later-year team",
  postgraduate_or_professional: "Judge as a postgraduate or professional team",
  mixed_or_external: "Judge as a mixed or external team",
};

export type AdmissionOfferState =
  | "offered"
  | "confirmed"
  | "declined"
  | "expired"
  | "revoked";

export const admissionOfferStateLabels: Record<AdmissionOfferState, string> = {
  offered: "Waiting for the team to accept",
  confirmed: "Accepted by the team",
  declined: "Declined by the team",
  expired: "Expired without an answer",
  revoked: "Withdrawn by an organizer",
};

export type AdmissionInformationRequestState = "open" | "answered" | "superseded";

export const admissionInformationRequestStateLabels: Record<
  AdmissionInformationRequestState,
  string
> = {
  open: "Waiting for the team",
  answered: "Answered",
  superseded: "Replaced by a newer request",
};

export type AdmissionReviewAssignmentState = "active" | "completed" | "cancelled";

export const admissionReviewAssignmentStateLabels: Record<
  AdmissionReviewAssignmentState,
  string
> = {
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

export type AdmissionAiDisposition =
  | "used"
  | "cleared"
  | "overridden"
  | "stale"
  | "unavailable";

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

export type VenuePresenceState =
  | "not_arrived"
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

/**
 * Organisational labels.
 *
 * The dashboard rendered `sc` and `jc` as bare initials next to a person's
 * name, which tells a reader nothing. The specs use both throughout and never
 * expand either, so the two expansions below are assumed and need confirming
 * against what the committee actually calls itself.
 */
export type EventRole = "supreme" | "board" | "sc" | "jc" | "external_judge";

export const eventRoleLabels: Record<EventRole, string> = {
  supreme: "Supreme",
  board: "Board",
  sc: "Senior Core",
  jc: "Junior Core",
  external_judge: "External judge",
};

/**
 * Music desk vocabulary.
 *
 * The desk used to print the stored key with its underscores swapped for
 * spaces, so a window read "published" and a song read "queued" — words that
 * describe rows in a table rather than what the operator is looking at.
 */
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

export const synesthesiaCatalogTrackStatusLabels: Record<
  SynesthesiaCatalogTrackStatus,
  string
> = {
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

/**
 * Test-run vocabulary.
 *
 * A rehearsal run and its checks were shown as `draft`/`active` and
 * `pending`/`blocked`, which says nothing about whether a person is meant to
 * do something about them.
 */
export type RehearsalRunState = "draft" | "active" | "completed" | "cancelled";

export const rehearsalRunStateLabels: Record<RehearsalRunState, string> = {
  draft: "Being set up",
  active: "Under way",
  completed: "Signed off",
  cancelled: "Cancelled",
};

export type RehearsalScenarioState =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "blocked";

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
  | "floor"
  | "reviewer_app"
  | "review_operations"
  | "integrations"
  | "reliability"
  | "synesthesia"
  | "support";

/** The part of the event a rehearsal check belongs to, named as staff say it. */
export const rehearsalWorkstreamLabels: Record<RehearsalWorkstream, string> = {
  auth_access: "Sign-in and access",
  intake_admissions: "Intake and admissions",
  communications: "Communications",
  attendance: "Attendance",
  floor: "Hall operations",
  reviewer_app: "Reviewer app",
  review_operations: "Review operations",
  integrations: "GitHub and Figma",
  reliability: "Reliability",
  synesthesia: "Music desk",
  support: "Support",
};

/**
 * Paper-backup vocabulary.
 *
 * `expired` is not stored: the backup list derives it from the four-hour
 * lifetime, and an operator needs to be told the pack is no longer usable
 * rather than shown the word.
 */
export type EmergencyPackStatus = "pending" | "ready" | "failed" | "expired";

export const emergencyPackStatusLabels: Record<EmergencyPackStatus, string> = {
  pending: "Being prepared",
  ready: "Ready to print",
  failed: "Could not be prepared",
  expired: "Too old to use",
};

/**
 * Hall vocabulary.
 *
 * `setup`, `open` and `frozen` decide whether floor staff can pin a team to a
 * spot at all, so each label says what is possible rather than naming a state.
 */
export type FloorMappingState = "setup" | "open" | "frozen";

export const floorMappingStateLabels: Record<FloorMappingState, string> = {
  setup: "Not open for mapping yet",
  open: "Open for mapping",
  frozen: "Locations frozen",
};

export type FloorSpotStatus = "available" | "closed";

export const floorSpotStatusLabels: Record<FloorSpotStatus, string> = {
  available: "Usable",
  closed: "Closed off, do not seat a team here",
};

/**
 * Score governance vocabulary.
 *
 * The round board printed these by swapping underscores for spaces, so an
 * operator read "awaiting presence", "correction open" and "judge ineligible"
 * — the server's words, in the server's grammar, in the middle of a sentence.
 */
export type ReviewEvaluationState = "complete" | "void";

export const reviewEvaluationStateLabels: Record<ReviewEvaluationState, string> = {
  complete: "Result counted",
  void: "Result voided",
};

export type RoundExportState =
  | "generating"
  | "uploaded"
  | "verified"
  | "failed"
  | "superseded";

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

/**
 * Code and design vocabulary.
 *
 * The integrations screen title-cased provider keys in place, so a row read
 * "Rate limited", "Unknown" and "Partial" with nothing saying what those meant
 * for whether a reviewer would see the team's work.
 */
export type IntegrationProviderHealth = "ready" | "syncing" | "needs_attention" | "not_connected";

export const integrationProviderHealthLabels: Record<IntegrationProviderHealth, string> = {
  ready: "Connected",
  syncing: "Catching up",
  needs_attention: "Needs attention",
  not_connected: "Nothing connected",
};

export type GithubRepositorySyncState =
  | "pending"
  | "running"
  | "ready"
  | "rate_limited"
  | "error";

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

export type FigmaPreviewState =
  | "pending"
  | "running"
  | "ready"
  | "partial"
  | "rate_limited"
  | "failed";

export const figmaPreviewStateLabels: Record<FigmaPreviewState, string> = {
  pending: "Waiting to render",
  running: "Rendering now",
  ready: "Ready to look at",
  partial: "Some frames missing",
  rate_limited: "Paused by Figma's rate limit",
  failed: "Could not be rendered",
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
  | "track_configuration"
  | "attendance_credential"
  | "missing_scan"
  | "scanner_device"
  | "table_location"
  | "integration"
  | "queue"
  | "reviewer_device"
  | "scorecard"
  | "accessibility"
  | "safety";

/**
 * What a participant walked up about, in the words they would use.
 *
 * The help desk and the participant app both offer this list, so it lives here
 * rather than in either screen; they drifted apart while it did not.
 */
export const supportCaseCategoryLabels: Record<SupportCaseCategory, string> = {
  identity: "Identity or sign-in",
  team: "Team",
  project_intake: "Idea submission",
  track_configuration: "Track",
  attendance_credential: "Check-in or ID",
  missing_scan: "Check-in scan",
  scanner_device: "Scanner device",
  table_location: "Hall location",
  integration: "GitHub or Figma",
  queue: "Judging queue",
  reviewer_device: "Reviewer device",
  scorecard: "Judge scores",
  accessibility: "Accessibility",
  safety: "Safety",
};

/** The order the desk offers them in, most common first. */
export const supportCaseCategoryOrder: readonly SupportCaseCategory[] = [
  "identity",
  "team",
  "project_intake",
  "track_configuration",
  "attendance_credential",
  "missing_scan",
  "scanner_device",
  "table_location",
  "integration",
  "queue",
  "reviewer_device",
  "scorecard",
  "accessibility",
  "safety",
];
