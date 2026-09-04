import {
  ideaIntelligenceCallbackSignatureContext,
  ideaIntelligenceReadSignatureContext,
  operationsIntelligenceProtocolVersion,
  verifyServiceBody,
  type IdeaIntelligenceProjection,
} from "@code2create/domain";
import { z } from "zod";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { searchSimilarIdeas } from "./admissionIdeaSimilarity";
import { HttpBodyTooLargeError, readBoundedRequestText } from "./lib/boundedHttpBody";
import { requireIntelligenceHmacSecret } from "./lib/intelligenceServiceConfiguration";
import { redactProjectText } from "./lib/projectText";

const maximumSignatureAgeMs = 5 * 60 * 1_000;

const readRequestSchema = z
  .object({
    protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
    applicationId: z.string().min(1).max(200),
    eventId: z.string().min(1).max(200),
    recommendationId: z.string().min(1).max(200).optional(),
    operationId: z.string().min(8).max(240),
  })
  .strict();

const similarityRequestSchema = z
  .object({
    protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
    operation: z.literal("find_similar_ideas"),
    recommendationId: z.string().min(1).max(200),
    applicationId: z.string().min(1).max(200),
    eventId: z.string().min(1).max(200),
    contentVersion: z.number().int().positive(),
    sourceInputFingerprint: z.string().min(1).max(240),
    sourceRefs: z.array(z.string().min(1).max(80)).min(1).max(4),
    operationId: z.string().min(8).max(240),
  })
  .strict();

const callbackSchema = z
  .object({
    protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
    recommendationId: z.string().min(1).max(200),
    applicationId: z.string().min(1).max(200),
    contentVersion: z.number().int().positive(),
    sourceInputFingerprint: z.string().min(1).max(240),
    operationId: z.string().min(8).max(240),
    recommendation: z.enum(["accept", "waitlist", "decline"]),
    centralProposalConsistency: z
      .object({
        assessment: z.enum(["consistent", "contradictory"]),
        sourceRefs: z.array(z.string().min(1).max(80)).min(1).max(2),
      })
      .strict(),
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
    confidence: z.enum(["low", "medium", "high"]),
    limitations: z.array(z.string().min(3).max(180)).max(3),
    agentVersion: z.string().min(3).max(120),
    model: z.string().min(3).max(120),
    completedAt: z.number().int().positive(),
  })
  .strict();

async function verifiedBody(
  request: Request,
  context: string,
  secretName: string,
  maximumBytes: number,
) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return { response: Response.json({ error: "unsupported_media_type" }, { status: 415 }) };
  }
  let body: string;
  try {
    body = await readBoundedRequestText(request, maximumBytes);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError) {
      return { response: Response.json({ error: "payload_too_large" }, { status: 413 }) };
    }
    throw error;
  }
  let verified = false;
  try {
    verified = await verifyServiceBody({
      context,
      secret: requireIntelligenceHmacSecret(secretName),
      timestamp: request.headers.get("x-c2c-timestamp") ?? "",
      signature: request.headers.get("x-c2c-signature") ?? "",
      body,
      now: Date.now(),
      maximumAgeMs: maximumSignatureAgeMs,
    });
  } catch {
    return { response: Response.json({ error: "service_unavailable" }, { status: 503 }) };
  }
  if (!verified) return { response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { response: Response.json({ error: "invalid_json" }, { status: 400 }) };
  }
  return { json };
}

