import {
  operationsEpisodeCallbackSignatureContext,
  operationsEpisodeExpectedStates,
  operationsEpisodeReadSignatureContext,
  operationsIntelligenceProtocolVersion,
  verifyServiceBody,
} from "@code2create/domain";
import { ConvexError } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { HttpBodyTooLargeError, readBoundedRequestText } from "./lib/boundedHttpBody";
import { requireIntelligenceHmacSecret } from "./lib/intelligenceServiceConfiguration";

const maximumSignatureAgeMs = 5 * 60 * 1_000;

const readRequestSchema = z
  .object({
    protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
    episodeId: z.string().min(1).max(200),
    operationId: z.string().min(8).max(240),
  })
  .strict();

const evidenceKeys = z.array(z.string().min(1).max(240)).min(1).max(8);
const callbackSchema = z
  .object({
    protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
    episodeId: z.string().min(1).max(200),
    revision: z.number().int().positive(),
    operationId: z.string().min(8).max(240),
    summary: z.string().min(12).max(600),
    confidence: z.number().min(0).max(1),
    suggestedAction: z.string().min(8).max(300),
    hypotheses: z
      .array(
        z
          .object({
            stance: z.enum(["leading", "alternative", "rejected"]),
            statement: z.string().min(8).max(400),
            confidence: z.number().min(0).max(1),
            evidenceFactKeys: evidenceKeys,
          })
          .strict(),
      )
      .min(1)
      .max(3),
    predictions: z
      .array(
        z
          .object({
            statement: z.string().min(8).max(400),
            expectedState: z.enum(operationsEpisodeExpectedStates),
            probability: z.number().min(0).max(1),
            horizonAt: z.number().int().positive(),
            evidenceFactKeys: evidenceKeys,
          })
          .strict(),
      )
      .max(3),
    counterfactuals: z
      .array(
        z
          .object({
            intervention: z.string().min(8).max(300),
            expectedState: z.enum(operationsEpisodeExpectedStates),
            probability: z.number().min(0).max(1),
            rationale: z.string().min(8).max(400),
            evidenceFactKeys: evidenceKeys,
          })
          .strict(),
      )
      .max(3),
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

export const operationsEpisodeReadEndpoint = httpAction(async (ctx, request) => {
  const body = await verifiedBody(
    request,
    operationsEpisodeReadSignatureContext,
    "INTELLIGENCE_READ_SECRET",
    8 * 1_024,
  );
  if (body.response) return body.response;
  const parsed = readRequestSchema.safeParse(body.json);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const projection = await ctx.runQuery(internal.operationsEpisodes.serviceProjection, {
    episodeId: parsed.data.episodeId,
    operationId: parsed.data.operationId,
  });
  if (!projection) return Response.json({ error: "authority_revoked" }, { status: 409 });
  return new Response(projection, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

export const operationsEpisodeCallbackEndpoint = httpAction(async (ctx, request) => {
  const body = await verifiedBody(
    request,
    operationsEpisodeCallbackSignatureContext,
    "INTELLIGENCE_CALLBACK_SECRET",
    64 * 1_024,
  );
  if (body.response) return body.response;
  const parsed = callbackSchema.safeParse(body.json);
  if (!parsed.success) return Response.json({ error: "invalid_callback" }, { status: 422 });
  const { protocolVersion: _protocolVersion, ...analysis } = parsed.data;
  try {
    const result = await ctx.runMutation(internal.operationsEpisodes.recordAnalysis, analysis);
    if (result === "accepted" || result === "already_exists") {
      return Response.json({ state: result }, { status: 202 });
    }
    return Response.json({ error: "stale_episode" }, { status: 409 });
  } catch (error) {
    if (error instanceof ConvexError) {
      return Response.json({ error: "callback_rejected" }, { status: 422 });
    }
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }
});
