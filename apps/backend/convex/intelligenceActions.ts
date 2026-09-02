"use node";

import OpenAI from "openai";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { IntakeContext } from "./intelligence";
import { ideaQuestionProviderTimeoutMs } from "./lib/ideaSubmissionAi";
import { parseAndValidateIntakeQuestionModelOutput } from "./lib/intakeQuestionModel";
import {
  captureAiEmbedding,
  captureAiGeneration,
  scheduledAiGenerationTelemetry,
  type AiGenerationTelemetry,
} from "./lib/posthog";
import { redactProjectText } from "./lib/projectText";

type ProviderResult =
  | {
      kind: "success";
      outputText: string | null;
      providerRequestId?: string;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningTokens?: number;
      totalTokens?: number;
    }
  | {
      kind: "failure";
      state: "timed_out" | "rate_limited" | "failed";
      failureCategory: string;
    };

type ProviderRequest = {
  modelId: string;
  systemInstruction: string;
  input: string;
};

const aiCommonArgs = {
  traceId: v.string(),
  sessionId: v.optional(v.string()),
  distinctId: v.optional(v.string()),
  model: v.string(),
  provider: v.string(),
  operation: v.string(),
  durationMs: v.number(),
  isError: v.boolean(),
  errorCategory: v.optional(v.string()),
};

export const captureGenerationTelemetry = internalAction({
  args: {
    ...aiCommonArgs,
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cacheReadTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    finishReason: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    await captureAiGeneration(args);
    return null;
  },
});

export const captureEmbeddingTelemetry = internalAction({
  args: {
    ...aiCommonArgs,
    inputTokens: v.optional(v.number()),
    inputCount: v.number(),
    providerRequestId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    await captureAiEmbedding(args);
    return null;
  },
});

async function scheduleGenerationTelemetry(ctx: ActionCtx, args: AiGenerationTelemetry) {
  await ctx.scheduler.runAfter(
    0,
    internal.intelligenceActions.captureGenerationTelemetry,
    scheduledAiGenerationTelemetry(args),
  );
}

function emptyCompletion() {
  return {
    coveragePurposeKeys: [],
    nextQuestionSourceAnswerVersionIds: [],
  };
}

async function requestIdeaQuestionFromProvider(
  apiKey: string,
  args: ProviderRequest,
): Promise<ProviderResult> {
  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: ideaQuestionProviderTimeoutMs,
  });
  try {
    const response = await client.responses.create({
      model: args.modelId,
      store: false,
      instructions: args.systemInstruction,
      input: args.input,
      text: {
        format: {
          type: "json_schema",
          name: "code2create_intake_interpretation",
          strict: true,
          schema: {
            type: "object",
            properties: {
              coveragePurposeKeys: {
                type: "array",
                items: {
                  type: "string",
                  enum: ["user", "problem", "experience", "event_goal", "tradeoff", "risk"],
                },
                maxItems: 6,
              },
              nextQuestion: {
                type: "object",
                properties: {
                  text: { type: "string", minLength: 8, maxLength: 120 },
                  purposeKey: {
                    type: "string",
                    enum: ["user", "problem", "experience", "event_goal", "tradeoff", "risk"],
                  },
                  answerLength: {
                    type: "string",
                    enum: ["short", "medium"],
                  },
                  sourceAnswerVersionIds: {
                    type: "array",
                    items: { type: "string", minLength: 1, maxLength: 200 },
                    minItems: 1,
                    maxItems: 3,
                  },
                  groundingTerms: {
                    type: "array",
                    items: { type: "string", minLength: 2, maxLength: 40 },
                    minItems: 1,
                    maxItems: 3,
                  },
                },
                required: [
                  "text",
                  "purposeKey",
                  "answerLength",
                  "sourceAnswerVersionIds",
                  "groundingTerms",
                ],
                additionalProperties: false,
              },
              matchedIdeaPatternKey: {
                anyOf: [
                  { type: "string", minLength: 1, maxLength: 60 },
                  { type: "null" },
                ],
              },
              stopReason: {
                type: "string",
                enum: ["needs_question"],
              },
            },
            required: [
              "coveragePurposeKeys",
              "nextQuestion",
              "matchedIdeaPatternKey",
              "stopReason",
            ],
            additionalProperties: false,
          },
        },
      },
    });
    return {
      kind: "success",
      outputText: response.output_text || null,
      ...(response._request_id ? { providerRequestId: response._request_id } : {}),
      ...(response.usage?.input_tokens !== undefined
        ? { inputTokens: response.usage.input_tokens }
        : {}),
      ...(response.usage?.output_tokens !== undefined
        ? { outputTokens: response.usage.output_tokens }
        : {}),
      ...(response.usage?.input_tokens_details?.cached_tokens !== undefined
        ? { cachedInputTokens: response.usage.input_tokens_details.cached_tokens }
        : {}),
      ...(response.usage?.output_tokens_details?.reasoning_tokens !== undefined
        ? { reasoningTokens: response.usage.output_tokens_details.reasoning_tokens }
        : {}),
      ...(response.usage?.total_tokens !== undefined
        ? { totalTokens: response.usage.total_tokens }
        : {}),
    };
  } catch (error) {
    const status = error instanceof OpenAI.APIError ? error.status : undefined;
    const timedOut = error instanceof OpenAI.APIConnectionTimeoutError;
    return {
      kind: "failure",
      state: status === 429 ? "rate_limited" : timedOut ? "timed_out" : "failed",
      failureCategory: status
        ? `provider_http_${status}`
        : timedOut
          ? "provider_request_timed_out"
          : "provider_request_failed",
    };
  }
}