export const ideaIntelligenceReadEndpoint = httpAction(async (ctx, request) => {
  const body = await verifiedBody(
    request,
    ideaIntelligenceReadSignatureContext,
    "INTELLIGENCE_READ_SECRET",
    8 * 1_024,
  );
  if (body.response) return body.response;
  const parsed = readRequestSchema.safeParse(body.json);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const currentRecommendationId = parsed.data.recommendationId
    ? parsed.data.recommendationId
    : await ctx.runQuery(internal.admissionAgentActions.currentRecommendation, {
        applicationId: parsed.data.applicationId,
        eventId: parsed.data.eventId,
      });
  if (!currentRecommendationId) {
    return Response.json({ error: "authority_revoked" }, { status: 409 });
  }
  const recommendation = await ctx.runQuery(
    internal.admissionAgentActions.prepareProjectionIdentity,
    { recommendationId: currentRecommendationId },
  );
  if (
    !recommendation ||
    recommendation.applicationId !== parsed.data.applicationId ||
    recommendation.eventId !== parsed.data.eventId
  )
    return Response.json({ error: "authority_revoked" }, { status: 409 });
  const projection = await ctx.runMutation(internal.admissionIntelligence.beginRecommendation, {
    recommendationId: recommendation.recommendationId,
  });
  if (!projection || projection.applicationId !== parsed.data.applicationId)
    return Response.json({ error: "authority_revoked" }, { status: 409 });
  const result: IdeaIntelligenceProjection = {
    protocolVersion: operationsIntelligenceProtocolVersion,
    recommendationId: recommendation.recommendationId,
    applicationId: projection.applicationId,
    eventId: recommendation.eventId,
    modelId: projection.modelId,
    promptVersion: projection.promptVersion,
    schemaVersion: projection.schemaVersion,
    evaluationSuiteVersion: projection.evaluationSuiteVersion,
    contentVersion: recommendation.contentVersion,
    sourceInputFingerprint: projection.sourceInputFingerprint,
    experienceBand: projection.experienceBand,
    overallParticipantCapacity: projection.overallParticipantCapacity,
    sources: [
      { sourceRef: "initial_idea", answer: redactProjectText(projection.initialIdea) },
      ...(projection.additionalInformation
        ? [
            {
              sourceRef: "additional_information",
              question: "Additional information or links (optional, please no PPTs)",
              answer: redactProjectText(projection.additionalInformation),
            },
          ]
        : []),
      ...projection.intakeResponses.map((source) => ({
        sourceRef: source.sourceRef,
        question: source.question,
        answer: redactProjectText(source.answer),
      })),
    ],
    criteria: projection.criteria,
  };
  return Response.json(result, { status: 200 });
});

export const ideaIntelligenceSimilarityEndpoint = httpAction(async (ctx, request) => {
  const body = await verifiedBody(
    request,
    ideaIntelligenceReadSignatureContext,
    "INTELLIGENCE_READ_SECRET",
    16 * 1_024,
  );
  if (body.response) return body.response;
  const parsed = similarityRequestSchema.safeParse(body.json);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return Response.json({ error: "service_unavailable" }, { status: 503 });
  const result = await searchSimilarIdeas(ctx, {
    request: parsed.data,
    apiKey,
  });
  if (result === null) return Response.json({ error: "authority_revoked" }, { status: 409 });
  if (result === "invalid_sources") {
    return Response.json({ error: "invalid_source_refs" }, { status: 422 });
  }
  return Response.json(result, { status: 200 });
});

export const ideaIntelligenceCallbackEndpoint = httpAction(async (ctx, request) => {
  const body = await verifiedBody(
    request,
    ideaIntelligenceCallbackSignatureContext,
    "INTELLIGENCE_CALLBACK_SECRET",
    64 * 1_024,
  );
  if (body.response) return body.response;
  const parsed = callbackSchema.safeParse(body.json);
  if (!parsed.success) return Response.json({ error: "invalid_callback" }, { status: 422 });
  const identity = await ctx.runQuery(internal.admissionAgentActions.prepareProjectionIdentity, {
    recommendationId: parsed.data.recommendationId,
  });
  if (
    !identity ||
    identity.applicationId !== parsed.data.applicationId ||
    identity.contentVersion !== parsed.data.contentVersion
  )
    return Response.json({ error: "stale_analysis" }, { status: 409 });
  const result = await ctx.runMutation(internal.admissionIntelligence.finishRecommendation, {
    recommendationId: identity.recommendationId,
    sourceInputFingerprint: parsed.data.sourceInputFingerprint,
    state: "succeeded",
    recommendation: parsed.data.recommendation,
    centralProposalConsistency: parsed.data.centralProposalConsistency,
    criterionAssessments: parsed.data.criterionAssessments,
    strengths: parsed.data.strengths,
    concerns: parsed.data.concerns,
    confidence: parsed.data.confidence,
    limitations: parsed.data.limitations,
    operationId: parsed.data.operationId,
    agentVersion: parsed.data.agentVersion,
    agentModel: parsed.data.model,
  });
  if (result === "accepted" || result === "already_exists") {
    return Response.json({ state: result }, { status: 202 });
  }
  return Response.json({ error: "stale_analysis" }, { status: 409 });
});
