import * as v from "valibot";
import { reviewQuestionProtocolVersion } from "@code2create/domain";

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const reviewQuestionRequestSchema = v.strictObject({
  protocolVersion: v.literal(reviewQuestionProtocolVersion),
  jobId: id,
  attempt: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
  sourceChecksum: digest,
  payloadChecksum: digest,
  stage: v.picklist(["inspect", "reduce", "questions"]),
  partId: id,
  partAttempt: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
  references: v.pipe(
    v.array(
      v.strictObject({
        id,
        kind: v.picklist(["project", "checkpoint", "github"]),
        title: text(500),
        url: v.optional(text(2000)),
        coverage: v.picklist(["captured", "partial", "unavailable"]),
      }),
    ),
    v.maxLength(150),
  ),
  model: v.pipe(v.string(), v.regex(/^openai\/[A-Za-z0-9._-]{1,100}$/)),
  maximumQuestions: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(12),
  ),
  instructions: text(2000),
  criteria: v.pipe(
    v.array(
      v.strictObject({
        key: text(80),
        label: text(200),
        question: text(2000),
        guidance: text(4000),
      }),
    ),
    v.minLength(1),
    v.maxLength(20),
  ),
  sources: v.pipe(
    v.array(
      v.strictObject({
        id,
        kind: v.picklist(["project", "checkpoint", "github"]),
        title: text(500),
        url: v.optional(text(2000)),
        text: text(160000),
        coverage: v.picklist(["captured", "partial", "unavailable"]),
      }),
    ),
    v.minLength(1),
    v.maxLength(150),
  ),
});
export const suggestedReviewQuestionsSchema = v.strictObject({
  questions: v.pipe(
    v.array(
      v.strictObject({
        question: v.pipe(
          v.string(),
          v.trim(),
          v.minLength(8),
          v.maxLength(280),
        ),
        reason: v.pipe(v.string(), v.trim(), v.minLength(3), v.maxLength(350)),
        criterionKey: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
        sourceIds: v.pipe(v.array(id), v.minLength(1), v.maxLength(5)),
      }),
    ),
    v.maxLength(12),
  ),
});
export type ReviewQuestionInput = v.InferOutput<
  typeof reviewQuestionRequestSchema
>;

export const evidenceAnalysisSchema = v.strictObject({
  examinedSourceIds: v.pipe(v.array(id), v.minLength(1), v.maxLength(150)),
  summary: v.pipe(v.string(), v.trim(), v.minLength(3), v.maxLength(2000)),
  findings: v.pipe(
    v.array(
      v.strictObject({
        category: v.picklist([
          "research",
          "architecture",
          "implementation",
          "testing",
          "design",
          "reproducibility",
          "progress",
          "uncertainty",
        ]),
        observation: v.pipe(
          v.string(),
          v.trim(),
          v.minLength(3),
          v.maxLength(1000),
        ),
        followUp: text(280),
        sourceIds: v.pipe(v.array(id), v.minLength(1), v.maxLength(5)),
      }),
    ),
    v.maxLength(12),
  ),
});