export const interpretIdea = internalAction({
  args: { draftId: v.id("projectDrafts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const context: IntakeContext | null = await ctx.runMutation(
      internal.intelligence.beginIntakeInterpretation,
      {
        draftId: args.draftId,
        provider: apiKey
          ? { kind: "available" }
          : { kind: "unavailable", reason: "api_key_not_configured" },
      },
    );
    if (!context || !apiKey) return null;

    const startedAt = Date.now();
    try {
      const provider = await requestIdeaQuestionFromProvider(apiKey, {
        modelId: context.modelId,
        systemInstruction: context.systemInstruction,
        input: JSON.stringify({
          questionOrdinal: context.ordinal,
          answers: context.answers.map((answer) => ({
            answerVersionId: answer.id,
            promptKey: answer.promptKey,
            text: redactProjectText(answer.value),
          })),
          priorQuestions: context.previousQuestions,
          allowedPurposeKeys: context.allowedPurposeKeys,
          commonIdeaPatterns: context.commonIdeaPatterns,
        }),
      });
      if (provider.kind === "failure") {
        await ctx.runMutation(internal.intelligence.finishIntakeInterpretation, {
          interpretationId: context.interpretationId,
          inputFingerprint: context.inputFingerprint,
          state: provider.state,
          ...emptyCompletion(),
          latencyMs: Date.now() - startedAt,
          failureCategory: provider.failureCategory,
        });
        await scheduleGenerationTelemetry(ctx, {
          traceId: context.interpretationId,
          sessionId: context.draftId,
          model: context.modelId,
          provider: "openai",
          operation: "intake.interpret_idea",
          durationMs: Date.now() - startedAt,
          isError: true,
          errorCategory: provider.failureCategory,
        });
        return null;
      }
      const validated = provider.outputText
        ? parseAndValidateIntakeQuestionModelOutput(provider.outputText, context)
        : null;
      if (!validated) {
        await ctx.runMutation(internal.intelligence.finishIntakeInterpretation, {
          interpretationId: context.interpretationId,
          inputFingerprint: context.inputFingerprint,
          state: provider.outputText ? "invalid" : "refused",
          ...emptyCompletion(),
          ...(provider.providerRequestId
            ? { providerRequestId: provider.providerRequestId }
            : {}),
          latencyMs: Date.now() - startedAt,
          failureCategory: provider.outputText
            ? "invalid_or_disallowed_output"
            : "empty_or_refused_output",
        });
        const failureCategory = provider.outputText
          ? "invalid_or_disallowed_output"
          : "empty_or_refused_output";
        await scheduleGenerationTelemetry(ctx, {
          traceId: context.interpretationId,
          sessionId: context.draftId,
          model: context.modelId,
          provider: "openai",
          operation: "intake.interpret_idea",
          durationMs: Date.now() - startedAt,
          isError: true,
          errorCategory: failureCategory,
          inputTokens: provider.inputTokens,
          outputTokens: provider.outputTokens,
          cacheReadTokens: provider.cachedInputTokens,
          reasoningTokens: provider.reasoningTokens,
          totalTokens: provider.totalTokens,
          providerRequestId: provider.providerRequestId,
        });
        return null;
      }
      await ctx.runMutation(internal.intelligence.finishIntakeInterpretation, {
        interpretationId: context.interpretationId,
        inputFingerprint: context.inputFingerprint,
        state: "succeeded",
        ...validated,
        ...(provider.providerRequestId
          ? { providerRequestId: provider.providerRequestId }
          : {}),
        latencyMs: Date.now() - startedAt,
      });
      await scheduleGenerationTelemetry(ctx, {
        traceId: context.interpretationId,
        sessionId: context.draftId,
        model: context.modelId,
        provider: "openai",
        operation: "intake.interpret_idea",
        durationMs: Date.now() - startedAt,
        isError: false,
        inputTokens: provider.inputTokens,
        outputTokens: provider.outputTokens,
        cacheReadTokens: provider.cachedInputTokens,
        reasoningTokens: provider.reasoningTokens,
        totalTokens: provider.totalTokens,
        finishReason: "stop",
        providerRequestId: provider.providerRequestId,
      });
    } catch {
      await ctx.runMutation(internal.intelligence.finishIntakeInterpretation, {
        interpretationId: context.interpretationId,
        inputFingerprint: context.inputFingerprint,
        state: "failed",
        ...emptyCompletion(),
        latencyMs: Date.now() - startedAt,
        failureCategory: "provider_action_failed",
      });
      await scheduleGenerationTelemetry(ctx, {
        traceId: context.interpretationId,
        sessionId: context.draftId,
        model: context.modelId,
        provider: "openai",
        operation: "intake.interpret_idea",
        durationMs: Date.now() - startedAt,
        isError: true,
        errorCategory: "provider_action_failed",
      });
    }
    return null;
  },
});
