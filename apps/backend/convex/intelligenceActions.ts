"use node";

import OpenAI from "openai";
import { v } from "convex/values";

import { internalAction } from "./_generated/server";
import { ideaQuestionProviderTimeoutMs } from "./lib/ideaSubmissionAi";

const providerFailureState = v.union(
  v.literal("timed_out"),
  v.literal("rate_limited"),
  v.literal("failed"),
);

const providerResult = v.union(
  v.object({
    kind: v.literal("success"),
    outputText: v.union(v.string(), v.null()),
    providerRequestId: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("failure"),
    state: providerFailureState,
    failureCategory: v.string(),
  }),
);

export const requestIdeaQuestion = internalAction({
  args: {
    modelId: v.string(),
    systemInstruction: v.string(),
    input: v.string(),
  },
  returns: providerResult,
  handler: async (_ctx, args) => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return {
        kind: "failure" as const,
        state: "failed" as const,
        failureCategory: "api_key_not_configured",
      };
    }

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
                  anyOf: [
                    {
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
                      },
                      required: ["text", "purposeKey", "answerLength", "sourceAnswerVersionIds"],
                      additionalProperties: false,
                    },
                    { type: "null" },
                  ],
                },
                matchedIdeaPatternKey: {
                  anyOf: [
                    { type: "string", minLength: 1, maxLength: 60 },
                    { type: "null" },
                  ],
                },
                stopReason: {
                  type: "string",
                  enum: ["needs_question", "enough_context", "question_limit"],
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
        kind: "success" as const,
        outputText: response.output_text || null,
        ...(response._request_id ? { providerRequestId: response._request_id } : {}),
      };
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      const timedOut = error instanceof OpenAI.APIConnectionTimeoutError;
      return {
        kind: "failure" as const,
        state: status === 429 ? "rate_limited" as const : timedOut ? "timed_out" as const : "failed" as const,
        failureCategory: status
          ? `provider_http_${status}`
          : timedOut
            ? "provider_request_timed_out"
            : "provider_request_failed",
      };
    }
  },
});
