import OpenAI from "openai";
import { v, type Infer } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import { admissionGuidanceForBand, admissionInputFingerprint } from "./lib/admission";
import { redactProjectText } from "./lib/projectText";
import { appendAdmissionJobReadFactById } from "./lib/operationsAutonomyReadFacts/admissionJobs";
import { admissionDecision, admissionExperienceBand, criterionAssessment } from "./values";

const sourceRef = v.string();

type SourceRef = Infer<typeof sourceRef>;

const recommendationContext = v.object({
  recommendationId: v.id("admissionAIRecommendations"),
  applicationId: v.id("applications"),
  sourceInputFingerprint: v.string(),
  modelId: v.string(),
  maxOutputTokens: v.number(),
  timeoutMs: v.number(),
  experienceBand: admissionExperienceBand,
  initialIdea: v.string(),
  intakeResponses: v.array(
    v.object({
      sourceRef,
      question: v.string(),
      answer: v.optional(v.string()),
      skipped: v.boolean(),
    }),
  ),
  informationResponses: v.array(
    v.object({
      sourceRef,
      question: v.string(),
      answer: v.string(),
    }),
  ),
  criteria: v.array(
    v.object({
      criterionKey: v.string(),
      label: v.string(),
      guidance: v.string(),
    }),
  ),
});

type RecommendationContext = Infer<typeof recommendationContext>;

function validSubmittedIntakeResponses(
  responses: readonly {
    ordinal: number;
    answer?: string;
    skipped: boolean;
  }[],
) {
  return (
    responses.length >= 1 &&
    responses.length <= 2 &&
    responses.every(
      (response, index) =>
        response.ordinal === index + 1 &&
        (response.skipped
          ? response.answer === undefined
          : response.answer !== undefined),
    )
  );
}

function followUpSourceRef(ordinal: number): SourceRef {
  if (ordinal === 1) return "follow_up_1";
  if (ordinal === 2) return "follow_up_2";
  throw new Error("A submitted intake response has an invalid ordinal.");
}

export function admissionInformationSources(
  responses: Doc<"projectVersions">["admissionInformationResponses"],
) {
  return (responses ?? []).flatMap((response, responseIndex) =>
    response.answers.map((answer, answerIndex) => ({
      sourceRef: `requested_information_${responseIndex + 1}_${answerIndex + 1}`,
      question: answer.question,
      answer: answer.answer,
    })),
  );
}

