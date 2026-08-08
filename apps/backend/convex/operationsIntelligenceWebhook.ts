import {
  operationsBriefPrioritySeverities,
  operationsHealthSignalKeys,
  operationsIntelligenceCallbackSignatureContext,
  operationsIntelligenceProtocolVersion,
  verifyServiceBody,
} from "@code2create/domain";
import { z } from "zod";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const maximumBodyBytes = 24 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;

const callbackBase = {
  protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
  briefId: z.string().min(1).max(200),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  agentVersion: z.string().min(1).max(80),
  model: z.string().min(3).max(160),
  completedAt: z.number().int().nonnegative(),
};

const priority = z
  .object({
    severity: z.enum(operationsBriefPrioritySeverities),
    title: z.string().min(3).max(120),
    why: z.string().min(8).max(300),
    owner: z.string().min(2).max(80),
    nextAction: z.string().min(4).max(240),
    signalKeys: z.array(z.enum(operationsHealthSignalKeys)).min(1).max(6),
  })
  .strict();

const callback = z.discriminatedUnion("status", [
  z
    .object({
      ...callbackBase,
      status: z.literal("succeeded"),
      headline: z.string().min(3).max(100),
      summary: z.string().min(10).max(600),
      priorities: z.array(priority).max(3),
    })
    .strict(),
  z
    .object({
      ...callbackBase,
      status: z.literal("failed"),
      failureCode: z.enum(["model_did_not_publish", "callback_rejected"]),
    })
    .strict(),
]);

function callbackSecret() {
  const value = process.env.INTELLIGENCE_CALLBACK_SECRET?.trim();
  if (!value) throw new Error("INTELLIGENCE_CALLBACK_SECRET is not configured.");
  return value;
}

export const operationsIntelligenceWebhook = httpAction(async (ctx, request) => {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return Response.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const timestamp = request.headers.get("x-c2c-timestamp") ?? "";
  const signature = request.headers.get("x-c2c-signature") ?? "";
  let verified = false;
  try {
    verified = await verifyServiceBody({
      context: operationsIntelligenceCallbackSignatureContext,
      secret: callbackSecret(),
      timestamp,
      signature,
      body,
      now: Date.now(),
      maximumAgeMs: maximumSignatureAgeMs,
    });
  } catch {
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }
  if (!verified) return Response.json({ error: "unauthorized" }, { status: 401 });
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = callback.safeParse(json);
  if (!parsed.success) return Response.json({ error: "invalid_callback" }, { status: 422 });
  try {
    const result = await ctx.runMutation(internal.operationsIntelligence.completeFromWorker, {
      callback: parsed.data,
    });
    if (result === "accepted" || result === "already_settled") {
      return Response.json({ state: result }, { status: 202 });
    }
    return Response.json({ error: result }, { status: 409 });
  } catch {
    return Response.json({ error: "callback_rejected" }, { status: 422 });
  }
});
