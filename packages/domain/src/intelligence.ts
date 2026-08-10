export const operationsHealthSignalKeys = [
  "critical_incidents",
  "active_incidents",
  "intake_interpretation_stalls",
  "recent_intake_fallbacks",
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

export const operationsBriefPrioritySeverities = ["critical", "attention", "watch"] as const;
export type OperationsBriefPrioritySeverity =
  (typeof operationsBriefPrioritySeverities)[number];

export type OperationsBriefPriority = {
  severity: OperationsBriefPrioritySeverity;
  title: string;
  why: string;
  owner: string;
  nextAction: string;
  signalKeys: OperationsHealthSignalKey[];
};

export const operationsIntelligenceProtocolVersion = "2026-08-07" as const;
export const operationsIntelligenceIngressSignatureContext =
  "code2create.operations-intelligence.ingress.v1";
export const operationsIntelligenceCallbackSignatureContext =
  "code2create.operations-intelligence.callback.v1";
// Each signed boundary gets its own context so a body captured on one route can
// never replay on another, even where two routes share a direction and secret.
export const operationsIntelligenceReadSignatureContext =
  "code2create.operations-intelligence.read.v1";
export const operationsCopilotIngressSignatureContext =
  "code2create.operations-copilot.ingress.v1";
export const operationsCopilotRecommendationSignatureContext =
  "code2create.operations-copilot.recommendation.v1";

/**
 * The whitelist of named reads the intelligence Worker may ask Convex for.
 * The copilot never executes a query of its own composition: it names one of
 * these and Convex runs its own redacted projection. Adding a read means
 * adding it here, to the Convex endpoint, and to the Worker's schema for it.
 */
export const operationsIntelligenceReadNames = [
  "operations_health",
  "operations_attention",
  "review_rounds",
  "review_exceptions",
  "attendance_counts",
  "floor_mapping_progress",
  "support_load",
  "recommendation_history",
] as const;
export type OperationsIntelligenceReadName =
  (typeof operationsIntelligenceReadNames)[number];

export type OperationsIntelligenceReadRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  read: OperationsIntelligenceReadName;
  eventSlug: string;
};

/**
 * The action kinds the copilot may propose. Every kind maps onto one existing
 * operator mutation, so approval executes the ordinary command under the
 * approving operator's own grants — the agent holds no authority of its own.
 */
export const intelligenceRecommendationKinds = [
  "hold_review_team",
  "page_reserve_reviewer",
  "open_support_case",
  "dismiss_attention_item",
] as const;
export type IntelligenceRecommendationKind =
  (typeof intelligenceRecommendationKinds)[number];

export const intelligenceRecommendationStatuses = [
  "proposed",
  "approved",
  "rejected",
  "superseded",
] as const;
export type IntelligenceRecommendationStatus =
  (typeof intelligenceRecommendationStatuses)[number];

/**
 * What the agent read before proposing: the read it came from, the read's own
 * generation time, and the row keys inside it that carry the evidence. A
 * recommendation without at least one citation is rejected at the boundary.
 */
export type IntelligenceRecommendationCitation = {
  read: OperationsIntelligenceReadName;
  generatedAt: number;
  keys: string[];
};

export type OperationsIntelligenceRequest = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  briefId: string;
  sourceChecksum: string;
  snapshot: OperationsHealthSnapshot;
};

type OperationsIntelligenceCallbackBase = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  briefId: string;
  sourceChecksum: string;
  agentVersion: string;
  model: string;
  completedAt: number;
};

export type OperationsIntelligenceSuccess = OperationsIntelligenceCallbackBase & {
  status: "succeeded";
  headline: string;
  summary: string;
  priorities: OperationsBriefPriority[];
};

export type OperationsIntelligenceFailure = OperationsIntelligenceCallbackBase & {
  status: "failed";
  failureCode: "model_did_not_publish" | "callback_rejected";
};

export type OperationsIntelligenceCallback =
  | OperationsIntelligenceSuccess
  | OperationsIntelligenceFailure;

const encoder = new TextEncoder();

function signatureInput(context: string, timestamp: string, body: string) {
  return `${context}\n${timestamp}\n${body}`;
}

function bytesToHex(bytes: Uint8Array) {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function hexToBytes(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = value.slice(index * 2, index * 2 + 2);
    const parsed = Number.parseInt(pair, 16);
    if (!Number.isFinite(parsed)) return null;
    bytes[index] = parsed;
  }
  return bytes;
}

export async function signServiceBody(args: {
  context: string;
  secret: string;
  timestamp: string;
  body: string;
}) {
  if (args.secret.length < 32) throw new Error("Service signing secrets must be at least 32 characters.");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(args.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signatureInput(args.context, args.timestamp, args.body)),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyServiceBody(args: {
  context: string;
  secret: string;
  timestamp: string;
  signature: string;
  body: string;
  now: number;
  maximumAgeMs: number;
}) {
  const timestamp = Number(args.timestamp);
  if (
    !Number.isSafeInteger(timestamp) ||
    args.maximumAgeMs <= 0 ||
    Math.abs(args.now - timestamp) > args.maximumAgeMs
  ) {
    return false;
  }
  const provided = hexToBytes(args.signature);
  if (!provided) return false;
  const expectedHex = await signServiceBody(args);
  const expected = hexToBytes(expectedHex);
  if (!expected || expected.length !== provided.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const expectedByte = expected[index];
    const providedByte = provided[index];
    if (expectedByte === undefined || providedByte === undefined) return false;
    difference |= expectedByte ^ providedByte;
  }
  return difference === 0;
}
