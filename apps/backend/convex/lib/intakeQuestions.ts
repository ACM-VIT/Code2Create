import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  fixedQuestionForOrdinal,
  type IntakePolicy,
} from "./intakePolicy";
import { fingerprintText } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;

const intakeQuestionHistoryLimit = 1;

type CurrentIntakeQuestion = Doc<"intakeGeneratedQuestions"> & {
  state: "active" | "answered";
};

function isCurrentQuestion(
  question: Doc<"intakeGeneratedQuestions">,
): question is CurrentIntakeQuestion {
  return question.state === "active" || question.state === "answered";
}

export async function loadCurrentIntakeQuestions(
  ctx: ReadCtx,
  draftId: Id<"projectDrafts">,
) {
  const rows = await ctx.db
    .query("intakeGeneratedQuestions")
    .withIndex("by_draft_ordinal", (index) => index.eq("draftId", draftId))
    .collect();
  const current = rows
    .filter(isCurrentQuestion)
    .toSorted((left, right) => left.ordinal - right.ordinal);
  if (new Set(current.map((question) => question.ordinal)).size !== current.length) {
    throw new Error("A project draft has more than one current question at an ordinal.");
  }
  return current;
}

export async function loadCurrentIntakeResponses(
  ctx: ReadCtx,
  draftId: Id<"projectDrafts">,
) {
  const questions = await loadCurrentIntakeQuestions(ctx, draftId);
  return Promise.all(
    questions.map(async (question) => {
      const answer = await ctx.db
        .query("intakeAnswerVersions")
        .withIndex("by_generated_question_status", (index) =>
          index
            .eq("generatedQuestionId", question._id)
            .eq("status", "active"),
        )
        .unique();
      if (question.state === "answered" && !answer) {
        throw new Error("An answered intake question has no active answer version.");
      }
      if (question.state !== "answered" && answer) {
        throw new Error("An intake answer is active for a question that is not answered.");
      }
      return { question, answer };
    }),
  );
}

export async function loadActiveIntakeAnswers(
  ctx: ReadCtx,
  draftId: Id<"projectDrafts">,
) {
  return ctx.db
    .query("intakeAnswerVersions")
    .withIndex("by_draft_status", (index) =>
      index.eq("draftId", draftId).eq("status", "active"),
    )
    .collect();
}

export async function loadIntakeQuestionHistory(
  ctx: ReadCtx,
  draftId: Id<"projectDrafts">,
  ordinal: number,
) {
  const questions = await ctx.db
    .query("intakeGeneratedQuestions")
    .withIndex("by_draft_ordinal", (index) =>
      index.eq("draftId", draftId).eq("ordinal", ordinal),
    )
    .order("desc")
    .take(intakeQuestionHistoryLimit);
  return {
    latestPriorQuestionId: questions[0]?._id,
    texts: questions.map((question) => question.text),
  };
}

export function intakeInputFingerprint(args: {
  draftId: Id<"projectDrafts">;
  policyChecksum: string;
  ordinal: number;
  latestPriorQuestionId?: Id<"intakeGeneratedQuestions">;
  answers: readonly Doc<"intakeAnswerVersions">[];
}) {
  return fingerprintText(
    JSON.stringify({
      draftId: args.draftId,
      policyChecksum: args.policyChecksum,
      ordinal: args.ordinal,
      ...(args.latestPriorQuestionId !== undefined
        ? { latestPriorQuestionId: args.latestPriorQuestionId }
        : {}),
      answers: args.answers
        .map((answer) => ({ id: answer._id, promptKey: answer.promptKey }))
        .toSorted((left, right) => left.promptKey.localeCompare(right.promptKey)),
    }),
  );
}

export async function replaceCurrentIntakeQuestions(
  ctx: MutationCtx,
  draftId: Id<"projectDrafts">,
) {
  const questions = await loadCurrentIntakeQuestions(ctx, draftId);
  for (const question of questions) {
    await replaceQuestion(ctx, question);
  }
}

export async function replaceIntakeQuestionsAfter(
  ctx: MutationCtx,
  draftId: Id<"projectDrafts">,
  ordinal: number,
) {
  const questions = await loadCurrentIntakeQuestions(ctx, draftId);
  for (const question of questions) {
    if (question.ordinal > ordinal) await replaceQuestion(ctx, question);
  }
}

