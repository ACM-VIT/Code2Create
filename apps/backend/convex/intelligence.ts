import { v, type Infer } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalAction, internalMutation } from "./_generated/server";
import {
  requirePinnedIntakePolicy,
  type IntakePolicy,
  validateGeneratedIntakeQuestion,
} from "./lib/intakePolicy";
import {
  ideaQuestionModelId,
  ideaQuestionEndToEndDeadlineMs,
  ideaQuestionSettlementDeadlineMs,
  ideaQuestionSystemInstruction,
  isBroadIdeaQuestion,
} from "./lib/ideaSubmissionAi";
import {
  createIntakeQuestion,
  createFixedIntakeQuestion,
  intakeInputFingerprint,
  loadActiveIntakeAnswers,
  loadCurrentIntakeResponses,
  nextQuestionOrdinal,
} from "./lib/intakeQuestions";
import { redactProjectText } from "./lib/projectText";
import { appendIntakeJobReadFactById } from "./lib/operationsAutonomyReadFacts/intakeJobs";
import { intakeAnswerLength, intakeQuestionPurpose } from "./values";
import { intakeWorkpool } from "./workpools";

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
    now: number;
  },
) {
  const shouldAsk = args.ordinal <= args.normalizedPolicy.deterministicFollowUpCount;
  let questionId: Id<"intakeGeneratedQuestions"> | null = null;
  if (shouldAsk) {
    questionId = await createFixedIntakeQuestion(ctx, {
      draft: args.draft,
      policy: args.policy,
      normalizedPolicy: args.normalizedPolicy,
      ordinal: args.ordinal,
      sourceAnswerVersionIds: args.sourceAnswerVersionIds,
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
    if (ordinal <= normalized.deterministicFollowUpCount) {
      await applyDeterministicPath(ctx, {
        draft,
        policy,
        normalizedPolicy: normalized,
        ordinal,
        sourceAnswerVersionIds: answers.map((answer) => answer._id),
        now: Date.now(),
      });
      return null;
    }
    if (normalized.model.mode === "deterministic") {
      await applyDeterministicPath(ctx, {
        draft,
        policy,
        normalizedPolicy: normalized,
        ordinal,
        sourceAnswerVersionIds: answers.map((answer) => answer._id),
        now: Date.now(),
      });
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
        now,
      });
      return null;
    }
    await ctx.scheduler.runAfter(
      ideaQuestionSettlementDeadlineMs,
      internal.intelligence.expireIntakeInterpretation,
      { interpretationId, inputFingerprint },
    );
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

export const expireIntakeInterpretation = internalMutation({
  args: {
    interpretationId: v.id("intakeInterpretations"),
    inputFingerprint: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const interpretation = await ctx.db.get(args.interpretationId);
    if (
      !interpretation ||
      interpretation.state !== "running" ||
      interpretation.inputFingerprint !== args.inputFingerprint
    ) return null;
    const result: null = await ctx.runMutation(
      internal.intelligence.finishIntakeInterpretation,
      {
        interpretationId: interpretation._id,
        inputFingerprint: interpretation.inputFingerprint,
        state: "timed_out",
        ...emptyCompletion(),
        latencyMs: Math.max(0, Date.now() - interpretation.createdAt),
        failureCategory: "settlement_deadline_exceeded",
      },
    );
    return result;
  },
});

export const expireQueuedIntakeInterpretation = internalMutation({
  args: {
    draftId: v.id("projectDrafts"),
    draftVersion: v.number(),
    enqueuedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const remainingMs = args.enqueuedAt + ideaQuestionEndToEndDeadlineMs - now;
    if (remainingMs > 0) {
      await ctx.scheduler.runAfter(
        remainingMs,
        internal.intelligence.expireQueuedIntakeInterpretation,
        args,
      );
      return null;
    }
    const draft = await ctx.db.get(args.draftId);
    if (
      !draft?.initialIdea ||
      draft.stage !== "follow_up" ||
      draft.version !== args.draftVersion
    ) return null;
    const [{ policy, normalized }, responses, answers] = await Promise.all([
      requirePinnedIntakePolicy(ctx, draft),
      loadCurrentIntakeResponses(ctx, draft._id),
      loadActiveIntakeAnswers(ctx, draft._id),
    ]);
    const ordinal = nextQuestionOrdinal(responses);
    if (
      ordinal === null ||
      ordinal <= normalized.deterministicFollowUpCount ||
      ordinal > normalized.maximumFollowUpCount
    ) return null;
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
    if (prior?.state === "running") {
      await ctx.runMutation(internal.intelligence.finishIntakeInterpretation, {
        interpretationId: prior._id,
        inputFingerprint,
        state: "timed_out",
        ...emptyCompletion(),
        latencyMs: Math.max(0, now - args.enqueuedAt),
        failureCategory: "end_to_end_deadline_exceeded",
      });
      return null;
    }
    if (prior) return null;
    const interpretationId = await ctx.db.insert("intakeInterpretations", {
      eventId: draft.eventId,
      teamId: draft.teamId,
      draftId: draft._id,
      intakePolicyVersionId: policy._id,
      inputAnswerVersionIds: answers.map((answer) => answer._id),
      inputFingerprint,
      ordinal,
      state: "disabled",
      coveragePurposeKeys: [],
      modelId: ideaQuestionModelId,
      latencyMs: Math.max(0, now - args.enqueuedAt),
      failureCategory: "workpool_queue_deadline_exceeded",
      completedAt: now,
      createdAt: args.enqueuedAt,
    });
    await appendIntakeJobReadFactById(ctx, interpretationId, now);
    await applyDeterministicPath(ctx, {
      draft,
      policy,
      normalizedPolicy: normalized,
      ordinal,
      sourceAnswerVersionIds: answers.map((answer) => answer._id),
      now,
    });
    return null;
  },
});

const intakeGenerationContext = v.object({
  draftId: v.id("projectDrafts"),
  draftVersion: v.number(),
});

export const intakeGenerationFinished = intakeWorkpool.defineOnComplete<
  DataModel,
  typeof intakeGenerationContext
>({
  context: intakeGenerationContext,
  handler: async (ctx, { context, result }) => {
    if (result.kind === "success") return;
    const draft = await ctx.db.get(context.draftId);
    if (
      !draft?.initialIdea ||
      draft.stage !== "follow_up" ||
      draft.version !== context.draftVersion
    ) return;
    const latest = await ctx.db
      .query("intakeInterpretations")
      .withIndex("by_draft_created", (index) => index.eq("draftId", draft._id))
      .order("desc")
      .first();
    if (latest?.state === "running") {
      const settled: null = await ctx.runMutation(
        internal.intelligence.finishIntakeInterpretation,
        {
          interpretationId: latest._id,
          inputFingerprint: latest.inputFingerprint,
          state: "failed",
          ...emptyCompletion(),
          latencyMs: Math.max(0, Date.now() - latest.createdAt),
          failureCategory: result.kind === "canceled"
            ? "generation_canceled"
            : "generation_action_failed",
        },
      );
      void settled;
      return;
    }
    const started: IntakeContext | null = await ctx.runMutation(
      internal.intelligence.beginIntakeInterpretation,
      { draftId: draft._id, providerAvailable: false },
    );
    void started;
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
        groundingTerms: z.array(z.string().min(2).max(40)).min(1).max(3),
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
    const sourceAnswers = new Map(
      context.answers.map((answer) => [answer.id, answer.value] as const),
    );
    const groundingTerms = output.nextQuestion.groundingTerms.map((term) =>
      term.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en"),
    );
    const groundedText = questionSources
      .map((id) => sourceAnswers.get(id) ?? "")
      .join(" ")
      .toLocaleLowerCase("en");
    if (
      normalized.length > context.questionMaxLength ||
      !isBroadIdeaQuestion(normalized) ||
      !normalized.endsWith("?") ||
      [...normalized].filter((character) => character === "?").length !== 1 ||
      context.blockedTerms.some((term) => lower.includes(term)) ||
      context.previousQuestions.some(
        (question) => question.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en") === lower,
      ) ||
      new Set(groundingTerms).size !== groundingTerms.length ||
      groundingTerms.some((term) => !groundedText.includes(term)) ||
      !groundingTerms.some((term) => lower.includes(term))
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
    try {
      const provider = await ctx.runAction(
        internal.intelligenceActions.requestIdeaQuestion,
        {
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
        },
      );
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
      const parsed = provider.outputText ? parseModelOutput(provider.outputText) : null;
      const validated = parsed ? validateModelOutput(parsed, context) : null;
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
