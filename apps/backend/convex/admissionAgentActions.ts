import {
  ideaIntelligenceIngressSignatureContext,
  ideaIntelligenceRecoveryLeaseMs,
  operationsIntelligenceProtocolVersion,
  signServiceBody,
  type IdeaIntelligenceDispatchRequest,
} from "@code2create/domain";
import { v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { readBoundedJsonResponse } from "./lib/boundedHttpBody";
import {
  requireIntelligenceHmacSecret,
  requireIntelligenceWorkerOrigin,
} from "./lib/intelligenceServiceConfiguration";

const dispatchContext = v.object({
  recommendationId: v.id("admissionAIRecommendations"),
  applicationId: v.id("applications"),
  eventId: v.id("events"),
  modelId: v.string(),
  promptVersion: v.string(),
  schemaVersion: v.string(),
  evaluationSuiteVersion: v.string(),
  contentVersion: v.number(),
  attemptId: v.string(),
});

export const prepareDispatch = internalMutation({
  args: { recommendationId: v.id("admissionAIRecommendations") },
  returns: v.union(v.null(), dispatchContext),
  handler: async (ctx, args) => {
    const recommendation = await ctx.db.get(args.recommendationId);
    if (
      !recommendation ||
      recommendation.state !== "pending" ||
      recommendation.agentDispatchAttemptId ||
      recommendation.agentSubmissionId
    )
      return null;
    const application = await ctx.db.get(recommendation.applicationId);
    if (
      !application ||
      application.eventId !== recommendation.eventId ||
      application.aiRecommendationId !== recommendation._id ||
      application.contentVersion !== recommendation.applicationContentVersion
    )
      return null;
    const modelConfig = recommendation.modelConfigVersionId
      ? await ctx.db.get(recommendation.modelConfigVersionId)
      : null;
    if (!modelConfig || modelConfig.eventId !== application.eventId) return null;
    const attemptId = crypto.randomUUID();
    await ctx.db.patch(recommendation._id, { agentDispatchAttemptId: attemptId });
    return {
      recommendationId: recommendation._id,
      applicationId: application._id,
      eventId: application.eventId,
      modelId: modelConfig.modelId,
      promptVersion: modelConfig.promptVersion,
      schemaVersion: modelConfig.schemaVersion,
      evaluationSuiteVersion: modelConfig.evaluationSuiteVersion,
      contentVersion: application.contentVersion,
      attemptId,
    };
  },
});

export const recordDispatchReceipt = internalMutation({
  args: {
    recommendationId: v.id("admissionAIRecommendations"),
    attemptId: v.string(),
    submissionId: v.string(),
    acceptedAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const recommendation = await ctx.db.get(args.recommendationId);
    if (
      !recommendation ||
      (recommendation.state !== "pending" && recommendation.state !== "running") ||
      recommendation.agentDispatchAttemptId !== args.attemptId
    )
      return false;
    await ctx.db.patch(recommendation._id, {
      agentDispatchAttemptId: undefined,
      agentSubmissionId: args.submissionId,
      agentAcceptedAt: args.acceptedAt,
    });
    await ctx.scheduler.runAfter(
      ideaIntelligenceRecoveryLeaseMs,
      internal.admissionIntelligence.recoverAgentRecommendation,
      {
        recommendationId: recommendation._id,
        submissionId: args.submissionId,
      },
    );
    return true;
  },
});

export const recordDispatchFailure = internalMutation({
  args: {
    recommendationId: v.id("admissionAIRecommendations"),
    attemptId: v.string(),
    workerMayHaveAccepted: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const recommendation = await ctx.db.get(args.recommendationId);
    if (
      !recommendation ||
      (recommendation.state !== "pending" && recommendation.state !== "running") ||
      recommendation.agentDispatchAttemptId !== args.attemptId
    )
      return false;
    if (args.workerMayHaveAccepted) {
      await ctx.scheduler.runAfter(
        ideaIntelligenceRecoveryLeaseMs,
        internal.admissionIntelligence.recoverAgentDispatchAttempt,
        {
          recommendationId: recommendation._id,
          attemptId: args.attemptId,
        },
      );
      return true;
    }
    if (recommendation.state !== "pending") return false;
    await ctx.db.patch(recommendation._id, {
      agentDispatchAttemptId: undefined,
    });
    return true;
  },
});

export const currentRecommendation = internalQuery({
  args: { applicationId: v.string(), eventId: v.string() },
  returns: v.union(v.null(), v.id("admissionAIRecommendations")),
  handler: async (ctx, args) => {
    const applicationId = ctx.db.normalizeId("applications", args.applicationId);
    const eventId = ctx.db.normalizeId("events", args.eventId);
    if (!applicationId || !eventId) return null;
    const application = await ctx.db.get(applicationId);
    if (!application || application.eventId !== eventId || !application.aiRecommendationId) {
      return null;
    }
    const recommendation = await ctx.db.get(application.aiRecommendationId);
    if (
      !recommendation ||
      recommendation.applicationId !== application._id ||
      recommendation.applicationContentVersion !== application.contentVersion ||
      (recommendation.state !== "pending" && recommendation.state !== "running")
    )
      return null;
    return recommendation._id;
  },
});

export const prepareProjectionIdentity = internalQuery({
  args: { recommendationId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      recommendationId: v.id("admissionAIRecommendations"),
      applicationId: v.id("applications"),
      eventId: v.id("events"),
      contentVersion: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const recommendationId = ctx.db.normalizeId(
      "admissionAIRecommendations",
      args.recommendationId,
    );
    if (!recommendationId) return null;
    const recommendation = await ctx.db.get(recommendationId);
    if (!recommendation) return null;
    return {
      recommendationId: recommendation._id,
      applicationId: recommendation.applicationId,
      eventId: recommendation.eventId,
      contentVersion: recommendation.applicationContentVersion,
    };
  },
});

const receiptSchema = z
  .object({
    state: z.literal("accepted"),
    applicationId: z.string().min(1).max(200),
    instanceId: z.string().min(1).max(200),
    submissionId: z.string().min(1).max(200),
    acceptedAt: z.iso.datetime(),
  })
  .strict();

export const dispatchRecommendation = internalAction({
  args: { recommendationId: v.id("admissionAIRecommendations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const prepared = await ctx.runMutation(internal.admissionAgentActions.prepareDispatch, args);
    if (!prepared) return null;
    let workerMayHaveAccepted = false;
    try {
      const request: IdeaIntelligenceDispatchRequest = {
        protocolVersion: operationsIntelligenceProtocolVersion,
        recommendationId: prepared.recommendationId,
        applicationId: prepared.applicationId,
        eventId: prepared.eventId,
        modelId: prepared.modelId,
        promptVersion: prepared.promptVersion,
        schemaVersion: prepared.schemaVersion,
        evaluationSuiteVersion: prepared.evaluationSuiteVersion,
        contentVersion: prepared.contentVersion,
      };
      const body = JSON.stringify(request);
      const timestamp = String(Date.now());
      const signature = await signServiceBody({
        context: ideaIntelligenceIngressSignatureContext,
        secret: requireIntelligenceHmacSecret("INTELLIGENCE_INGRESS_SECRET"),
        timestamp,
        body,
      });
      workerMayHaveAccepted = true;
      const response = await fetch(
        new URL("/v1/idea-submissions", requireIntelligenceWorkerOrigin()),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-c2c-signature": signature,
            "x-c2c-timestamp": timestamp,
          },
          body,
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) {
        throw new Error(`The idea intelligence Worker returned HTTP ${response.status}.`);
      }
      const receipt = receiptSchema.safeParse(await readBoundedJsonResponse(response, 8 * 1_024));
      if (
        !receipt.success ||
        receipt.data.applicationId !== prepared.applicationId ||
        receipt.data.instanceId !== prepared.recommendationId
      ) {
        throw new Error("The idea intelligence Worker returned an invalid receipt.");
      }
      await ctx.runMutation(internal.admissionAgentActions.recordDispatchReceipt, {
        recommendationId: prepared.recommendationId,
        attemptId: prepared.attemptId,
        submissionId: receipt.data.submissionId,
        acceptedAt: Date.parse(receipt.data.acceptedAt),
      });
    } catch (error) {
      const recorded = await ctx.runMutation(internal.admissionAgentActions.recordDispatchFailure, {
        recommendationId: prepared.recommendationId,
        attemptId: prepared.attemptId,
        workerMayHaveAccepted,
      });
      if (recorded) throw error;
    }
    return null;
  },
});
