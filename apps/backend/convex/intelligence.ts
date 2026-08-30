import OpenAI from "openai";
import { v, type Infer } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalAction, internalMutation } from "./_generated/server";
import {
  fallbackForOrdinal,
  requirePinnedIntakePolicy,
  type IntakePolicy,
  validateGeneratedIntakeQuestion,
} from "./lib/intakePolicy";
import {
  ideaQuestionModelId,
  ideaQuestionSystemInstruction,
  isBroadIdeaQuestion,
} from "./lib/ideaSubmissionAi";
import {
  createIntakeQuestion,
  intakeInputFingerprint,
  loadActiveIntakeAnswers,
  loadCurrentIntakeResponses,
  nextQuestionOrdinal,
} from "./lib/intakeQuestions";
import { redactProjectText } from "./lib/projectText";
import { appendIntakeJobReadFactById } from "./lib/operationsAutonomyReadFacts/intakeJobs";
import { intakeAnswerLength, intakeQuestionPurpose } from "./values";

const sourceAnswer = v.object({
  id: v.id("intakeAnswerVersions"),
  promptKey: v.string(),
  value: v.string(),
});

const intakeContext = v.object({
  interpretationId: v.id("intakeInterpretations"),
  draftId: v.id("projectDrafts"),
  inputFingerprint: v.string(),
  ordinal: v.number(),
  minimumFollowUpCount: v.number(),
  modelId: v.string(),
  systemInstruction: v.string(),
  questionMaxLength: v.number(),
  allowedPurposeKeys: v.array(intakeQuestionPurpose),
  blockedTerms: v.array(v.string()),
  answers: v.array(sourceAnswer),
  previousQuestions: v.array(v.string()),
  commonIdeaPatterns: v.array(
    v.object({
      stableKey: v.string(),
      description: v.string(),
      supportiveQuestionGuidance: v.string(),
    }),
  ),
});

type IntakeContext = Infer<typeof intakeContext>;

async function applyDeterministicPath(
  ctx: MutationCtx,
  args: {
    draft: Doc<"projectDrafts">;
    policy: Doc<"intakePolicyVersions">;
    normalizedPolicy: IntakePolicy;
    ordinal: number;
    sourceAnswerVersionIds: Id<"intakeAnswerVersions">[];
    interpretationId: Id<"intakeInterpretations">;
    now: number;
  },
) {
  const shouldAsk = args.ordinal <= args.normalizedPolicy.deterministicFollowUpCount;
  let questionId: Id<"intakeGeneratedQuestions"> | null = null;
  if (shouldAsk) {
    const fallback = fallbackForOrdinal(args.normalizedPolicy, args.ordinal);
    questionId = await createIntakeQuestion(ctx, {
        draft: args.draft,
        policy: args.policy,
        ordinal: args.ordinal,
        text: fallback.text,
        purposeKey: fallback.purposeKey,
        answerLength: fallback.answerLength,
        source: "fallback",
        sourceAnswerVersionIds: args.sourceAnswerVersionIds,
        interpretationId: args.interpretationId,
        validationCategory: "published_fallback",
        now: args.now,
      });
  }
  const stage = questionId ? "follow_up" as const : "review" as const;
  if (questionId || stage !== args.draft.stage) {
    await ctx.db.patch(args.draft._id, {
      stage,
      version: args.draft.version + 1,
      updatedAt: args.now,
    });
  }
  return questionId;
}

