import { z } from "zod";
import {
  reviewQuestionAgentVersion,
  reviewQuestionProtocolVersion,
} from "@code2create/domain";
import { operationFingerprint } from "./operations";

export function questionPayloadChecksum(
  input: Omit<z.infer<typeof reviewQuestionRequestSchema>, "payloadChecksum">,
) {
  return operationFingerprint([
    input.protocolVersion,
    input.jobId,
    input.attempt,
    input.sourceChecksum,
    input.stage,
    input.partId,
    input.partAttempt,
    JSON.stringify(
      input.references.map((s) => [
        s.id,
        s.kind,
        s.title,
        s.url ?? null,
        s.coverage,
      ]),
    ),
    input.model,
    input.maximumQuestions,
    input.instructions,
    JSON.stringify(
      input.criteria.map((c) => [c.key, c.label, c.question, c.guidance]),
    ),
    JSON.stringify(
      input.sources.map((s) => [
        s.id,
        s.kind,
        s.title,
        s.url ?? null,
        s.text,
        s.coverage,
      ]),
    ),
  ]);
}

export const reviewQuestionRequestSchema = z
  .object({
    protocolVersion: z.literal(reviewQuestionProtocolVersion),
    jobId: z.string().min(1).max(200),
    attempt: z.number().int().min(1).max(10),
    sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    payloadChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    stage: z.enum(["inspect", "reduce", "questions"]),
    partId: z.string().min(1).max(200),
    partAttempt: z.number().int().min(1).max(10),
    references: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            kind: z.enum(["project", "checkpoint", "github", "figma"]),
            title: z.string().max(500),
            url: z.string().max(2000).optional(),
            coverage: z.enum(["captured", "partial", "unavailable"]),
          })
          .strict(),
      )
      .max(150),
    model: z.string().regex(/^openai\/[A-Za-z0-9._-]{1,100}$/),
    maximumQuestions: z.number().int().min(1).max(12),
    instructions: z.string().max(2000),
    criteria: z
      .array(
        z
          .object({
            key: z.string().min(1).max(80),
            label: z.string().max(200),
            question: z.string().max(2000),
            guidance: z.string().max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    sources: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            kind: z.enum(["project", "checkpoint", "github", "figma"]),
            title: z.string().max(500),
            url: z.string().max(2000).optional(),
            text: z.string().max(160000),
            coverage: z.enum(["captured", "partial", "unavailable"]),
          })
          .strict(),
      )
      .min(1)
      .max(150),
  })
  .strict();
export const suggestedQuestionSchema = z
  .object({
    question: z.string().trim().min(8).max(280),
    reason: z.string().trim().min(3).max(350),
    criterionKey: z.string().min(1).max(80),
    sourceIds: z.array(z.string().min(1).max(200)).min(1).max(5),
  })
  .strict();
const callbackBase = {
  protocolVersion: z.literal(reviewQuestionProtocolVersion),
  jobId: z.string().min(1).max(200),
  attempt: z.number().int().positive(),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  payloadChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  partId: z.string().min(1).max(200),
  partAttempt: z.number().int().min(1).max(10),
  agentVersion: z.literal(reviewQuestionAgentVersion),
};
export const reviewEvidenceFindingSchema = z
  .object({
    category: z.enum([
      "research",
      "architecture",
      "implementation",
      "testing",
      "design",
      "reproducibility",
      "progress",
      "uncertainty",
    ]),
    observation: z.string().trim().min(3).max(1000),
    followUp: z.string().trim().max(280),
    sourceIds: z.array(z.string().min(1).max(200)).min(1).max(5),
  })
  .strict();
export const reviewEvidenceAnalysisSchema = z
  .object({
    examinedSourceIds: z.array(z.string().min(1).max(200)).min(1).max(150),
    summary: z.string().trim().min(3).max(2000),
    findings: z.array(reviewEvidenceFindingSchema).max(12),
  })
  .strict();
export const reviewQuestionCallbackSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...callbackBase,
      status: z.literal("analysed"),
      ...reviewEvidenceAnalysisSchema.shape,
    })
    .strict(),
  z
    .object({
      ...callbackBase,
      status: z.literal("ready"),
      questions: z.array(suggestedQuestionSchema).max(12),
    })
    .strict(),
  z
    .object({
      ...callbackBase,
      status: z.literal("failed"),
      failureCode: z.literal("model_did_not_publish"),
    })
    .strict(),
]);
