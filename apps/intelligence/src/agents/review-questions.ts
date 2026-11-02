"use agent";
import {
  reviewEvidenceAnalysisInstructions,
  reviewQuestionAgentVersion,
  reviewQuestionInstructions,
  reviewQuestionProtocolVersion,
} from "@code2create/domain";
import {
  defineTool,
  useAgentFinish,
  useInitialData,
  useModel,
  usePersistentState,
  useTool,
} from "@flue/runtime";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import {
  evidenceAnalysisSchema,
  reviewQuestionRequestSchema,
  suggestedReviewQuestionsSchema,
  type ReviewQuestionInput,
} from "../lib/reviewQuestionProtocol.ts";
import { publishReviewQuestions } from "../lib/reviewQuestionTransport.ts";

export function ReviewQuestions() {
  const input = useInitialData<ReviewQuestionInput>();
  const [reminded, setReminded] = usePersistentState(
    "question-publish-reminder",
    false,
  );
  useModel(input.model, { thinkingLevel: "medium", compaction: false });
  const identity = {
    protocolVersion: reviewQuestionProtocolVersion,
    jobId: input.jobId,
    partId: input.partId,
    partAttempt: input.partAttempt,
    attempt: input.attempt,
    sourceChecksum: input.sourceChecksum,
    payloadChecksum: input.payloadChecksum,
    agentVersion: reviewQuestionAgentVersion,
  } as const;
  useTool(
    defineTool({
      name: "publish_review_questions",
      description:
        "Publish optional verbal questions using only source IDs and criterion keys from the frozen evidence. No scores or grading.",
      input: suggestedReviewQuestionsSchema,
      output: v.strictObject({ delivered: v.literal(true) }),
      durable: true,
      async run({ data, step }) {
        if (
          input.stage !== "questions" ||
          data.questions.length > input.maximumQuestions ||
          data.questions.some(
            (question) =>
              !input.criteria.some((c) => c.key === question.criterionKey) ||
              question.sourceIds.some(
                (id) => !input.references.some((source) => source.id === id),
              ),
          )
        )
          throw new Error(
            "Use only the configured question count, supplied criterion keys and source IDs.",
          );
        const result = await step.do(
          `publish:${input.jobId}:${input.attempt}:${input.partId}:${input.partAttempt}`,
          () =>
            publishReviewQuestions(
              { ...identity, status: "ready", questions: data.questions },
              env,
            ),
        );
        return { output: result, terminate: true };
      },
    }),
  );
  useTool(
    defineTool({
      name: "publish_evidence_analysis",
      description:
        "Account for every source in this batch and publish grounded findings with original evidence citations. No scores.",
      input: evidenceAnalysisSchema,
      output: v.strictObject({ delivered: v.literal(true) }),
      durable: true,
      async run({ data, step }) {
        const examined = new Set(data.examinedSourceIds);
        if (
          input.stage === "questions" ||
          examined.size !== input.sources.length ||
          examined.size !== data.examinedSourceIds.length ||
          input.sources.some((s) => !examined.has(s.id)) ||
          data.findings.some((f) =>
            f.sourceIds.some(
              (id) => !input.references.some((r) => r.id === id),
            ),
          )
        )
          throw new Error(
            "Account for every supplied source exactly once and cite only supplied original references.",
          );
        const output = await step.do(
          `analyse:${input.jobId}:${input.attempt}:${input.partId}:${input.partAttempt}`,
          () =>
            publishReviewQuestions(
              { ...identity, status: "analysed", ...data },
              env,
            ),
        );
        return { output, terminate: true };
      },
    }),
  );
  useAgentFinish(async ({ response, append }) => {
    if (
      response.toolCalls.some(
        (call) =>
          call.tool ===
            (input.stage === "questions"
              ? "publish_review_questions"
              : "publish_evidence_analysis") && !call.isError,
      )
    )
      return;
    if (!reminded) {
      setReminded(true);
      append({
        kind: "signal",
        type: "review.questions.publish_required",
        body:
          input.stage === "questions"
            ? "Publish the useful verbal questions with original evidence citations now."
            : "Finish inspecting every source and publish the evidence analysis now.",
      });
      return;
    }
    await publishReviewQuestions(
      { ...identity, status: "failed", failureCode: "model_did_not_publish" },
      env,
    );
  });
  return `${input.stage === "questions" ? reviewQuestionInstructions : reviewEvidenceAnalysisInstructions}
Stage: ${input.stage}.\n\nMaximum questions: ${input.maximumQuestions}.\nAdditional event guidance: ${input.instructions}\n\nFixed rubric (reference only): ${JSON.stringify(input.criteria)}\n\nFrozen evidence: ${JSON.stringify(input.sources)}\nOriginal evidence references: ${JSON.stringify(input.references)}`;
}
ReviewQuestions.agentName = "review-questions";
ReviewQuestions.initialData = reviewQuestionRequestSchema;
ReviewQuestions.durability = { maxAttempts: 2 };