export const beginIntakeInterpretation = internalMutation({
  args: {
    draftId: v.id("projectDrafts"),
    providerAvailable: v.boolean(),
  },
  returns: v.union(v.null(), intakeContext),
  handler: async (ctx, args): Promise<IntakeContext | null> => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft?.initialIdea || draft.stage === "submitted") return null;
    const [{ policy, normalized }, responses, answers] = await Promise.all([
      requirePinnedIntakePolicy(ctx, draft),
      loadCurrentIntakeResponses(ctx, draft._id),
      loadActiveIntakeAnswers(ctx, draft._id),
    ]);
    const ordinal = nextQuestionOrdinal(responses);
    if (ordinal === null) return null;
    if (ordinal > normalized.maximumFollowUpCount) {
      if (draft.stage !== "review") {
        await ctx.db.patch(draft._id, {
          stage: "review",
          version: draft.version + 1,
          updatedAt: Date.now(),
        });
      }
      return null;
    }
    const inputFingerprint = intakeInputFingerprint({
      draftId: draft._id,
      policyChecksum: policy.checksum,
      ordinal,
      answers,
    });
    const prior = await ctx.db
      .query("intakeInterpretations")
      .withIndex("by_draft_input", (index) =>
        index.eq("draftId", draft._id).eq("inputFingerprint", inputFingerprint),
      )
      .first();
    if (prior) return null;
    const now = Date.now();
    const assisted = args.providerAvailable;
    const interpretationId = await ctx.db.insert("intakeInterpretations", {
      eventId: draft.eventId,
      teamId: draft.teamId,
      draftId: draft._id,
      intakePolicyVersionId: policy._id,
      inputAnswerVersionIds: answers.map((answer) => answer._id),
      inputFingerprint,
      ordinal,
      state: assisted ? "running" : "disabled",
      coveragePurposeKeys: [],
      modelId: ideaQuestionModelId,
      ...(!assisted
        ? {
            failureCategory: "api_key_not_configured",
            completedAt: now,
          }
        : {}),
      createdAt: now,
    });
    await appendIntakeJobReadFactById(ctx, interpretationId, now);
    if (!assisted) {
      await applyDeterministicPath(ctx, {
        draft,
        policy,
        normalizedPolicy: normalized,
        ordinal,
        sourceAnswerVersionIds: answers.map((answer) => answer._id),
        interpretationId,
        now,
      });
      return null;
    }
    return {
      interpretationId,
      draftId: draft._id,
      inputFingerprint,
      ordinal,
      minimumFollowUpCount: normalized.minimumFollowUpCount,
      modelId: ideaQuestionModelId,
      systemInstruction: ideaQuestionSystemInstruction,
      questionMaxLength: normalized.questionMaxLength,
      allowedPurposeKeys: normalized.allowedPurposeKeys,
      blockedTerms: normalized.blockedTerms,
      answers: answers
        .toSorted((left, right) => left.promptKey.localeCompare(right.promptKey))
        .map((answer) => ({
          id: answer._id,
          promptKey: answer.promptKey,
          value: answer.value,
        })),
      previousQuestions: responses.map(({ question }) => question.text),
      commonIdeaPatterns: normalized.commonIdeaPatterns,
    };
  },
});

const completionState = v.union(
  v.literal("succeeded"),
  v.literal("refused"),
  v.literal("invalid"),
  v.literal("timed_out"),
  v.literal("rate_limited"),
  v.literal("failed"),
);

