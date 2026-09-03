import { PostHog } from "posthog-node/edge";

type TelemetryProperties = Record<string, string | number | boolean>;

type AiCommon = {
  traceId: string;
  sessionId?: string | undefined;
  distinctId?: string | undefined;
  model: string;
  provider: string;
  operation: string;
  durationMs: number;
  isError: boolean;
  errorCategory?: string | undefined;
};

export type AiGenerationTelemetry = AiCommon & {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  totalTokens?: number | undefined;
  finishReason?: string | undefined;
  providerRequestId?: string | undefined;
};

export type AiEmbeddingTelemetry = AiCommon & {
  inputTokens?: number | undefined;
  inputCount: number;
  providerRequestId?: string | undefined;
};

export function scheduledAiGenerationTelemetry(args: AiGenerationTelemetry) {
  return {
    traceId: args.traceId,
    model: args.model,
    provider: args.provider,
    operation: args.operation,
    durationMs: args.durationMs,
    isError: args.isError,
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    ...(args.distinctId !== undefined ? { distinctId: args.distinctId } : {}),
    ...(args.errorCategory !== undefined ? { errorCategory: args.errorCategory } : {}),
    ...(args.inputTokens !== undefined ? { inputTokens: args.inputTokens } : {}),
    ...(args.outputTokens !== undefined ? { outputTokens: args.outputTokens } : {}),
    ...(args.cacheReadTokens !== undefined ? { cacheReadTokens: args.cacheReadTokens } : {}),
    ...(args.cacheWriteTokens !== undefined ? { cacheWriteTokens: args.cacheWriteTokens } : {}),
    ...(args.reasoningTokens !== undefined ? { reasoningTokens: args.reasoningTokens } : {}),
    ...(args.totalTokens !== undefined ? { totalTokens: args.totalTokens } : {}),
    ...(args.finishReason !== undefined ? { finishReason: args.finishReason } : {}),
    ...(args.providerRequestId !== undefined ? { providerRequestId: args.providerRequestId } : {}),
  };
}

export function scheduledAiEmbeddingTelemetry(args: AiEmbeddingTelemetry) {
  return {
    traceId: args.traceId,
    model: args.model,
    provider: args.provider,
    operation: args.operation,
    durationMs: args.durationMs,
    isError: args.isError,
    inputCount: args.inputCount,
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    ...(args.distinctId !== undefined ? { distinctId: args.distinctId } : {}),
    ...(args.errorCategory !== undefined ? { errorCategory: args.errorCategory } : {}),
    ...(args.inputTokens !== undefined ? { inputTokens: args.inputTokens } : {}),
    ...(args.providerRequestId !== undefined ? { providerRequestId: args.providerRequestId } : {}),
  };
}

let client: PostHog | null | undefined;
let warnedAboutDelivery = false;

function configuredClient() {
  if (client !== undefined) return client;
  const projectToken = process.env.POSTHOG_PROJECT_TOKEN?.trim();
  const host = process.env.POSTHOG_HOST?.trim();
  if (!projectToken || !host) {
    client = null;
    return client;
  }
  const parsedHost = new URL(host);
  if (parsedHost.protocol !== "https:") {
    throw new Error("POSTHOG_HOST must use HTTPS.");
  }
  client = new PostHog(projectToken, {
    host: parsedHost.origin,
    flushAt: 1,
    flushInterval: 0,
    persistence: "memory",
    privacyMode: true,
    enableExceptionAutocapture: false,
    requestTimeout: 3_000,
  });
  return client;
}

function commonProperties(): TelemetryProperties {
  return {
    c2c_environment: process.env.C2C_DEPLOYMENT_ENVIRONMENT?.trim() || "development",
    c2c_release: process.env.C2C_RELEASE_ID?.trim() || "development",
    c2c_service: "convex-backend",
    $process_person_profile: false,
    $geoip_disable: true,
  };
}

function finiteNonNegative(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalProperty(key: string, value: string | number | undefined): TelemetryProperties {
  return value === undefined || value === "" ? {} : { [key]: value };
}

export function aiGenerationProperties(args: AiGenerationTelemetry): TelemetryProperties {
  return {
    ...commonProperties(),
    $ai_trace_id: args.traceId,
    ...optionalProperty("$ai_session_id", args.sessionId),
    $ai_model: args.model,
    $ai_provider: args.provider,
    $ai_span_name: args.operation,
    $ai_latency: Math.max(0, args.durationMs) / 1_000,
    $ai_is_error: args.isError,
    ...optionalProperty("$ai_error", args.errorCategory),
    ...optionalProperty("$ai_input_tokens", finiteNonNegative(args.inputTokens)),
    ...optionalProperty("$ai_output_tokens", finiteNonNegative(args.outputTokens)),
    ...optionalProperty("$ai_cache_read_input_tokens", finiteNonNegative(args.cacheReadTokens)),
    ...optionalProperty(
      "$ai_cache_creation_input_tokens",
      finiteNonNegative(args.cacheWriteTokens),
    ),
    ...optionalProperty("$ai_reasoning_tokens", finiteNonNegative(args.reasoningTokens)),
    ...optionalProperty("$ai_total_tokens", finiteNonNegative(args.totalTokens)),
    ...optionalProperty("$ai_finish_reason", args.finishReason),
    ...optionalProperty("$ai_request_id", args.providerRequestId),
  };
}

export function aiEmbeddingProperties(args: AiEmbeddingTelemetry): TelemetryProperties {
  return {
    ...commonProperties(),
    $ai_trace_id: args.traceId,
    ...optionalProperty("$ai_session_id", args.sessionId),
    $ai_model: args.model,
    $ai_provider: args.provider,
    $ai_span_name: args.operation,
    $ai_latency: Math.max(0, args.durationMs) / 1_000,
    $ai_is_error: args.isError,
    ...optionalProperty("$ai_error", args.errorCategory),
    ...optionalProperty("$ai_input_tokens", finiteNonNegative(args.inputTokens)),
    ...optionalProperty("$ai_request_id", args.providerRequestId),
    c2c_input_count: args.inputCount,
  };
}

async function deliver(
  event: "$ai_generation" | "$ai_embedding",
  distinctId: string | undefined,
  properties: TelemetryProperties,
) {
  try {
    await configuredClient()?.captureAiImmediate({
      distinctId: distinctId ?? "code2create-system",
      event,
      properties,
      disableGeoip: true,
    });
  } catch {
    if (!warnedAboutDelivery) {
      warnedAboutDelivery = true;
      console.warn("PostHog telemetry delivery failed.");
    }
  }
}

export function captureAiGeneration(args: AiGenerationTelemetry) {
  return deliver("$ai_generation", args.distinctId, aiGenerationProperties(args));
}

export function captureAiEmbedding(args: AiEmbeddingTelemetry) {
  return deliver("$ai_embedding", args.distinctId, aiEmbeddingProperties(args));
}
