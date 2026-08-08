/**
 * Turns the live review projections into the rows the Overview leads with.
 *
 * `specs/06-operations-dashboard.md:5` asks the dashboard to answer two
 * questions — what needs my attention now, and where do I do that work. A
 * severity and a count answer neither. Every row here names the thing that is
 * stuck, says what is wrong in the words an operator would use, and carries the
 * route to the screen where it gets fixed.
 */

export type AttentionSeverity = "critical" | "attention" | "watch";

/** The dashboard jobs from `specs/06-operations-dashboard.md:7-17`. */
export type AttentionJob = "panel_seats" | "team_queue" | "active_reviews";

export type AttentionRow = {
  key: string;
  job: AttentionJob;
  severity: AttentionSeverity;
  subject: string;
  context?: string;
  statement: string;
  since?: number;
  route: string;
  actionLabel: string;
  /** False when the caller may look but holds no command grant for the fix. */
  canAct: boolean;
};

const severityRank: Record<AttentionSeverity, number> = {
  critical: 0,
  attention: 1,
  watch: 2,
};

/**
 * A team is "waiting long" once it has been queued for more than two reviews'
 * worth of time, which is when the desk would start asking why.
 */
const waitingMultiplier = 2;

type PanelView = {
  id: string;
  name: string;
  tableLabel: string;
  status: "draft" | "ready" | "needs_reviewer" | "paused" | "closed";
  reviewers: ReadonlyArray<{ displayName: string; clockInStatus: string }>;
};

type TeamView = {
  teamName: string;
  state:
    | "unassigned"
    | "queued"
    | "called"
    | "at_table"
    | "in_review"
    | "completed"
    | "held"
    | "missed"
    | "withdrawn";
  queuedAt?: number;
  tableLabel?: string;
  holdReason?: string;
  missedEligibleAt?: number;
  canHold: boolean;
  canResume: boolean;
  canMarkMissed: boolean;
  participantAvailability: {
    availableCount: number;
    requiredCount: number;
    isMet: boolean;
    isWaived: boolean;
    canWaive: boolean;
  };
  review: {
    status: "awaiting_presence" | "active" | "overdue" | "completed" | "cancelled";
    plannedEndAt?: number;
    reviewerPresenceCount: number;
    reviewerCount: number;
    canStart: boolean;
    canComplete: boolean;
  } | null;
};

export function reviewAttentionRows(input: {
  roundId: string;
  roundName: string;
  requiredPanelSize: number;
  reviewDurationSeconds: number;
  panels: ReadonlyArray<PanelView>;
  teams: ReadonlyArray<TeamView>;
  now: number;
}): AttentionRow[] {
  const route = `/reviews/${input.roundId}`;
  const rows: AttentionRow[] = [];

  for (const panel of input.panels) {
    const present = panel.reviewers.filter(
      (reviewer) => reviewer.clockInStatus === "present",
    ).length;
    if (panel.status !== "needs_reviewer" && present >= input.requiredPanelSize) continue;
    const missing = input.requiredPanelSize - present;
    rows.push({
      key: `panel_seat_empty:${panel.id}`,
      job: "panel_seats",
      severity: "critical",
      subject: `${panel.name} · ${panel.tableLabel}`,
      context: input.roundName,
      statement:
        missing === 1
          ? "One seat has nobody in it. Reviews here cannot start."
          : `${missing} seats have nobody in them. Reviews here cannot start.`,
      route,
      actionLabel: "Page a substitute",
      canAct: true,
    });
  }

  for (const team of input.teams) {
    const at = team.tableLabel ? `${input.roundName} · ${team.tableLabel}` : input.roundName;

    if (team.review?.status === "overdue") {
      rows.push({
        key: `review_overdue:${team.teamName}`,
        job: "active_reviews",
        severity: "critical",
        subject: team.teamName,
        context: at,
        statement: "This review has passed the time it was meant to finish.",
        ...(team.review.plannedEndAt === undefined ? {} : { since: team.review.plannedEndAt }),
        route,
        actionLabel: "Extend or close it",
        canAct: team.review.canComplete,
      });
    }

    if (
      team.review?.status === "awaiting_presence" &&
      team.review.reviewerPresenceCount < team.review.reviewerCount
    ) {
      rows.push({
        key: `presence_incomplete:${team.teamName}`,
        job: "active_reviews",
        severity: "attention",
        subject: team.teamName,
        context: at,
        statement: `${team.review.reviewerPresenceCount} of ${team.review.reviewerCount} reviewers have scanned in, so the review cannot start.`,
        route,
        actionLabel: "Check the table",
        canAct: team.review.canStart,
      });
    }

    if (!team.participantAvailability.isMet && !team.participantAvailability.isWaived) {
      const { availableCount, requiredCount } = team.participantAvailability;
      rows.push({
        key: `below_minimum:${team.teamName}`,
        job: "team_queue",
        severity: "attention",
        subject: team.teamName,
        context: at,
        statement: `Only ${availableCount} of the team is in the hall; this round needs ${requiredCount}. The desk cannot call them yet.`,
        route,
        actionLabel: "Record an exception",
        canAct: team.participantAvailability.canWaive,
      });
    }

    if (team.state === "held") {
      rows.push({
        key: `team_held:${team.teamName}`,
        job: "team_queue",
        severity: "attention",
        subject: team.teamName,
        context: at,
        statement: team.holdReason
          ? `On hold: ${team.holdReason}`
          : "On hold, with no reason recorded.",
        route,
        actionLabel: "Take them off hold",
        canAct: team.canResume,
      });
    }

    if (
      team.state === "called" &&
      team.missedEligibleAt !== undefined &&
      input.now > team.missedEligibleAt
    ) {
      rows.push({
        key: `call_overdue:${team.teamName}`,
        job: "team_queue",
        severity: "attention",
        subject: team.teamName,
        context: at,
        statement: "Called to the table, but the grace period has run out.",
        since: team.missedEligibleAt,
        route,
        actionLabel: "Mark them missed",
        canAct: team.canMarkMissed,
      });
    }

    if (team.state === "queued" && team.queuedAt !== undefined) {
      const waitedFor = input.now - team.queuedAt;
      if (waitedFor > waitingMultiplier * input.reviewDurationSeconds * 1_000) {
        rows.push({
          key: `waiting_long:${team.teamName}`,
          job: "team_queue",
          severity: "watch",
          subject: team.teamName,
          context: at,
          statement: "Has been waiting longer than two reviews' worth of time.",
          since: team.queuedAt,
          route,
          actionLabel: "Move them up the queue",
          canAct: team.canHold,
        });
      }
    }
  }

  return rows;
}

/** Most urgent first, then longest-waiting, so the top row is the next job. */
export function sortAttentionRows(rows: readonly AttentionRow[]): AttentionRow[] {
  return [...rows].sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      (left.since ?? Number.MAX_SAFE_INTEGER) - (right.since ?? Number.MAX_SAFE_INTEGER) ||
      left.subject.localeCompare(right.subject),
  );
}