export const finishIntakeInterpretation = internalMutation({
  args: {
    interpretationId: v.id("intakeInterpretations"),
    inputFingerprint: v.string(),
    state: completionState,
    coveragePurposeKeys: v.array(intakeQuestionPurpose),
    nextQuestionText: v.optional(v.string()),
    nextQuestionPurposeKey: v.optional(intakeQuestionPurpose),
    nextQuestionAnswerLength: v.optional(intakeAnswerLength),
    nextQuestionSourceAnswerVersionIds: v.array(v.id("intakeAnswerVersions")),
    matchedIdeaPatternKey: v.optional(v.string()),
    stopReason: v.optional(
      v.union(
        v.literal("needs_question"),
        v.literal("enough_context"),
        v.literal("question_limit"),
      ),
    ),
    providerRequestId: v.optional(v.string()),
    latencyMs: v.number(),
    failureCategory: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const interpretation = await ctx.db.get(args.interpretationId);
    if (!interpretation || interpretation.state !== "running") return null;
    const draft = await ctx.db.get(interpretation.draftId);
    if (!draft?.initialIdea || draft.stage === "submitted") {
      await ctx.db.patch(interpretation._id, {
        state: "stale",
        completedAt: Date.now(),
        latencyMs: args.latencyMs,
        failureCategory: "draft_unavailable",
      });
      await appendIntakeJobReadFactById(ctx, interpretation._id, Date.now());
      return null;
    }
    const [{ policy, normalized }, responses, answers] = await Promise.all([
      requirePinnedIntakePolicy(ctx, draft),
      loadCurrentIntakeResponses(ctx, draft._id),
      loadActiveIntakeAnswers(ctx, draft._id),
    ]);
    const currentFingerprint = intakeInputFingerprint({
      draftId: draft._id,
      policyChecksum: policy.checksum,
      ordinal: interpretation.ordinal,
      answers,
    });
    if (
      policy._id !== interpretation.intakePolicyVersionId ||
      currentFingerprint !== interpretation.inputFingerprint ||
      args.inputFingerprint !== interpretation.inputFingerprint ||
      responses.some(({ question }) => question.ordinal === interpretation.ordinal)
    ) {
      await ctx.db.patch(interpretation._id, {
        state: "stale",
        completedAt: Date.now(),
        latencyMs: args.latencyMs,
        failureCategory: "input_or_question_changed",
      });
      await appendIntakeJobReadFactById(ctx, interpretation._id, Date.now());
      return null;
    }

    const activeAnswerIds = new Set(answers.map((answer) => answer._id));
    const sourceIdsValid = args.nextQuestionSourceAnswerVersionIds.every((id) =>
      activeAnswerIds.has(id),
    );
    const patternValid =
      args.matchedIdeaPatternKey === undefined ||
      normalized.commonIdeaPatterns.some(
        (pattern) => pattern.stableKey === args.matchedIdeaPatternKey,
      );
    const coverageValid =
      new Set(args.coveragePurposeKeys).size === args.coveragePurposeKeys.length &&
      args.coveragePurposeKeys.every((purpose) =>
        normalized.allowedPurposeKeys.includes(purpose),
      );
    const questionText =
      args.nextQuestionText !== undefined && args.nextQuestionPurposeKey !== undefined
        ? validateGeneratedIntakeQuestion(normalized, {
            text: args.nextQuestionText,
            purposeKey: args.nextQuestionPurposeKey,
            previousQuestions: responses.map(({ question }) => question.text),
          })
        : null;
    const asksQuestion =
      questionText !== null &&
      args.nextQuestionPurposeKey !== undefined &&
      args.nextQuestionAnswerLength !== undefined &&
      args.nextQuestionSourceAnswerVersionIds.length > 0;
    const stopIsValid =
      (args.stopReason === "needs_question" && asksQuestion) ||
      ((args.stopReason === "enough_context" || args.stopReason === "question_limit") &&
        !args.nextQuestionText &&
        interpretation.ordinal > normalized.minimumFollowUpCount);
    const succeeded =
      args.state === "succeeded" &&
      sourceIdsValid &&
      patternValid &&
      coverageValid &&
      stopIsValid;
    const settledState = succeeded ? "succeeded" as const : args.state === "succeeded" ? "invalid" as const : args.state;
    const now = Date.now();
    await ctx.db.patch(interpretation._id, {
      state: settledState,
      coveragePurposeKeys: succeeded ? args.coveragePurposeKeys : [],
      nextQuestionText: succeeded && asksQuestion ? questionText : undefined,
      nextQuestionPurposeKey:
        succeeded && asksQuestion ? args.nextQuestionPurposeKey : undefined,
      nextQuestionAnswerLength:
        succeeded && asksQuestion ? args.nextQuestionAnswerLength : undefined,
      matchedIdeaPatternKey: succeeded ? args.matchedIdeaPatternKey : undefined,
      stopReason: succeeded ? args.stopReason : undefined,
      providerRequestId: args.providerRequestId,
      latencyMs: args.latencyMs,
      failureCategory:
        args.state === "succeeded" && !succeeded
          ? "policy_validation_failed"
          : args.failureCategory,
      completedAt: now,
    });
    await appendIntakeJobReadFactById(ctx, interpretation._id, now);

    let questionId: Id<"intakeGeneratedQuestions"> | null = null;
    if (
      succeeded &&
      asksQuestion &&
      questionText !== null &&
      args.nextQuestionPurposeKey !== undefined &&
      args.nextQuestionAnswerLength !== undefined
    ) {
      questionId = await createIntakeQuestion(ctx, {
        draft,
        policy,
        ordinal: interpretation.ordinal,
        text: questionText,
        purposeKey: args.nextQuestionPurposeKey,
        answerLength: args.nextQuestionAnswerLength,
        source: "model",
        sourceAnswerVersionIds: args.nextQuestionSourceAnswerVersionIds,
        interpretationId: interpretation._id,
        ...(args.matchedIdeaPatternKey !== undefined
          ? { matchedIdeaPatternKey: args.matchedIdeaPatternKey }
          : {}),
        validationCategory: "model_output_validated",
        now,
      });
    }
    if (!succeeded) {
      await applyDeterministicPath(ctx, {
        draft,
        policy,
        normalizedPolicy: normalized,
        ordinal: interpretation.ordinal,
        sourceAnswerVersionIds: answers.map((answer) => answer._id),
        interpretationId: interpretation._id,
        now,
      });
      return null;
    }

    const stage = questionId ? "follow_up" as const : "review" as const;
    if (questionId || stage !== draft.stage) {
      await ctx.db.patch(draft._id, {
        stage,
        version: draft.version + 1,
        updatedAt: now,
      });
    }
    return null;
  },
});

const modelSourceRef = z.string().min(1).max(200);
const modelOutputSchema = z
  .object({
    coveragePurposeKeys: z
      .array(z.enum(["user", "problem", "experience", "event_goal", "tradeoff", "risk"]))
      .max(6),
    nextQuestion: z
      .object({
        text: z.string().min(8).max(140),
        purposeKey: z.enum(["user", "problem", "experience", "event_goal", "tradeoff", "risk"]),
        answerLength: z.enum(["short", "medium"]),
        sourceAnswerVersionIds: z.array(modelSourceRef).min(1).max(3),
      })
      .strict()
      .nullable(),
    matchedIdeaPatternKey: z.string().min(1).max(60).nullable(),
    stopReason: z.enum(["needs_question", "enough_context", "question_limit"]),
  })
  .strict();

type ModelOutput = z.infer<typeof modelOutputSchema>;

