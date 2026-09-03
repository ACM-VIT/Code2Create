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
      })
      .strict(),
    matchedIdeaPatternKey: z.string().min(1).max(60).nullable(),
    stopReason: z.literal("needs_question"),
  })
  .strict();

type ModelOutput = z.infer<typeof modelOutputSchema>;

type InvalidModelOutput = {
  kind: "invalid";
  failureCategory:
    | "model_output_invalid_json"
    | "model_output_invalid_schema"
    | "model_output_invalid_coverage"
    | "model_output_invalid_pattern"
    | "model_output_invalid_source"
    | "model_output_invalid_purpose"
    | "model_question_too_long"
    | "model_question_not_broad"
    | "model_question_invalid_punctuation"
    | "model_question_blocked_wording"
    | "model_question_repeated";
};

function invalid(failureCategory: InvalidModelOutput["failureCategory"]): InvalidModelOutput {
  return { kind: "invalid", failureCategory };
}

function parseModelOutput(
  value: string,
): { kind: "parsed"; output: ModelOutput } | InvalidModelOutput {
  try {
    const result = modelOutputSchema.safeParse(JSON.parse(value));
    return result.success
      ? { kind: "parsed", output: result.data }
      : invalid("model_output_invalid_schema");
  } catch {
    return invalid("model_output_invalid_json");
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
    output.coveragePurposeKeys.some((purpose) => !purposeKeys.has(purpose))
  ) {
    return invalid("model_output_invalid_coverage");
  }
  if (output.matchedIdeaPatternKey !== null && !patternKeys.has(output.matchedIdeaPatternKey)) {
    return invalid("model_output_invalid_pattern");
  }
  const questionSources = resolveSourceIds(
    output.nextQuestion.sourceAnswerVersionIds,
    context.answers,
  );
  if (questionSources === null) return invalid("model_output_invalid_source");
  if (!purposeKeys.has(output.nextQuestion.purposeKey))
    return invalid("model_output_invalid_purpose");
  const normalized = output.nextQuestion.text.trim().replace(/\s+/gu, " ");
  const lower = normalized.toLocaleLowerCase("en");
  if (normalized.length > context.questionMaxLength) return invalid("model_question_too_long");
  if (!isBroadIdeaQuestion(normalized)) return invalid("model_question_not_broad");
  if (
    !normalized.endsWith("?") ||
    [...normalized].filter((character) => character === "?").length !== 1
  ) {
    return invalid("model_question_invalid_punctuation");
  }
  if (context.blockedTerms.some((term) => lower.includes(term))) {
    return invalid("model_question_blocked_wording");
  }
  if (
    context.previousQuestions.some(
      (question) => question.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en") === lower,
    )
  ) {
    return invalid("model_question_repeated");
  }
  return {
    kind: "valid" as const,
    completion: {
      coveragePurposeKeys: output.coveragePurposeKeys,
      nextQuestionText: normalized,
      nextQuestionPurposeKey: output.nextQuestion.purposeKey,
      nextQuestionAnswerLength: output.nextQuestion.answerLength,
      nextQuestionSourceAnswerVersionIds: questionSources,
      ...(output.matchedIdeaPatternKey !== null
        ? { matchedIdeaPatternKey: output.matchedIdeaPatternKey }
        : {}),
      stopReason: output.stopReason,
    },
  };
}

export function validateIntakeQuestionModelOutput(
  value: string,
  context: IntakeQuestionModelContext,
) {
  const parsed = parseModelOutput(value);
  return parsed.kind === "invalid" ? parsed : validateModelOutput(parsed.output, context);
}
