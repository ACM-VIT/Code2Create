import { z } from "zod";

import type { Id } from "../_generated/dataModel";
import type { IntakeQuestionPurpose } from "../values";
import { isBroadIdeaQuestion } from "./ideaSubmissionAi";

export type IntakeQuestionModelContext = {
  questionMaxLength: number;
  allowedPurposeKeys: IntakeQuestionPurpose[];
  blockedTerms: string[];
  answers: Array<{
    id: Id<"intakeAnswerVersions">;
    promptKey: string;
    value: string;
  }>;
  previousQuestions: string[];
  commonIdeaPatterns: Array<{
    stableKey: string;
    description: string;
    supportiveQuestionGuidance: string;
  }>;
};

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
      .strict(),
    matchedIdeaPatternKey: z.string().min(1).max(60).nullable(),
    stopReason: z.literal("needs_question"),
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
  answers: IntakeQuestionModelContext["answers"],
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

function validateModelOutput(output: ModelOutput, context: IntakeQuestionModelContext) {
  const purposeKeys = new Set(context.allowedPurposeKeys);
  const patternKeys = new Set(context.commonIdeaPatterns.map((pattern) => pattern.stableKey));
  if (
    new Set(output.coveragePurposeKeys).size !== output.coveragePurposeKeys.length ||
    output.coveragePurposeKeys.some((purpose) => !purposeKeys.has(purpose)) ||
    (output.matchedIdeaPatternKey !== null && !patternKeys.has(output.matchedIdeaPatternKey))
  ) {
    return null;
  }
  const questionSources = resolveSourceIds(
    output.nextQuestion.sourceAnswerVersionIds,
    context.answers,
  );
  if (
    questionSources === null ||
    !purposeKeys.has(output.nextQuestion.purposeKey)
  ) {
    return null;
  }
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
  return {
    coveragePurposeKeys: output.coveragePurposeKeys,
    nextQuestionText: output.nextQuestion.text,
    nextQuestionPurposeKey: output.nextQuestion.purposeKey,
    nextQuestionAnswerLength: output.nextQuestion.answerLength,
    nextQuestionSourceAnswerVersionIds: questionSources,
    ...(output.matchedIdeaPatternKey !== null
      ? { matchedIdeaPatternKey: output.matchedIdeaPatternKey }
      : {}),
    stopReason: output.stopReason,
  };
}

export function parseAndValidateIntakeQuestionModelOutput(
  value: string,
  context: IntakeQuestionModelContext,
) {
  const parsed = parseModelOutput(value);
  return parsed ? validateModelOutput(parsed, context) : null;
}
