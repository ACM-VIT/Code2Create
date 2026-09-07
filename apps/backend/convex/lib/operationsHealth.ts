import {
  operationsHealthSignalKeys,
  type OperationsHealthArea,
  type OperationsHealthSeverity,
  type OperationsHealthSignalKey,
  type OperationsHealthStatus,
} from "@code2create/domain";

export type HealthSeverity = OperationsHealthSeverity;
export type HealthStatus = OperationsHealthStatus;
export type HealthArea = OperationsHealthArea;
export type HealthSignalKey = OperationsHealthSignalKey;

export const healthSignalKeys = operationsHealthSignalKeys;

export type BoundedCount = {
  count: number;
  atLeast: boolean;
  oldestAt?: number;
};

export type OperationsHealthCounts = Record<HealthSignalKey, BoundedCount>;

export type OperationsHealthSignal = BoundedCount & {
  key: HealthSignalKey;
  area: HealthArea;
  severity: HealthSeverity;
  title: string;
  detail: string;
  owner: string;
  nextAction: string;
};

export type OperationsHealthSummary = {
  status: HealthStatus;
  signalCount: number;
  criticalSignalCount: number;
  attentionSignalCount: number;
  watchSignalCount: number;
};

type SignalDefinition = {
  area: HealthArea;
  severity: HealthSeverity;
  singular: string;
  plural: string;
  detail: string;
  owner: string;
  nextAction: string;
};