export async function deactivateCurrentQuestionAnswer(
  ctx: MutationCtx,
  questionId: Id<"intakeGeneratedQuestions">,
) {
  const answer = await ctx.db
    .query("intakeAnswerVersions")
    .withIndex("by_generated_question_status", (index) =>
      index
        .eq("generatedQuestionId", questionId)
        .eq("status", "active"),
    )
    .unique();
  if (answer) await ctx.db.patch(answer._id, { status: "inactive_for_route" });
}

async function replaceQuestion(
  ctx: MutationCtx,
  question: CurrentIntakeQuestion,
) {
  await ctx.db.patch(question._id, { state: "replaced" });
  await deactivateCurrentQuestionAnswer(ctx, question._id);
}

export async function createIntakeQuestion(
  ctx: MutationCtx,
  args: {
    draft: Doc<"projectDrafts">;
    policy: Doc<"intakePolicyVersions">;
    ordinal: number;
    text: string;
    purposeKey: Doc<"intakeGeneratedQuestions">["purposeKey"];
    answerLength: Doc<"intakeGeneratedQuestions">["answerLength"];
    source: Doc<"intakeGeneratedQuestions">["source"];
    sourceAnswerVersionIds: Id<"intakeAnswerVersions">[];
    interpretationId?: Id<"intakeInterpretations">;
    matchedIdeaPatternKey?: string;
    validationCategory: string;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("intakeGeneratedQuestions")
    .withIndex("by_draft_ordinal", (index) =>
      index.eq("draftId", args.draft._id).eq("ordinal", args.ordinal),
    )
    .collect();
  if (existing.some(isCurrentQuestion)) {
    return null;
  }
  return ctx.db.insert("intakeGeneratedQuestions", {
    eventId: args.draft.eventId,
    teamId: args.draft.teamId,
    draftId: args.draft._id,
    ordinal: args.ordinal,
    text: args.text,
    purposeKey: args.purposeKey,
    answerLength: args.answerLength,
    source: args.source,
    sourceAnswerVersionIds: args.sourceAnswerVersionIds,
    intakePolicyVersionId: args.policy._id,
    ...(args.interpretationId !== undefined
      ? { interpretationId: args.interpretationId }
      : {}),
    ...(args.matchedIdeaPatternKey !== undefined
      ? { matchedIdeaPatternKey: args.matchedIdeaPatternKey }
      : {}),
    state: "active",
    validationCategory: args.validationCategory,
    createdAt: args.now,
  });
}

export async function createFixedIntakeQuestion(
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
  const history = await loadIntakeQuestionHistory(
    ctx,
    args.draft._id,
    args.ordinal,
  );
  const question = fixedQuestionForOrdinal(
    args.normalizedPolicy,
    args.ordinal,
    args.draft.teamId,
    history.texts,
  );
  return createIntakeQuestion(ctx, {
    draft: args.draft,
    policy: args.policy,
    ordinal: args.ordinal,
    text: question.text,
    purposeKey: question.purposeKey,
    answerLength: question.answerLength,
    source:
      args.ordinal <= args.normalizedPolicy.deterministicFollowUpCount
        ? "fixed"
        : "fallback",
    sourceAnswerVersionIds: args.sourceAnswerVersionIds,
    validationCategory:
      args.ordinal <= args.normalizedPolicy.deterministicFollowUpCount
        ? "published_fixed_question"
        : "published_timeout_fallback",
    now: args.now,
  });
}

export function nextQuestionOrdinal(
  responses: readonly { question: Doc<"intakeGeneratedQuestions"> }[],
) {
  const completed = responses.filter(({ question }) => question.state === "answered");
  if (completed.length !== responses.length) return null;
  return completed.length + 1;
}

export function intakeSequenceComplete(
  policy: IntakePolicy,
  responses: readonly { question: Doc<"intakeGeneratedQuestions"> }[],
) {
  return (
    responses.length === policy.maximumFollowUpCount &&
    responses.every(
      ({ question }, index) =>
        question.ordinal === index + 1 &&
        question.state === "answered",
    )
  );
}