const modelOutputSchema = z
  .object({
    recommendation: z.enum(["accept", "waitlist", "decline", "needs_information"]),
    criterionAssessments: z
      .array(
        z
          .object({
            criterionKey: z.string().min(1).max(80),
            assessment: z.enum(["meets", "partly_meets", "not_yet_clear"]),
            sourceRefs: z.array(z.string().min(1).max(80)).min(1).max(2),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    strengths: z.array(z.string().min(3).max(180)).max(3),
    concerns: z.array(z.string().min(3).max(180)).max(3),
    proposedQuestions: z.array(z.string().min(8).max(180)).max(2),
    confidence: z.enum(["low", "medium", "high"]),
    limitations: z.array(z.string().min(3).max(180)).max(3),
  })
  .strict();

type ModelOutput = z.infer<typeof modelOutputSchema>;

export const beginRecommendation = internalMutation({
  args: { recommendationId: v.id("admissionAIRecommendations") },
  returns: v.union(v.null(), recommendationContext),
  handler: async (ctx, args): Promise<RecommendationContext | null> => {
    const recommendation = await ctx.db.get(args.recommendationId);
    if (!recommendation || recommendation.state !== "pending") return null;
    const [application, project, policy, modelConfig] = await Promise.all([
      ctx.db.get(recommendation.applicationId),
      ctx.db.get(recommendation.projectVersionId),
      ctx.db.get(recommendation.admissionPolicyVersionId),
      recommendation.modelConfigVersionId
        ? ctx.db.get(recommendation.modelConfigVersionId)
        : Promise.resolve(null),
    ]);
    const valid = Boolean(
      application &&
        application.eventId === recommendation.eventId &&
        application.teamId === recommendation.teamId &&
        application.submittedProjectVersionId === recommendation.projectVersionId &&
        application.contentVersion === recommendation.applicationContentVersion &&
        application.admissionPolicyVersionId === recommendation.admissionPolicyVersionId &&
        application.aiRecommendationId === recommendation._id &&
        project &&
        project.eventId === recommendation.eventId &&
        validSubmittedIntakeResponses(project.intakeResponses) &&
        policy &&
        policy.eventId === recommendation.eventId &&
        policy.status === "published" &&
        modelConfig &&
        modelConfig.eventId === recommendation.eventId &&
        modelConfig.status === "published" &&
        modelConfig.admissionPolicyVersionId === policy._id,
    );
    if (!valid || !application || !project || !policy || !modelConfig) {
      await ctx.db.patch(recommendation._id, {
        state: "stale",
        completedAt: Date.now(),
        failureCategory: "source_context_changed",
      });
      await appendAdmissionJobReadFactById(ctx, recommendation._id, Date.now());
      if (application?.aiRecommendationId === recommendation._id) {
        await ctx.db.patch(application._id, { aiDisposition: "stale" });
      }
      return null;
    }
    const fingerprint = admissionInputFingerprint({
      applicationVersion: application.contentVersion,
      projectVersionId: project._id,
      projectVersion: project.version,
      initialIdea: project.initialIdea,
      intakeResponses: project.intakeResponses,
      admissionInformationResponses: project.admissionInformationResponses ?? [],
      experienceBand: application.experienceBand,
      admissionPolicyVersionId: policy._id,
      admissionPolicyChecksum: policy.checksum,
      modelConfigVersionId: modelConfig._id,
      modelConfigChecksum: modelConfig.checksum,
    });
    if (fingerprint !== recommendation.sourceInputFingerprint) {
      await ctx.db.patch(recommendation._id, {
        state: "stale",
        completedAt: Date.now(),
        failureCategory: "source_fingerprint_changed",
      });
      await appendAdmissionJobReadFactById(ctx, recommendation._id, Date.now());
      if (application.aiRecommendationId === recommendation._id) {
        await ctx.db.patch(application._id, { aiDisposition: "stale" });
      }
      return null;
    }
    await ctx.db.patch(recommendation._id, { state: "running" });
    await appendAdmissionJobReadFactById(ctx, recommendation._id, Date.now());
    return {
      recommendationId: recommendation._id,
      applicationId: application._id,
      sourceInputFingerprint: fingerprint,
      modelId: modelConfig.modelId,
      maxOutputTokens: modelConfig.maxOutputTokens,
      timeoutMs: modelConfig.timeoutMs,
      experienceBand: application.experienceBand,
      initialIdea: project.initialIdea,
      intakeResponses: project.intakeResponses.map((response) => ({
        sourceRef: followUpSourceRef(response.ordinal),
        question: response.question,
        ...(response.answer !== undefined ? { answer: response.answer } : {}),
        skipped: response.skipped,
      })),
      informationResponses: admissionInformationSources(
        project.admissionInformationResponses,
      ),
      criteria: policy.criteria.map((criterion) => ({
        criterionKey: criterion.criterionKey,
        label: criterion.label,
        guidance: admissionGuidanceForBand(
          criterion.guidanceByBand,
          application.experienceBand,
        ),
      })),
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
  v.literal("disabled"),
);

export const finishRecommendation = internalMutation({
  args: {
    recommendationId: v.id("admissionAIRecommendations"),
    sourceInputFingerprint: v.string(),
    state: completionState,
    recommendation: v.optional(admissionDecision),
    criterionAssessments: v.array(
      v.object({
        criterionKey: v.string(),
        assessment: criterionAssessment,
        sourceRefs: v.array(sourceRef),
      }),
    ),
    strengths: v.array(v.string()),
    concerns: v.array(v.string()),
    proposedQuestions: v.array(v.string()),
    confidence: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"))),
    limitations: v.array(v.string()),
    providerRequestId: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    failureCategory: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const recommendation = await ctx.db.get(args.recommendationId);
    if (!recommendation || recommendation.state !== "running") return null;
    const application = await ctx.db.get(recommendation.applicationId);
    if (
      !application ||
      application.contentVersion !== recommendation.applicationContentVersion ||
      application.aiRecommendationId !== recommendation._id ||
      recommendation.sourceInputFingerprint !== args.sourceInputFingerprint
    ) {
      await ctx.db.patch(recommendation._id, {
        state: "stale",
        completedAt: Date.now(),
        failureCategory: "application_changed_during_analysis",
      });
      await appendAdmissionJobReadFactById(ctx, recommendation._id, Date.now());
      if (application?.aiRecommendationId === recommendation._id) {
        await ctx.db.patch(application._id, { aiDisposition: "stale" });
      }
      return null;
    }
    let state = args.state;
    if (state === "succeeded") {
      const [policy, project] = await Promise.all([
        ctx.db.get(recommendation.admissionPolicyVersionId),
        ctx.db.get(recommendation.projectVersionId),
      ]);
      const expectedKeys = new Set(policy?.criteria.map((criterion) => criterion.criterionKey) ?? []);
      const actualKeys = new Set(
        args.criterionAssessments.map((assessment) => assessment.criterionKey),
      );
      const validProjectResponses = project
        ? validSubmittedIntakeResponses(project.intakeResponses)
        : false;
      const availableSourceRefs = new Set<SourceRef>(["initial_idea"]);
      if (project && validProjectResponses) {
        for (const response of project.intakeResponses) {
          if (!response.skipped && response.answer !== undefined) {
            availableSourceRefs.add(followUpSourceRef(response.ordinal));
          }
        }
      }
      if (project) {
        for (const response of admissionInformationSources(
          project.admissionInformationResponses,
        )) {
          availableSourceRefs.add(response.sourceRef);
        }
      }
      const valid = Boolean(
        args.recommendation &&
          args.confidence &&
          project?.eventId === recommendation.eventId &&
          validProjectResponses &&
          expectedKeys.size > 0 &&
          actualKeys.size === args.criterionAssessments.length &&
          actualKeys.size === expectedKeys.size &&
          [...expectedKeys].every((key) => actualKeys.has(key)) &&
          args.criterionAssessments.every((assessment) =>
            assessment.sourceRefs.length >= 1 &&
            assessment.sourceRefs.length <= 2 &&
            assessment.sourceRefs.every((source) => availableSourceRefs.has(source)),
          ),
      );
      if (!valid) state = "invalid";
    }
    const succeeded = state === "succeeded";
    await ctx.db.patch(recommendation._id, {
      state,
      recommendation: succeeded ? args.recommendation : undefined,
      criterionAssessments: succeeded ? args.criterionAssessments : [],
      strengths: succeeded ? args.strengths : [],
      concerns: succeeded ? args.concerns : [],
      proposedQuestions: succeeded ? args.proposedQuestions : [],
      confidence: succeeded ? args.confidence : undefined,
      limitations: args.limitations,
      providerRequestId: args.providerRequestId,
      latencyMs: args.latencyMs,
      failureCategory:
        args.state === "succeeded" && !succeeded
          ? "invalid_completion_payload"
          : args.failureCategory,
      completedAt: Date.now(),
    });
    await appendAdmissionJobReadFactById(ctx, recommendation._id, Date.now());
    await ctx.db.patch(application._id, {
      aiRecommendationId: recommendation._id,
      aiDisposition: succeeded ? undefined : "unavailable",
    });
    return null;
  },
});

function validateModelOutput(output: ModelOutput, context: RecommendationContext) {
  const expectedKeys = new Set(context.criteria.map((criterion) => criterion.criterionKey));
  const actualKeys = new Set(
    output.criterionAssessments.map((assessment) => assessment.criterionKey),
  );
  const availableSourceRefs = new Set([
    "initial_idea",
    ...context.intakeResponses
      .filter((response) => !response.skipped && response.answer !== undefined)
      .map((response) => response.sourceRef),
    ...context.informationResponses.map((response) => response.sourceRef),
  ]);
  if (
    actualKeys.size !== output.criterionAssessments.length ||
    actualKeys.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !actualKeys.has(key)) ||
    output.criterionAssessments.some((assessment) =>
      assessment.sourceRefs.some((source) => !availableSourceRefs.has(source)),
    )
  ) {
    return null;
  }
  const blocked = /\b(score|scored|points?|ranking|winner|judging|judge score|prestige)\b/iu;
  if (
    [...output.strengths, ...output.concerns, ...output.proposedQuestions, ...output.limitations].some(
      (text) => blocked.test(text),
    )
  ) {
    return null;
  }
  return output;
}

function parseModelOutput(value: string) {
  try {
    const decoded = modelOutputSchema.safeParse(JSON.parse(value));
    return decoded.success ? decoded.data : null;
  } catch {
    return null;
  }
}

export const generate = internalAction({
  args: { recommendationId: v.id("admissionAIRecommendations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context: RecommendationContext | null = await ctx.runMutation(
      internal.admissionIntelligence.beginRecommendation,
      args,
    );
    if (!context) return null;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      await ctx.runMutation(internal.admissionIntelligence.finishRecommendation, {
        recommendationId: context.recommendationId,
        sourceInputFingerprint: context.sourceInputFingerprint,
        state: "disabled",
        criterionAssessments: [],
        strengths: [],
        concerns: [],
        proposedQuestions: [],
        limitations: ["The admission model is not configured in this environment."],
        failureCategory: "api_key_not_configured",
      });
      return null;
    }
    const client = new OpenAI({
      apiKey,
      timeout: context.timeoutMs,
      maxRetries: 0,
    });
    const startedAt = Date.now();
    try {
      const availableSourceRefs = [
        "initial_idea",
        ...context.intakeResponses
          .filter((response) => !response.skipped && response.answer !== undefined)
          .map((response) => response.sourceRef),
        ...context.informationResponses.map((response) => response.sourceRef),
      ];
      const response = await client.responses.create({
        model: context.modelId,
        store: false,
        max_output_tokens: context.maxOutputTokens,
        instructions:
          "You produce a structured recommendation for initial hackathon admission review, never a final decision and never a hackathon judging assessment. Apply only the supplied year-adjusted policy guidance. First-year expectations are intentionally welcoming. Use only the supplied project answers. Do not infer from names, institution, prestige, identity, capacity, novelty, prior outcomes, or human reviews. Do not use numeric scores, rankings, or judging language. Every criterion assessment must cite an available source reference. Human reviewers retain accept, waitlist, decline, and needs-information authority.",
        input: JSON.stringify({
          experienceBand: context.experienceBand,
          criteria: context.criteria,
          projectAnswers: [
            { sourceRef: "initial_idea", answer: redactProjectText(context.initialIdea) },
            ...context.intakeResponses.map((response) => ({
              sourceRef: response.sourceRef,
              question: response.question,
              ...(response.answer !== undefined
                ? { answer: redactProjectText(response.answer) }
                : {}),
              skipped: response.skipped,
            })),
            ...context.informationResponses.map((response) => ({
              sourceRef: response.sourceRef,
              question: response.question,
              answer: redactProjectText(response.answer),
            })),
          ],
        }),
        text: {
          format: {
            type: "json_schema",
            name: "code2create_admission_recommendation",
            strict: true,
            schema: {
              type: "object",
              properties: {
                recommendation: {
                  type: "string",
                  enum: ["accept", "waitlist", "decline", "needs_information"],
                },
                criterionAssessments: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      criterionKey: { type: "string" },
                      assessment: {
                        type: "string",
                        enum: ["meets", "partly_meets", "not_yet_clear"],
                      },
                      sourceRefs: {
                        type: "array",
                        items: {
                          type: "string",
                          enum: availableSourceRefs,
                        },
                        minItems: 1,
                        maxItems: 2,
                      },
                    },
                    required: ["criterionKey", "assessment", "sourceRefs"],
                    additionalProperties: false,
                  },
                },
                strengths: { type: "array", items: { type: "string" }, maxItems: 3 },
                concerns: { type: "array", items: { type: "string" }, maxItems: 3 },
                proposedQuestions: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: 2,
                },
                confidence: { type: "string", enum: ["low", "medium", "high"] },
                limitations: { type: "array", items: { type: "string" }, maxItems: 3 },
              },
              required: [
                "recommendation",
                "criterionAssessments",
                "strengths",
                "concerns",
                "proposedQuestions",
                "confidence",
                "limitations",
              ],
              additionalProperties: false,
            },
          },
        },
      });
      const parsed = parseModelOutput(response.output_text);
      const output = parsed ? validateModelOutput(parsed, context) : null;
      if (!output) {
        await ctx.runMutation(internal.admissionIntelligence.finishRecommendation, {
          recommendationId: context.recommendationId,
          sourceInputFingerprint: context.sourceInputFingerprint,
          state: "invalid",
          criterionAssessments: [],
          strengths: [],
          concerns: [],
          proposedQuestions: [],
          limitations: ["The model output did not match the published admission schema."],
          ...(response._request_id ? { providerRequestId: response._request_id } : {}),
          latencyMs: Date.now() - startedAt,
          failureCategory: "invalid_or_disallowed_output",
        });
        return null;
      }
      await ctx.runMutation(internal.admissionIntelligence.finishRecommendation, {
        recommendationId: context.recommendationId,
        sourceInputFingerprint: context.sourceInputFingerprint,
        state: "succeeded",
        recommendation: output.recommendation,
        criterionAssessments: output.criterionAssessments,
        strengths: output.strengths,
        concerns: output.concerns,
        proposedQuestions: output.proposedQuestions,
        confidence: output.confidence,
        limitations: output.limitations,
        ...(response._request_id ? { providerRequestId: response._request_id } : {}),
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      const state =
        status === 429
          ? "rate_limited"
          : error instanceof OpenAI.APIConnectionTimeoutError
            ? "timed_out"
            : "failed";
      await ctx.runMutation(internal.admissionIntelligence.finishRecommendation, {
        recommendationId: context.recommendationId,
        sourceInputFingerprint: context.sourceInputFingerprint,
        state,
        criterionAssessments: [],
        strengths: [],
        concerns: [],
        proposedQuestions: [],
        limitations: ["No AI recommendation is available; human review remains required."],
        latencyMs: Date.now() - startedAt,
        failureCategory: status ? `provider_http_${status}` : "provider_request_failed",
      });
    }
    return null;
  },
});