const signalDefinitions = {
  critical_incidents: {
    area: "system",
    severity: "critical",
    singular: "Critical incident",
    plural: "Critical incidents",
    detail: "A critical incident is open or being monitored.",
    owner: "Incident lead",
    nextAction: "Keep recovery and manual-mode decisions in the incident record.",
  },
  active_incidents: {
    area: "system",
    severity: "attention",
    singular: "Active incident",
    plural: "Active incidents",
    detail: "A non-critical incident is still open or under monitoring.",
    owner: "Incident lead",
    nextAction: "Assign an owner and keep its state current.",
  },
  intake_interpretation_stalls: {
    area: "intake",
    severity: "attention",
    singular: "Stalled intake interpretation",
    plural: "Stalled intake interpretations",
    detail: "A project-intake interpretation has remained in progress past its worker window.",
    owner: "Intake operations",
    nextAction: "Confirm the fallback completed before retrying model work.",
  },
  recent_intake_fallbacks: {
    area: "intake",
    severity: "watch",
    singular: "Recent intake fallback",
    plural: "Recent intake fallbacks",
    detail: "A recent interpretation refused, timed out, hit a limit, or failed validation.",
    owner: "Intake operations",
    nextAction: "Monitor the rate; participant progress should continue on the published fallback.",
  },
  novelty_preview_stalls: {
    area: "intake",
    severity: "attention",
    singular: "Stalled novelty preview",
    plural: "Stalled novelty previews",
    detail: "A novelty request remained in progress past its complete provider window.",
    owner: "Intake operations",
    nextAction: "Confirm the request settled and that proposal editing remains available.",
  },
  recent_novelty_unavailable: {
    area: "intake",
    severity: "watch",
    singular: "Recent unavailable novelty preview",
    plural: "Recent unavailable novelty previews",
    detail: "Optional novelty work was shed, unavailable, or failed recently.",
    owner: "Intake operations",
    nextAction: "Monitor the rate and provider headroom; do not interrupt proposal editing.",
  },
  admission_analysis_stalls: {
    area: "admissions",
    severity: "attention",
    singular: "Stalled admission analysis",
    plural: "Stalled admission analyses",
    detail:
      "An admission recommendation job has remained pending or running past its worker window.",
    owner: "Admissions lead",
    nextAction: "Keep human review moving and inspect the current recommendation job.",
  },
  recent_admission_fallbacks: {
    area: "admissions",
    severity: "watch",
    singular: "Recent unavailable admission analysis",
    plural: "Recent unavailable admission analyses",
    detail: "A recent recommendation refused, timed out, hit a limit, or failed validation.",
    owner: "Admissions lead",
    nextAction: "Continue human review and monitor whether failures are clustering.",
  },
  active_round_pauses: {
    area: "reviews",
    severity: "critical",
    singular: "Paused review round",
    plural: "Paused review rounds",
    detail: "Review work is paused by an active incident.",
    owner: "Review lead",
    nextAction: "Resolve the linked incident before resuming the round.",
  },
  attendance_job_failures: {
    area: "attendance",
    severity: "critical",
    singular: "Failed attendance job",
    plural: "Failed attendance jobs",
    detail: "A current session preparation or close job failed.",
    owner: "Attendance lead",
    nextAction: "Review the session and retry through its scoped control.",
  },
  attendance_job_stalls: {
    area: "attendance",
    severity: "attention",
    singular: "Stalled attendance job",
    plural: "Stalled attendance jobs",
    detail: "A current attendance job has stopped making progress.",
    owner: "Attendance lead",
    nextAction: "Inspect the current job before starting another operation.",
  },
  round_export_failures: {
    area: "scores",
    severity: "critical",
    singular: "Failed round export",
    plural: "Failed round exports",
    detail: "A closing round's current immutable export failed.",
    owner: "Score operations",
    nextAction: "Use the exact export retry flow after reviewing the failure.",
  },
  round_export_stalls: {
    area: "scores",
    severity: "attention",
    singular: "Stalled round export",
    plural: "Stalled round exports",
    detail: "A closing round has waited too long for its current export.",
    owner: "Score operations",
    nextAction: "Inspect the active close and export before retrying anything.",
  },
  emergency_pack_failures: {
    area: "system",
    severity: "attention",
    singular: "Emergency pack failed",
    plural: "Emergency packs failed",
    detail: "A current restricted emergency-pack artifact could not be generated.",
    owner: "Incident readiness",
    nextAction:
      "Review private storage health and prepare a new pack before relying on paper recovery.",
  },
  emergency_pack_stalls: {
    area: "system",
    severity: "attention",
    singular: "Emergency pack stalled",
    plural: "Emergency packs stalled",
    detail: "An emergency-pack snapshot has remained pending past the export worker window.",
    owner: "Incident readiness",
    nextAction: "Inspect the export worker and storage path before requesting another pack.",
  },
  panels_needing_reviewer: {
    area: "reviews",
    severity: "attention",
    singular: "Panel needing a reviewer",
    plural: "Panels needing a reviewer",
    detail: "A review panel no longer has its required active reviewer set.",
    owner: "Review desk",
    nextAction: "Page or assign a scoped substitute.",
  },
  overdue_reviews: {
    area: "reviews",
    severity: "attention",
    singular: "Review finishing scorecards",
    plural: "Reviews finishing scorecards",
    detail:
      "The discussion has ended and reviewers are entering their scores and comments.",
    owner: "Panel coordinator",
    nextAction:
      "Finish the scorecards and shared notes, then complete the review.",
  },
  expired_reviewer_pages: {
    area: "reviews",
    severity: "attention",
    singular: "Expired reviewer page still open",
    plural: "Expired reviewer pages still open",
    detail: "A substitute page passed its deadline without reaching a terminal state.",
    owner: "Review desk",
    nextAction: "Run the next substitute step or close the page chain.",
  },
  // Retired on 2026-09-08; nothing emits it, stored rows may still carry it.
  stale_reviewer_heartbeats: {
    area: "reviews",
    severity: "watch",
    singular: "Reviewer heartbeat to confirm",
    plural: "Reviewer heartbeats to confirm",
    detail: "Retired signal from before reviewer heartbeats were removed.",
    owner: "Review desk",
    nextAction: "No action; refresh the checks.",
  },
  stale_scanner_stations: {
    area: "attendance",
    severity: "attention",
    singular: "Scanner station offline",
    plural: "Scanner stations offline",
    detail: "An active station during the live event has missed its authenticated heartbeat.",
    owner: "Attendance lead",
    nextAction: "Reconnect or reprovision the assigned phone before relying on it.",
  },
  scanner_queues_awaiting_replay: {
    area: "attendance",
    severity: "watch",
    singular: "Scanner queue awaiting replay",
    plural: "Scanner queues awaiting replay",
    detail:
      "An assigned phone still holds encrypted physical-credential scans without server receipts.",
    owner: "Attendance lead",
    nextAction: "Restore connectivity and confirm the phone replays its queue before reassignment.",
  },
  participant_delivery_failures: {
    area: "communications",
    severity: "attention",
    singular: "Participant message not delivered",
    plural: "Participant messages not delivered",
    detail: "A current email attempt failed, bounced, or was suppressed.",
    owner: "Admissions communications",
    nextAction: "Verify the destination and use the scoped retry or contact route.",
  },
  participant_delivery_unknown: {
    area: "communications",
    severity: "attention",
    singular: "Participant message with unknown outcome",
    plural: "Participant messages with unknown outcomes",
    detail: "The provider outcome is ambiguous, so a blind retry could duplicate delivery.",
    owner: "Admissions communications",
    nextAction: "Reconcile the provider result before retrying.",
  },
  participant_delivery_stalls: {
    area: "communications",
    severity: "attention",
    singular: "Stalled participant message",
    plural: "Stalled participant messages",
    detail: "A pending, sending, or retrying email has passed its processing deadline.",
    owner: "Admissions communications",
    nextAction: "Inspect the current delivery attempt before intervening.",
  },
  github_inaccessible_repositories: {
    area: "integrations",
    severity: "attention",
    singular: "Inaccessible GitHub repository",
    plural: "Inaccessible GitHub repositories",
    detail: "A team repository can no longer be read through its installation.",
    owner: "Integrations desk",
    nextAction: "Ask the team to restore repository access or archive the binding.",
  },
  github_sync_errors: {
    area: "integrations",
    severity: "attention",
    singular: "GitHub sync error",
    plural: "GitHub sync errors",
    detail: "A current repository reconciliation ended in an error.",
    owner: "Integrations desk",
    nextAction: "Inspect the repository binding and run its scoped refresh.",
  },
  github_sync_stalls: {
    area: "integrations",
    severity: "attention",
    singular: "Stalled GitHub sync",
    plural: "Stalled GitHub syncs",
    detail: "A repository sync stayed pending or outlived its processing lease.",
    owner: "Integrations desk",
    nextAction: "Confirm provider access before requesting another refresh.",
  },
  github_rate_limits: {
    area: "integrations",
    severity: "watch",
    singular: "Rate-limited GitHub repository",
    plural: "Rate-limited GitHub repositories",
    detail: "GitHub asked the platform to wait before refreshing repository data.",
    owner: "Integrations desk",
    nextAction: "Let the scheduled retry run unless evidence is time-critical.",
  },
  github_unverified_topics: {
    area: "integrations",
    severity: "watch",
    singular: "Repository topic not verified",
    plural: "Repository topics not verified",
    detail: "The required Code2Create topic is missing or has not been confirmed.",
    owner: "Integrations desk",
    nextAction: "Ask the team to add the published topic, then refresh the binding.",
  },
  open_synesthesia_reports: {
    area: "synesthesia",
    severity: "attention",
    singular: "Open Synesthesia report",
    plural: "Open Synesthesia reports",
    detail: "A report in the active music window still needs a moderation decision.",
    owner: "Synesthesia moderator",
    nextAction: "Review it through the exact request and report permissions.",
  },
  stale_synesthesia_playback: {
    area: "synesthesia",
    severity: "attention",
    singular: "Playback acknowledgement overdue",
    plural: "Playback acknowledgements overdue",
    detail: "A playing request outlived its track duration and acknowledgement allowance.",
    owner: "Playback operator",
    nextAction: "Confirm whether the track played, was skipped, or needs an incident.",
  },
  synesthesia_playback_conflicts: {
    area: "synesthesia",
    severity: "critical",
    singular: "Conflicting playback state",
    plural: "Conflicting playback states",
    detail: "More than one request is marked as playing in the same active window.",
    owner: "Playback operator",
    nextAction: "Pause playback and reconcile the active request before continuing.",
  },
  synesthesia_playback_paused: {
    area: "synesthesia",
    severity: "watch",
    singular: "Synesthesia playback paused",
    plural: "Synesthesia playback pauses",
    detail: "The active music window is intentionally preventing playback transitions.",
    owner: "Playback operator",
    nextAction: "Leave it paused until the recorded reason is resolved.",
  },
  projection_coverage_limited: {
    area: "system",
    severity: "watch",
    singular: "Health check reached its scan limit",
    plural: "Health checks reached their scan limit",
    detail: "At least one high-volume source needs its focused workspace for a complete view.",
    owner: "Platform operations",
    nextAction: "Open the relevant workspace and review its full paginated queue.",
  },
} satisfies Record<HealthSignalKey, SignalDefinition>;

