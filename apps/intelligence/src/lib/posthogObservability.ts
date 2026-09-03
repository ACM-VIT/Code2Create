import { observe, type FlueObservation } from "@flue/runtime";
import { PostHog } from "posthog-node/edge";

type SafeProperties = Record<string, string | number | boolean>;

let client: PostHog | null | undefined;
let warnedAboutDelivery = false;
const buildReleaseId = import.meta.env.VITE_RELEASE_ID?.trim();

export function postHogIntelligenceObservabilityConfigured(env: Cloudflare.Env) {
  if (!env.POSTHOG_PROJECT_TOKEN?.trim() || !env.POSTHOG_HOST?.trim()) return false;
  try {
    return new URL(env.POSTHOG_HOST).protocol === "https:";
  } catch {
    return false;
  }
}

function configuredClient(env: Cloudflare.Env) {
  if (client !== undefined) return client;
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  const host = env.POSTHOG_HOST?.trim();
  if (!token || !host) {
    client = null;
    return client;
  }
  const parsedHost = new URL(host);
  if (parsedHost.protocol !== "https:") {
    throw new Error("POSTHOG_HOST must use HTTPS.");
  }
  client = new PostHog(token, {
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

function commonProperties(env: Cloudflare.Env): SafeProperties {
  return {
    c2c_environment: env.C2C_DEPLOYMENT_ENVIRONMENT?.trim() || "development",
    c2c_release: env.C2C_RELEASE_ID?.trim() || buildReleaseId || "development",
    c2c_service: "intelligence-worker",
    $process_person_profile: false,
    $geoip_disable: true,
  };
}

function optionalProperty(key: string, value: string | number | undefined): SafeProperties {
  return value === undefined || value === "" ? {} : { [key]: value };
}

function correlation(event: FlueObservation) {
  const traceId =
    event.submissionId ??
    event.conversationId ??
    event.operationId ??
    event.turnId ??
    `${event.agentName ?? "agent"}:${event.eventIndex}`;
  return {
    traceId,
    distinctId: event.instanceId ?? event.conversationId ?? "code2create-intelligence",
    sessionId: event.conversationId ?? event.instanceId,
  };
}

function eventProperties(env: Cloudflare.Env, event: FlueObservation): SafeProperties {
  const { traceId, sessionId } = correlation(event);
  return {
    ...commonProperties(env),
    $ai_trace_id: traceId,
    ...optionalProperty("$ai_session_id", sessionId),
    ...optionalProperty("c2c_agent", event.agentName),
    ...optionalProperty("c2c_harness", event.harness),
  };
}

async function deliver(
  env: Cloudflare.Env,
  event: string,
  distinctId: string,
  properties: SafeProperties,
  ai: boolean,
) {
  try {
    const posthog = configuredClient(env);
    if (!posthog) return;
    if (ai) {
      await posthog.captureAiImmediate({
        distinctId,
        event,
        properties,
        disableGeoip: true,
      });
      return;
    }
    await posthog.captureImmediate({
      distinctId,
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

export function captureIntelligenceRequest(
  env: Cloudflare.Env,
  args: {
    method: string;
    route: string;
    status: number;
    durationMs: number;
  },
) {
  return deliver(
    env,
    "c2c_server_request",
    "code2create-intelligence",
    {
      ...commonProperties(env),
      c2c_method: args.method,
      c2c_route: args.route,
      c2c_status: args.status,
      c2c_duration_ms: Math.max(0, args.durationMs),
      c2c_ok: args.status < 500,
    },
    false,
  );
}

export function captureIntelligenceFailure(env: Cloudflare.Env, code: string) {
  return deliver(
    env,
    "c2c_server_failure",
    "code2create-intelligence",
    {
      ...commonProperties(env),
      c2c_error_code: code,
    },
    false,
  );
}

function observeTurn(env: Cloudflare.Env, event: Extract<FlueObservation, { type: "turn" }>) {
  const usage = event.response.usage;
  const { distinctId } = correlation(event);
  return deliver(
    env,
    "$ai_generation",
    distinctId,
    {
      ...eventProperties(env, event),
      $ai_model: event.request.requestedModel,
      $ai_provider: event.request.providerName,
      $ai_span_name: `${event.agentName ?? "agent"}.${event.purpose}`,
      $ai_latency: Math.max(0, event.durationMs) / 1_000,
      $ai_is_error: event.isError,
      ...optionalProperty("$ai_input_tokens", usage?.input),
      ...optionalProperty("$ai_output_tokens", usage?.output),
      ...optionalProperty("$ai_cache_read_input_tokens", usage?.cacheRead),
      ...optionalProperty("$ai_cache_creation_input_tokens", usage?.cacheWrite),
      ...optionalProperty("$ai_total_tokens", usage?.totalTokens),
      ...optionalProperty("$ai_total_cost_usd", usage?.cost.total),
      ...optionalProperty("$ai_finish_reason", event.response.finishReason),
      ...optionalProperty("$ai_request_id", event.response.responseId),
      ...optionalProperty("c2c_response_model", event.response.responseModel),
      ...optionalProperty("c2c_provider_finish_reason", event.response.providerFinishReason),
    },
    true,
  );
}

function observeTool(env: Cloudflare.Env, event: Extract<FlueObservation, { type: "tool" }>) {
  const { distinctId } = correlation(event);
  return deliver(
    env,
    "$ai_span",
    distinctId,
    {
      ...eventProperties(env, event),
      $ai_span_id: event.toolCallId,
      $ai_span_name: `tool.${event.toolName}`,
      $ai_latency: Math.max(0, event.durationMs) / 1_000,
      $ai_is_error: event.isError,
    },
    true,
  );
}

function safeLogCode(message: string) {
  return /^[A-Za-z0-9_.:-]{1,80}$/u.test(message) ? message : "structured_log";
}

function observeEvent(env: Cloudflare.Env, event: FlueObservation) {
  if (event.type === "turn") return observeTurn(env, event);
  if (event.type === "tool") return observeTool(env, event);
  const { distinctId } = correlation(event);
  if (event.type === "submission_settled") {
    return deliver(
      env,
      "c2c_intelligence_submission_settled",
      distinctId,
      {
        ...eventProperties(env, event),
        c2c_outcome: event.outcome,
        c2c_is_error: event.outcome !== "completed",
      },
      false,
    );
  }
  if (event.type === "log") {
    return deliver(
      env,
      "c2c_intelligence_log",
      distinctId,
      {
        ...eventProperties(env, event),
        c2c_log_level: event.level,
        c2c_log_code: safeLogCode(event.message),
      },
      false,
    );
  }
}

export function installPostHogIntelligenceObservability(env: Cloudflare.Env) {
  observe((event) => observeEvent(env, event));
}
