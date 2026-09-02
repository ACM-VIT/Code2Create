import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
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
} from "./lib/ideaSubmissionAi";
import {
  createIntakeQuestion,
  createFixedIntakeQuestion,
  intakeInputFingerprint,
  loadActiveIntakeAnswers,
  loadCurrentIntakeResponses,
  nextQuestionOrdinal,
} from "./lib/intakeQuestions";
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

export type IntakeContext = Infer<typeof intakeContext>;

function emptyCompletion() {
  return {
    coveragePurposeKeys: [],
    nextQuestionSourceAnswerVersionIds: [],
  };
}

const intakeInterpretationState = v.union(
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("refused"),
  v.literal("invalid"),
  v.literal("timed_out"),
  v.literal("rate_limited"),
  v.literal("failed"),
  v.literal("stale"),
  v.literal("disabled"),
);

function scheduleIntakeJobReadFact(
  ctx: MutationCtx,
  args: {
    jobId: Id<"intakeInterpretations">;
    expectedState: Doc<"intakeInterpretations">["state"];
  },
) {
  const key = `${args.jobId}:${args.expectedState}`;
  let hash = 2_166_136_261;
  for (const character of key) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  }
  const delayMs = args.expectedState === "running"
    ? 30_000
    : (hash >>> 0) % 120_000;
  return ctx.scheduler.runAfter(
    delayMs,
    internal.intelligence.publishIntakeJobReadFact,
    args,
  );
}

export const publishIntakeJobReadFact = internalMutation({
  args: {
    jobId: v.id("intakeInterpretations"),
    expectedState: intakeInterpretationState,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.jobId);
    if (!row || row.state !== args.expectedState) return null;
    await appendIntakeJobReadFactById(ctx, row._id, Date.now());
    return null;
  },
});

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
  const shouldAsk = args.ordinal <= args.normalizedPolicy.maximumFollowUpCount;
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
  const stage = questionId
    ? "follow_up" as const
    : "additional_information" as const;
  if (questionId || stage !== args.draft.stage) {
    await ctx.db.patch(args.draft._id, {
      stage,
      adaptiveQuestionDeadlineAt: undefined,
      version: args.draft.version + 1,
      updatedAt: args.now,
    });
  }
  return questionId;
}

export const beginIntakeInterpretation = internalMutation({
  args: {
    draftId: v.id("projectDrafts"),
    provider: v.union(
      v.object({ kind: v.literal("available") }),
      v.object({
        kind: v.literal("unavailable"),
        reason: v.union(
          v.literal("api_key_not_configured"),
          v.literal("generation_action_failed"),
          v.literal("generation_canceled"),
        ),
      }),
    ),
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
      if (draft.stage !== "additional_information") {
        await ctx.db.patch(draft._id, {
          stage: "additional_information",
          adaptiveQuestionDeadlineAt: undefined,
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
    const assisted = args.provider.kind === "available";
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
            failureCategory: args.provider.kind === "unavailable"
              ? args.provider.reason
              : "api_key_not_configured",
            completedAt: now,
          }
        : {}),
      createdAt: now,
    });
    await scheduleIntakeJobReadFact(ctx, {
      jobId: interpretationId,
      expectedState: assisted ? "running" : "disabled",
    });
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
      await scheduleIntakeJobReadFact(ctx, {
        jobId: interpretation._id,
        expectedState: "stale",
      });
      return null;
    }
    const now = Date.now();
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
      await scheduleIntakeJobReadFact(ctx, {
        jobId: interpretation._id,
        expectedState: "stale",
      });
      return null;
    }

    const settlementDeadlineAt = Math.min(
      interpretation.createdAt + ideaQuestionSettlementDeadlineMs,
      draft.adaptiveQuestionDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
    if (now >= settlementDeadlineAt) {
      await ctx.db.patch(interpretation._id, {
        state: "timed_out",
        coveragePurposeKeys: [],
        completedAt: now,
        latencyMs: Math.max(args.latencyMs, now - interpretation.createdAt),
        failureCategory: "settlement_deadline_exceeded",
      });
      await scheduleIntakeJobReadFact(ctx, {
        jobId: interpretation._id,
        expectedState: "timed_out",
      });
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
    const stopIsValid = args.stopReason === "needs_question" && asksQuestion;
    const succeeded =
      args.state === "succeeded" &&
      sourceIdsValid &&
      patternValid &&
      coverageValid &&
      stopIsValid;
    const settledState = succeeded ? "succeeded" as const : args.state === "succeeded" ? "invalid" as const : args.state;
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
    await scheduleIntakeJobReadFact(ctx, {
      jobId: interpretation._id,
      expectedState: settledState,
    });

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

    const stage = questionId
      ? "follow_up" as const
      : "additional_information" as const;
    if (questionId || stage !== draft.stage) {
      await ctx.db.patch(draft._id, {
        stage,
        adaptiveQuestionDeadlineAt: undefined,
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
    deadlineAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const remainingMs = args.deadlineAt - now;
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
      draft.version !== args.draftVersion ||
      draft.adaptiveQuestionDeadlineAt !== args.deadlineAt
    ) return null;
    const [{ policy, normalized }, responses, answers] = await Promise.all([
      requirePinnedIntakePolicy(ctx, draft),
      loadCurrentIntakeResponses(ctx, draft._id),
      loadActiveIntakeAnswers(ctx, draft._id),
    ]);
    const ordinal = nextQuestionOrdinal(responses);
    if (ordinal === null || ordinal > normalized.maximumFollowUpCount) return null;
    if (ordinal <= normalized.deterministicFollowUpCount) {
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
        latencyMs: Math.max(
          0,
          now - (args.deadlineAt - ideaQuestionEndToEndDeadlineMs),
        ),
        failureCategory: "end_to_end_deadline_exceeded",
      });
      return null;
    }
    if (prior) {
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
      latencyMs: Math.max(
        0,
        now - (args.deadlineAt - ideaQuestionEndToEndDeadlineMs),
      ),
      failureCategory: "action_start_deadline_exceeded",
      completedAt: now,
      createdAt: args.deadlineAt - ideaQuestionEndToEndDeadlineMs,
    });
    await scheduleIntakeJobReadFact(ctx, {
      jobId: interpretationId,
      expectedState: "disabled",
    });
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