const severityRank: Record<HealthSeverity, number> = {
  critical: 0,
  attention: 1,
  watch: 2,
};

export function boundedCount(timestamps: readonly number[], maximum = 100,
): BoundedCount {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("The operations health count limit must be a positive integer.",
    );
  }
  const oldestAt = timestamps.length > 0 ? Math.min(...timestamps) : undefined;
  return {
    count: Math.min(timestamps.length, maximum),
    atLeast: timestamps.length > maximum,
    ...(oldestAt !== undefined ? { oldestAt } : {}),
  };
}

export function emptyOperationsHealthCounts(): OperationsHealthCounts {
  const empty = (): BoundedCount => ({ count: 0, atLeast: false });
  return {
    critical_incidents: empty(),
    active_incidents: empty(),
    intake_interpretation_stalls: empty(),
    recent_intake_fallbacks: empty(),
    novelty_preview_stalls: empty(),
    recent_novelty_unavailable: empty(),
    admission_analysis_stalls: empty(),
    recent_admission_fallbacks: empty(),
    active_round_pauses: empty(),
    attendance_job_failures: empty(),
    attendance_job_stalls: empty(),
    round_export_failures: empty(),
    round_export_stalls: empty(),
    emergency_pack_failures: empty(),
    emergency_pack_stalls: empty(),
    panels_needing_reviewer: empty(),
    overdue_reviews: empty(),
    expired_reviewer_pages: empty(),
    stale_reviewer_heartbeats: empty(),
    stale_scanner_stations: empty(),
    scanner_queues_awaiting_replay: empty(),
    participant_delivery_failures: empty(),
    participant_delivery_unknown: empty(),
    participant_delivery_stalls: empty(),
    github_inaccessible_repositories: empty(),
    github_sync_errors: empty(),
    github_sync_stalls: empty(),
    github_rate_limits: empty(),
    github_unverified_topics: empty(),
    open_synesthesia_reports: empty(),
    stale_synesthesia_playback: empty(),
    synesthesia_playback_conflicts: empty(),
    synesthesia_playback_paused: empty(),
    projection_coverage_limited: empty(),
  };
}

