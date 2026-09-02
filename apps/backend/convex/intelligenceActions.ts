"use node";

import OpenAI from "openai";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { IntakeContext } from "./intelligence";
import { ideaQuestionProviderTimeoutMs } from "./lib/ideaSubmissionAi";
import { parseAndValidateIntakeQuestionModelOutput } from "./lib/intakeQuestionModel";
import { redactProjectText } from "./lib/projectText";

type ProviderResult =
  | {
      kind: "success";
      outputText: string | null;
      providerRequestId?: string;
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
    } catch {
      await ctx.runMutation(internal.intelligence.finishIntakeInterpretation, {
        interpretationId: context.interpretationId,
        inputFingerprint: context.inputFingerprint,
        state: "failed",
        ...emptyCompletion(),
        latencyMs: Date.now() - startedAt,
        failureCategory: "provider_action_failed",
      });
    }
    return null;
  },
});
