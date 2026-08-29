import {
  ideaIntelligenceIngressSignatureContext,
  operationsIntelligenceProtocolVersion,
  signServiceBody,
  type IdeaIntelligenceDispatchRequest,
} from "@code2create/domain";
import { v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
import { readBoundedJsonResponse } from "./lib/boundedHttpBody";
import {
  requireIntelligenceHmacSecret,
  requireIntelligenceWorkerOrigin,
} from "./lib/intelligenceServiceConfiguration";

const dispatchContext = v.object({
  recommendationId: v.id("admissionAIRecommendations"),
  applicationId: v.id("applications"),
  eventId: v.id("events"),
  contentVersion: v.number(),
});

export const prepareDispatch = internalQuery({
  args: { recommendationId: v.id("admissionAIRecommendations") },
  returns: v.union(v.null(), dispatchContext),
  handler: async (ctx, args) => {
    const recommendation = await ctx.db.get(args.recommendationId);
    if (!recommendation || recommendation.state !== "pending") return null;
    const application = await ctx.db.get(recommendation.applicationId);
    if (
      !application ||
      application.eventId !== recommendation.eventId ||
      application.aiRecommendationId !== recommendation._id ||
      application.contentVersion !== recommendation.applicationContentVersion
    ) return null;
    return {
      recommendationId: recommendation._id,
      applicationId: application._id,
      eventId: application.eventId,
      contentVersion: application.contentVersion,
    };
  },
});

const receiptSchema = z.object({
  state: z.literal("accepted"),
  applicationId: z.string().min(1).max(200),
  instanceId: z.string().min(1).max(200),
  submissionId: z.string().min(1).max(200),
  acceptedAt: z.iso.datetime(),
}).strict();

export const dispatchRecommendation = internalAction({
  args: { recommendationId: v.id("admissionAIRecommendations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const prepared = await ctx.runQuery(internal.admissionAgentActions.prepareDispatch, args);
    if (!prepared) return null;
    const request: IdeaIntelligenceDispatchRequest = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      recommendationId: prepared.recommendationId,
      applicationId: prepared.applicationId,
      eventId: prepared.eventId,
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
      receipt.data.instanceId !== prepared.applicationId
    ) {
      throw new Error("The idea intelligence Worker returned an invalid receipt.");
    }
    return null;
  },
});