export function buildOperationsHealth(counts: OperationsHealthCounts): {
  summary: OperationsHealthSummary;
  signals: OperationsHealthSignal[];
} {
  const signals: OperationsHealthSignal[] = [];
  for (const key of healthSignalKeys) {
    const count = counts[key];
    if (count.count === 0) continue;
    const definition = signalDefinitions[key];
    signals.push({
      key,
      area: definition.area,
      severity: definition.severity,
      title: count.count === 1 && !count.atLeast ? definition.singular : definition.plural,
      detail: definition.detail,
      owner: definition.owner,
      nextAction: definition.nextAction,
      ...count,
    });
  }
  signals.sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      left.title.localeCompare(right.title),
  );
  const criticalSignalCount = signals.filter((signal) => signal.severity === "critical",
  ).length;
  const attentionSignalCount = signals.filter((signal) => signal.severity === "attention",
  ).length;
  const watchSignalCount = signals.filter((signal) => signal.severity === "watch",
  ).length;
  const status: HealthStatus =
    criticalSignalCount > 0
      ? "critical"
      : attentionSignalCount > 0
        ? "attention"
        : watchSignalCount > 0
          ? "watch"
          : "healthy";
  return {
    summary: {
      status,
      signalCount: signals.length,
      criticalSignalCount,
      attentionSignalCount,
      watchSignalCount,
    },
    signals,
  };
}
