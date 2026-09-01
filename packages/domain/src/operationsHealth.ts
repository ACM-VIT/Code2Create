export const operationsHealthSignalKeys = [
  "critical_incidents",
  "active_incidents",
  "intake_interpretation_stalls",
  "recent_intake_fallbacks",
  "novelty_preview_stalls",
  "recent_novelty_unavailable",
  "admission_analysis_stalls",
  "recent_admission_fallbacks",
  "active_round_pauses",
  "attendance_job_failures",
  "attendance_job_stalls",
  "round_export_failures",
  "round_export_stalls",
  "emergency_pack_failures",
  "emergency_pack_stalls",
  "panels_needing_reviewer",
  "stale_reviewer_heartbeats",
  "overdue_reviews",
  "expired_reviewer_pages",
  "stale_scanner_stations",
  "scanner_queues_awaiting_replay",
  "participant_delivery_failures",
  "participant_delivery_unknown",
  "participant_delivery_stalls",
  "github_inaccessible_repositories",
  "github_sync_errors",
  "github_sync_stalls",
  "github_rate_limits",
  "github_unverified_topics",
  "figma_inaccessible_files",
  "figma_sync_errors",
  "figma_sync_stalls",
  "figma_rate_limits",
  "figma_metadata_stale",
  "figma_webhook_errors",
  "figma_webhook_unavailable",
  "open_synesthesia_reports",
  "stale_synesthesia_playback",
  "synesthesia_playback_conflicts",
  "synesthesia_playback_paused",
  "projection_coverage_limited",
] as const;

export type OperationsHealthSignalKey = (typeof operationsHealthSignalKeys)[number];

export const operationsHealthSeverities = ["critical", "attention", "watch"] as const;
export type OperationsHealthSeverity = (typeof operationsHealthSeverities)[number];

export const operationsHealthStatuses = [...operationsHealthSeverities, "healthy"] as const;
export type OperationsHealthStatus = (typeof operationsHealthStatuses)[number];

export const operationsHealthAreas = [
  "system",
  "intake",
  "admissions",
  "attendance",
  "reviews",
  "communications",
  "integrations",
  "scores",
  "synesthesia",
] as const;
export type OperationsHealthArea = (typeof operationsHealthAreas)[number];

export type OperationsHealthSignal = {
  key: OperationsHealthSignalKey;
  area: OperationsHealthArea;
  severity: OperationsHealthSeverity;
  title: string;
  detail: string;
  owner: string;
  nextAction: string;
  count: number;
  atLeast: boolean;
  oldestAt?: number;
};

export type OperationsHealthSummary = {
  status: OperationsHealthStatus;
  signalCount: number;
  criticalSignalCount: number;
  attentionSignalCount: number;
  watchSignalCount: number;
};

export type OperationsHealthSnapshot = {
  generatedAt: number;
  event: {
    slug: string;
    name: string;
    timezone: string;
    status: "draft" | "registration_open" | "registration_closed" | "live" | "complete";
  };
  summary: OperationsHealthSummary;
  signals: OperationsHealthSignal[];
};
