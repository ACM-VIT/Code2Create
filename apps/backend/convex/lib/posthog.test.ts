import { afterEach, describe, expect, it, vi } from "vitest";

import {
  aiEmbeddingProperties,
  aiGenerationProperties,
  scheduledAiEmbeddingTelemetry,
  scheduledAiGenerationTelemetry,
} from "./posthog";

afterEach(() => vi.unstubAllEnvs());

describe("PostHog AI event projections", () => {
  it("captures generation usage without prompt or output content", () => {
    vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", "staging");
    vi.stubEnv("C2C_RELEASE_ID", "release-17");
    const properties = aiGenerationProperties({
      traceId: "trace-1",
      sessionId: "session-1",
      distinctId: "person-1",
      model: "gpt-5.6-terra",
      provider: "openai",
      operation: "participant_assistant.reply",
      durationMs: 1_250,
      isError: false,
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 5,
      reasoningTokens: 2,
      totalTokens: 28,
      finishReason: "stop",
    });

    expect(properties).toMatchObject({
      c2c_environment: "staging",
      c2c_release: "release-17",
      c2c_service: "convex-backend",
      $ai_trace_id: "trace-1",
      $ai_session_id: "session-1",
      $ai_model: "gpt-5.6-terra",
      $ai_input_tokens: 20,
      $ai_output_tokens: 8,
      $ai_latency: 1.25,
      $ai_is_error: false,
    });
    expect(properties).not.toHaveProperty("$ai_input");
    expect(properties).not.toHaveProperty("$ai_output");
  });

  it("captures embedding cardinality and drops invalid token counts", () => {
    const properties = aiEmbeddingProperties({
      traceId: "trace-2",
      model: "text-embedding-3-small",
      provider: "openai",
      operation: "novelty.preview",
      durationMs: 300,
      isError: true,
      errorCategory: "provider_timed_out",
      inputTokens: Number.NaN,
      inputCount: 4,
    });
    expect(properties.c2c_input_count).toBe(4);
    expect(properties.$ai_error).toBe("provider_timed_out");
    expect(properties).not.toHaveProperty("$ai_input_tokens");
  });

  it("removes undefined fields before scheduling a Convex telemetry action", () => {
    const generation = scheduledAiGenerationTelemetry({
      traceId: "trace-3",
      sessionId: undefined,
      model: "gpt-5.6-terra",
      provider: "openai",
      operation: "intake.interpret_idea",
      durationMs: 400,
      isError: false,
      inputTokens: undefined,
    });
    const embedding = scheduledAiEmbeddingTelemetry({
      traceId: "trace-4",
      distinctId: undefined,
      model: "text-embedding-3-small",
      provider: "openai",
      operation: "novelty.preview",
      durationMs: 220,
      isError: false,
      inputCount: 1,
    });

    expect(generation).not.toHaveProperty("sessionId");
    expect(generation).not.toHaveProperty("inputTokens");
    expect(embedding).not.toHaveProperty("distinctId");
  });
});
