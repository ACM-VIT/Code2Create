export {
  ideaQuestionAbsoluteMaximumCharacters,
  ideaQuestionEndToEndDeadlineMs,
  ideaQuestionMaximumOutputTokens,
  ideaQuestionModelId,
  ideaQuestionProviderTimeoutMs,
  ideaQuestionRelease,
  ideaQuestionSettlementDeadlineMs,
  ideaQuestionSystemInstruction,
  ideaQuestionTargetMaximumCharacters,
} from "@code2create/domain";

export const admissionRecommendationModel = {
  version: "admission-recommendation-v1",
  modelId: "gpt-5.6-luna",
  promptVersion: "admission-recommendation-v1",
  schemaVersion: "admission-recommendation-v1",
  evaluationSuiteVersion: "admission-recommendation-v1",
} as const;

const overlySpecificQuestionTerms = [
  "api",
  "architecture",
  "database",
  "dataset",
  "framework",
  "algorithm",
  "tech stack",
  "technology stack",
  "business model",
  "rollout",
  "compliance",
  "which model",
  "what model",
  "which metric",
  "what metric",
] as const;

export function isBroadIdeaQuestion(value: string, maximumLength: number) {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const lower = normalized.toLocaleLowerCase("en");
  const wordCount = normalized.split(" ").length;
  return (
    normalized.length <= maximumLength &&
    wordCount <= 20 &&
    !/[():;/]/u.test(normalized) &&
    !/\b(?:and|also)\s+(?:what|who|how|where|when|why|which|does|do|is|are|would|will|can)\b/iu.test(
      normalized,
    ) &&
    !overlySpecificQuestionTerms.some((term) => lower.includes(term))
  );
}
