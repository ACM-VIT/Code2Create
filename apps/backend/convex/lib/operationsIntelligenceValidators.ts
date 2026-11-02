import { v } from "convex/values";
import { operationsIntelligenceProtocolVersion } from "@code2create/domain";

export const operationsHealthSignalKey = v.union(
  v.literal("critical_incidents"),
  v.literal("active_incidents"),
  v.literal("intake_interpretation_stalls"),
  v.literal("recent_intake_fallbacks"),
  v.literal("novelty_preview_stalls"),
  v.literal("recent_novelty_unavailable"),
  v.literal("admission_analysis_stalls"),
  v.literal("recent_admission_fallbacks"),
  v.literal("active_round_pauses"),
  v.literal("attendance_job_failures"),
  v.literal("attendance_job_stalls"),
  v.literal("round_export_failures"),
  v.literal("round_export_stalls"),
  v.literal("emergency_pack_failures"),
  v.literal("emergency_pack_stalls"),
  v.literal("panels_needing_reviewer"),
  v.literal("overdue_reviews"),
  v.literal("expired_reviewer_pages"),
  // Nothing emits it; kept so stored snapshots and briefs stay readable.
  v.literal("stale_reviewer_heartbeats"),
  v.literal("stale_scanner_stations"),
  v.literal("scanner_queues_awaiting_replay"),
  v.literal("participant_delivery_failures"),
  v.literal("participant_delivery_unknown"),
  v.literal("participant_delivery_stalls"),
  v.literal("github_inaccessible_repositories"),
  v.literal("github_sync_errors"),
  v.literal("github_sync_stalls"),
  v.literal("github_rate_limits"),
  v.literal("github_unverified_topics"),
  v.literal("open_synesthesia_reports"),
  v.literal("stale_synesthesia_playback"),
  v.literal("synesthesia_playback_conflicts"),
  v.literal("synesthesia_playback_paused"),
  v.literal("projection_coverage_limited"),
);

export const operationsHealthSeverity = v.union(
  v.literal("critical"),
  v.literal("attention"),
  v.literal("watch"),
);

export const operationsHealthStatus = v.union(operationsHealthSeverity, v.literal("healthy"));

export const operationsHealthArea = v.union(
  v.literal("system"),
  v.literal("intake"),
  v.literal("admissions"),
  v.literal("attendance"),
  v.literal("reviews"),
  v.literal("communications"),
  v.literal("integrations"),
  v.literal("scores"),
  v.literal("synesthesia"),
);

export const operationsHealthSignal = v.object({
  key: operationsHealthSignalKey,
  area: operationsHealthArea,
  severity: operationsHealthSeverity,
  title: v.string(),
  detail: v.string(),
  owner: v.string(),
  nextAction: v.string(),
  count: v.number(),
  atLeast: v.boolean(),
  oldestAt: v.optional(v.number()),
});

export const operationsHealthSnapshot = v.object({
  generatedAt: v.number(),
  event: v.object({
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
  }),
  summary: v.object({
    status: operationsHealthStatus,
    signalCount: v.number(),
    criticalSignalCount: v.number(),
    attentionSignalCount: v.number(),
    watchSignalCount: v.number(),
  }),
  signals: v.array(operationsHealthSignal),
});

export const operationsHealthSnapshotState = v.union(
  v.object({ state: v.literal("missing") }),
  v.object({ state: v.literal("stale"), lastGeneratedAt: v.number() }),
  v.object({ state: v.literal("ready"), snapshot: operationsHealthSnapshot }),
);

export const operationsBriefPriority = v.object({
  severity: operationsHealthSeverity,
  title: v.string(),
  why: v.string(),
  owner: v.string(),
  nextAction: v.string(),
  signalKeys: v.array(operationsHealthSignalKey),
});

const operationsIntelligenceCallbackBase = {
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  briefId: v.string(),
  sourceChecksum: v.string(),
  agentVersion: v.string(),
  model: v.string(),
  completedAt: v.number(),
};

export const operationsIntelligenceCallback = v.union(
  v.object({
    ...operationsIntelligenceCallbackBase,
    status: v.literal("succeeded"),
    headline: v.string(),
    summary: v.string(),
    priorities: v.array(operationsBriefPriority),
  }),
  v.object({
    ...operationsIntelligenceCallbackBase,
    status: v.literal("failed"),
    failureCode: v.union(v.literal("model_did_not_publish"), v.literal("callback_rejected")),
  }),
);
