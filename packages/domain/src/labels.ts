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