function parseModelOutput(value: string) {
  try {
    const result = modelOutputSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function resolveSourceIds(
  values: readonly string[],
  answers: IntakeContext["answers"],
) {
  const byId = new Map<string, Id<"intakeAnswerVersions">>(
    answers.map((answer) => [answer.id, answer.id]),
  );
  const resolved: Id<"intakeAnswerVersions">[] = [];
  for (const value of values) {
    const id = byId.get(value);
    if (!id || resolved.includes(id)) return null;
    resolved.push(id);
  }
  return resolved;
}

function validateModelOutput(output: ModelOutput, context: IntakeContext) {
  const purposeKeys = new Set(context.allowedPurposeKeys);
  const patternKeys = new Set(context.commonIdeaPatterns.map((pattern) => pattern.stableKey));
  if (
    new Set(output.coveragePurposeKeys).size !== output.coveragePurposeKeys.length ||
    output.coveragePurposeKeys.some((purpose) => !purposeKeys.has(purpose)) ||
    (output.matchedIdeaPatternKey !== null && !patternKeys.has(output.matchedIdeaPatternKey))
  ) {
    return null;
  }
  const questionSources = output.nextQuestion
    ? resolveSourceIds(output.nextQuestion.sourceAnswerVersionIds, context.answers)
    : [];
  if (
    questionSources === null ||
    (output.nextQuestion && !purposeKeys.has(output.nextQuestion.purposeKey)) ||
    (output.stopReason === "needs_question") !== Boolean(output.nextQuestion) ||
    ((output.stopReason === "enough_context" || output.stopReason === "question_limit") &&
      context.ordinal <= context.minimumFollowUpCount)
  ) {
    return null;
  }
  if (output.nextQuestion) {
    const normalized = output.nextQuestion.text.trim().replace(/\s+/gu, " ");
    const lower = normalized.toLocaleLowerCase("en");
    if (
      normalized.length > context.questionMaxLength ||
      !isBroadIdeaQuestion(normalized) ||
      !normalized.endsWith("?") ||
      [...normalized].filter((character) => character === "?").length !== 1 ||
      context.blockedTerms.some((term) => lower.includes(term)) ||
      context.previousQuestions.some(
        (question) => question.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en") === lower,
      )
    ) {
      return null;
    }
  }
  return {
    coveragePurposeKeys: output.coveragePurposeKeys,
    ...(output.nextQuestion
      ? {
          nextQuestionText: output.nextQuestion.text,
          nextQuestionPurposeKey: output.nextQuestion.purposeKey,
          nextQuestionAnswerLength: output.nextQuestion.answerLength,
        }
      : {}),
    nextQuestionSourceAnswerVersionIds: questionSources,
    ...(output.matchedIdeaPatternKey !== null
      ? { matchedIdeaPatternKey: output.matchedIdeaPatternKey }
      : {}),
    stopReason: output.stopReason,
  };
}

function emptyCompletion() {
  return {
    coveragePurposeKeys: [],
    nextQuestionSourceAnswerVersionIds: [],
  };
}

export const interpretIdea = internalAction({
  args: { draftId: v.id("projectDrafts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const context: IntakeContext | null = await ctx.runMutation(
      internal.intelligence.beginIntakeInterpretation,
      { draftId: args.draftId, providerAvailable: Boolean(apiKey) },
    );
    if (!context || !apiKey) return null;

    const startedAt = Date.now();
    const client = new OpenAI({ apiKey, maxRetries: 0 });
    try {
      const response = await client.responses.create({
        model: context.modelId,
        store: false,
        instructions: context.systemInstruction,
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
      const parsed = response.output_text ? parseModelOutput(response.output_text) : null;
      const validated = parsed ? validateModelOutput(parsed, context) : null;
      if (!validated) {
        await ctx.runMutation(internal.intelligence.finishIntakeInterpretation, {
          interpretationId: context.interpretationId,
          inputFingerprint: context.inputFingerprint,
          state: response.output_text ? "invalid" : "refused",
          ...emptyCompletion(),
          ...(response._request_id ? { providerRequestId: response._request_id } : {}),
          latencyMs: Date.now() - startedAt,
          failureCategory: response.output_text
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
        ...(response._request_id ? { providerRequestId: response._request_id } : {}),
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      const state =
        status === 429
          ? "rate_limited" as const
          : error instanceof OpenAI.APIConnectionTimeoutError
            ? "timed_out" as const
            : "failed" as const;
      await ctx.runMutation(internal.intelligence.finishIntakeInterpretation, {
        interpretationId: context.interpretationId,
        inputFingerprint: context.inputFingerprint,
        state,
        ...emptyCompletion(),
        latencyMs: Date.now() - startedAt,
        failureCategory: status ? `provider_http_${status}` : "provider_request_failed",
      });
    }
    return null;
  },
});
