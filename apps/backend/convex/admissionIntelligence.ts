import { ideaIntelligenceAnalysisPolicyViolation } from "@code2create/domain";
import { v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { DataModel, Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { admissionGuidanceForBand, admissionInputFingerprint } from "./lib/admission";
import { operationFingerprint } from "./lib/operations";
import { appendAdmissionJobReadFactById } from "./lib/operationsAutonomyReadFacts/admissionJobs";
import { admissionDecision, admissionExperienceBand, criterionAssessment } from "./values";
import { admissionWorkpool } from "./workpools";

const sourceRef = v.string();
const agentDispatchRetryDelayMs = 60_000;

type SourceRef = Infer<typeof sourceRef>;

const recommendationContext = v.object({
  recommendationId: v.id("admissionAIRecommendations"),
  applicationId: v.id("applications"),
  sourceInputFingerprint: v.string(),
  modelId: v.string(),
  promptVersion: v.string(),
  schemaVersion: v.string(),
  evaluationSuiteVersion: v.string(),
  experienceBand: admissionExperienceBand,
  initialIdea: v.string(),
  additionalInformation: v.optional(v.string()),
  intakeResponses: v.array(
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
    answer: string;
  }[],
  intakePolicy: Pick<Doc<"intakePolicyVersions">, "minimumFollowUpCount" | "maximumFollowUpCount">,
) {
  return (
    responses.length >= intakePolicy.minimumFollowUpCount &&
    responses.length <= intakePolicy.maximumFollowUpCount &&
    responses.every((response, index) => response.ordinal === index + 1)
  );
}

function followUpSourceRef(ordinal: number): SourceRef {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error("A submitted intake response has an invalid ordinal.");
  }
  return `follow_up_${ordinal}`;
}

export const beginRecommendation = internalMutation({
  args: { recommendationId: v.id("admissionAIRecommendations") },
  returns: v.union(v.null(), recommendationContext),
  handler: async (ctx, args): Promise<RecommendationContext | null> => {
    const recommendation = await ctx.db.get(args.recommendationId);
    if (
      !recommendation ||
      (recommendation.state !== "pending" && recommendation.state !== "running")
    )
      return null;
    const [application, project, policy, modelConfig] = await Promise.all([
      ctx.db.get(recommendation.applicationId),
      ctx.db.get(recommendation.projectVersionId),
      ctx.db.get(recommendation.admissionPolicyVersionId),
      recommendation.modelConfigVersionId
        ? ctx.db.get(recommendation.modelConfigVersionId)
        : Promise.resolve(null),
    ]);
    const intakePolicy = project ? await ctx.db.get(project.intakePolicyVersionId) : null;
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
      intakePolicy &&
      intakePolicy.eventId === recommendation.eventId &&
      (intakePolicy.status === "published" || intakePolicy.status === "superseded") &&
      validSubmittedIntakeResponses(project.intakeResponses, intakePolicy) &&
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
      ...(project.additionalInformation !== undefined
        ? { additionalInformation: project.additionalInformation }
        : {}),
      intakeResponses: project.intakeResponses,
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
    if (recommendation.state === "pending") {
      await ctx.db.patch(recommendation._id, { state: "running" });
      await appendAdmissionJobReadFactById(ctx, recommendation._id, Date.now());
    }
    return {
      recommendationId: recommendation._id,
      applicationId: application._id,
      sourceInputFingerprint: fingerprint,
      modelId: modelConfig.modelId,
      promptVersion: modelConfig.promptVersion,
      schemaVersion: modelConfig.schemaVersion,
      evaluationSuiteVersion: modelConfig.evaluationSuiteVersion,
      experienceBand: application.experienceBand,
      initialIdea: project.initialIdea,
      ...(project.additionalInformation !== undefined
        ? { additionalInformation: project.additionalInformation }
        : {}),
      intakeResponses: project.intakeResponses.map((response) => ({
        sourceRef: followUpSourceRef(response.ordinal),
        question: response.question,
        answer: response.answer,
      })),
      criteria: policy.criteria.map((criterion) => ({
        criterionKey: criterion.criterionKey,
        label: criterion.label,
        guidance: admissionGuidanceForBand(criterion.guidanceByBand, application.experienceBand),
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

export const agentDispatchFinished = admissionWorkpool.defineOnComplete<
  DataModel,
  typeof sourceRef
>({
  context: sourceRef,
  handler: async (ctx, { context: recommendationIdValue, result }) => {
    if (result.kind === "success") return;
    const recommendationId = ctx.db.normalizeId(
      "admissionAIRecommendations",
      recommendationIdValue,
    );
    if (!recommendationId) return;
    const recommendation = await ctx.db.get(recommendationId);
    if (
      !recommendation ||
      recommendation.state !== "pending" ||
      recommendation.agentDispatchAttemptId ||
      recommendation.agentSubmissionId
    )
      return;
    await ctx.db.patch(recommendation._id, {
      limitations: ["The idea agent dispatch is retrying; human review remains available."],
      failureCategory: "agent_dispatch_retry",
    });
    await ctx.scheduler.runAfter(
      agentDispatchRetryDelayMs,
      internal.admissionIntelligence.retryAgentDispatch,
      { recommendationId: recommendation._id },
    );
  },
});

export const retryAgentDispatch = internalMutation({
  args: { recommendationId: v.id("admissionAIRecommendations") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const recommendation = await ctx.db.get(args.recommendationId);
    if (
      !recommendation ||
      recommendation.state !== "pending" ||
      recommendation.agentDispatchAttemptId ||
      recommendation.agentSubmissionId
    )
      return false;
    await admissionWorkpool.enqueueAction(
      ctx,
      internal.admissionAgentActions.dispatchRecommendation,
      { recommendationId: recommendation._id },
      {
        retry: true,
        onComplete: internal.admissionIntelligence.agentDispatchFinished,
        context: recommendation._id,
      },
    );
    return true;
  },
});

export const recoverAgentRecommendation = internalMutation({
  args: {
    recommendationId: v.id("admissionAIRecommendations"),
    submissionId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const recommendation = await ctx.db.get(args.recommendationId);
    if (
      !recommendation ||
      (recommendation.state !== "pending" && recommendation.state !== "running") ||
      recommendation.agentSubmissionId !== args.submissionId
    )
      return false;
    await ctx.db.patch(recommendation._id, {
      state: "pending",
      agentSubmissionId: undefined,
      agentAcceptedAt: undefined,
      limitations: ["The durable idea agent is recovering an interrupted analysis."],
      failureCategory: "agent_analysis_recovered",
    });
    await admissionWorkpool.enqueueAction(
      ctx,
      internal.admissionAgentActions.dispatchRecommendation,
      { recommendationId: recommendation._id },
      {
        retry: true,
        onComplete: internal.admissionIntelligence.agentDispatchFinished,
        context: recommendation._id,
      },
    );
    return true;
  },
});

export const recoverAgentDispatchAttempt = internalMutation({
  args: {
    recommendationId: v.id("admissionAIRecommendations"),
    attemptId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const recommendation = await ctx.db.get(args.recommendationId);
    if (
      !recommendation ||
      (recommendation.state !== "pending" && recommendation.state !== "running") ||
      recommendation.agentDispatchAttemptId !== args.attemptId ||
      recommendation.agentSubmissionId
    )
      return false;
    await ctx.db.patch(recommendation._id, {
      state: "pending",
      agentDispatchAttemptId: undefined,
      limitations: ["The durable idea agent is recovering an interrupted dispatch."],
      failureCategory: "agent_dispatch_recovered",
    });
    await admissionWorkpool.enqueueAction(
      ctx,
      internal.admissionAgentActions.dispatchRecommendation,
      { recommendationId: recommendation._id },
      {
        retry: true,
        onComplete: internal.admissionIntelligence.agentDispatchFinished,
        context: recommendation._id,
      },
    );
    return true;
  },
});

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
    confidence: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"))),
    limitations: v.array(v.string()),
    providerRequestId: v.optional(v.string()),
    operationId: v.optional(v.string()),
    agentVersion: v.optional(v.string()),
    agentModel: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    failureCategory: v.optional(v.string()),
  },
  returns: v.union(v.literal("accepted"), v.literal("already_exists"), v.literal("stale")),
  handler: async (ctx, args) => {
    const recommendation = await ctx.db.get(args.recommendationId);
    const agentOutputChecksum = args.operationId
      ? operationFingerprint([
          args.sourceInputFingerprint,
          args.state,
          args.recommendation ?? null,
          JSON.stringify(args.criterionAssessments),
          JSON.stringify(args.strengths),
          JSON.stringify(args.concerns),
          args.confidence ?? null,
          JSON.stringify(args.limitations),
          args.agentVersion ?? null,
          args.agentModel ?? null,
        ])
      : undefined;
    if (
      recommendation?.agentOperationId !== undefined &&
      args.operationId === recommendation.agentOperationId &&
      agentOutputChecksum === recommendation.agentOutputChecksum
    )
      return "already_exists";
    const canAcceptRecoveredDispatchCompletion =
      recommendation?.state === "pending" &&
      recommendation.failureCategory === "agent_dispatch_recovered";
    if (
      !recommendation ||
      (recommendation.state !== "running" && !canAcceptRecoveredDispatchCompletion)
    )
      return "stale";
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
      return "stale";
    }
    let state = args.state;
    if (state === "succeeded") {
      const [policy, project] = await Promise.all([
        ctx.db.get(recommendation.admissionPolicyVersionId),
        ctx.db.get(recommendation.projectVersionId),
      ]);
      const intakePolicy = project ? await ctx.db.get(project.intakePolicyVersionId) : null;
      const expectedKeys = policy?.criteria.map((criterion) => criterion.criterionKey) ?? [];
      const validProjectResponses = Boolean(
        project &&
        intakePolicy &&
        intakePolicy.eventId === recommendation.eventId &&
        (intakePolicy.status === "published" || intakePolicy.status === "superseded") &&
        validSubmittedIntakeResponses(project.intakeResponses, intakePolicy),
      );
      const availableSourceRefs = new Set<SourceRef>(["initial_idea"]);
      if (project?.additionalInformation) {
        availableSourceRefs.add("additional_information");
      }
      if (project && validProjectResponses) {
        for (const response of project.intakeResponses) {
          availableSourceRefs.add(followUpSourceRef(response.ordinal));
        }
      }
      const policyViolation =
        args.recommendation && args.confidence
          ? ideaIntelligenceAnalysisPolicyViolation({
              analysis: {
                recommendation: args.recommendation,
                criterionAssessments: args.criterionAssessments,
                strengths: args.strengths,
                concerns: args.concerns,
                confidence: args.confidence,
                limitations: args.limitations,
              },
              criterionKeys: expectedKeys,
              sourceRefs: [...availableSourceRefs],
            })
          : "shape_mismatch";
      const valid =
        project?.eventId === recommendation.eventId &&
        validProjectResponses &&
        expectedKeys.length > 0 &&
        policyViolation === null;
      if (!valid) state = "invalid";
    }
    const succeeded = state === "succeeded";
    await ctx.db.patch(recommendation._id, {
      state,
      recommendation: succeeded ? args.recommendation : undefined,
      criterionAssessments: succeeded ? args.criterionAssessments : [],
      strengths: succeeded ? args.strengths : [],
      concerns: succeeded ? args.concerns : [],
      confidence: succeeded ? args.confidence : undefined,
      limitations: args.limitations,
      providerRequestId: args.providerRequestId,
      agentOperationId: args.operationId,
      agentOutputChecksum,
      agentVersion: args.agentVersion,
      agentModel: args.agentModel,
      agentDispatchAttemptId: undefined,
      agentSubmissionId: undefined,
      agentAcceptedAt: undefined,
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
    return "accepted";
  },
});
