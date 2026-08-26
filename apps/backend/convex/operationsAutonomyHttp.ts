import {
  intelligenceRecommendationKinds,
  operationsAutonomyCallbackSignatureContext,
  operationsAutonomyReadSignatureContext,
  operationsAutonomyReadTools,
  operationsAutonomyRecommendationSignatureContext,
  operationsAutonomyRecommendationEvidenceSignatureContext,
  operationsAutonomyRecommendationEvidenceChunkMaximumCitations,
  operationsAutonomyRunPhases,
  operationsAutonomyWorkSignatureContext,
  operationsHealthAreas,
  operationsHealthSignalKeys,
  operationsIntelligenceProtocolVersion,
  verifyServiceBody,
  type OperationsAutonomyReadRequest,
} from "@code2create/domain";
import { ConvexError } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { HttpBodyTooLargeError, readBoundedRequestText } from "./lib/boundedHttpBody";
import { requireIntelligenceHmacSecret } from "./lib/intelligenceServiceConfiguration";

const maximumBodyBytes = 24 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;
const operationId = z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const runIdentity = {
  protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
  runId: z.string().min(1).max(200),
  policyVersionId: z.string().min(1).max(200),
  policyChecksum: digest,
  sourceChecksum: digest,
  operationId,
};

const readRequest = z.object({
  ...runIdentity,
  read: z.enum(operationsAutonomyReadTools),
  cursor: z.string().min(1).max(1_024).optional(),
}).strict();

const workRequest = z.object({
  ...runIdentity,
  operation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("model") }).strict(),
    z.object({ kind: z.literal("delegation"), area: z.enum(operationsHealthAreas) }).strict(),
  ]),
}).strict();

const supportCategories = [
  "identity", "team", "project_intake",
  "attendance_credential", "missing_scan", "scanner_device", "table_location",
  "integration", "queue", "reviewer_device", "scorecard", "accessibility", "safety",
] as const;

const recommendationArguments = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hold_review_team"),
    teamRoundStateId: z.string().min(1).max(64),
    expectedTeamRoundStateVersion: z.number().int().positive(),
    reason: z.string().min(5).max(500),
  }).strict(),
  z.object({
    kind: z.literal("page_reserve_reviewer"),
    missingPanelMemberId: z.string().min(1).max(64),
    expectedPanelVersion: z.number().int().positive(),
    reason: z.string().min(5).max(500),
  }).strict(),
  z.object({
    kind: z.literal("open_support_case"),
    category: z.enum(supportCategories),
    description: z.string().min(10).max(2_000),
    roundId: z.string().min(1).max(64).optional(),
    teamId: z.string().min(1).max(64).optional(),
  }).strict(),
  z.object({
    kind: z.literal("dismiss_attention_item"),
    itemId: z.string().min(1).max(64),
    expectedItemVersion: z.number().int().positive(),
    reason: z.string().min(5).max(500),
  }).strict(),
]);

const citation = z.object({
  read: z.enum(operationsAutonomyReadTools),
  generatedAt: z.number().int().nonnegative(),
  keys: z.array(z.string().min(1).max(200)).min(1).max(16),
  operationId,
  snapshot: z.string().min(1).max(200),
}).strict();

const recommendationRequest = z.object({
  ...runIdentity,
  proposalKey: z.string().min(8).max(200),
  eventSlug: z.string().min(1).max(120),
  agentVersion: z.string().min(1).max(80),
  model: z.string().min(3).max(160),
  statement: z.string().min(10).max(300),
  reasoning: z.string().min(10).max(1_500),
  evidenceSet: z.object({
    evidenceSetId: operationId,
    rootHash: digest,
    leafCount: z.number().int().positive(),
    chunkCount: z.number().int().positive(),
    sealedSequence: z.number().int().positive(),
  }).strict(),
  targetCitationIdentity: digest.optional(),
  arguments: recommendationArguments,
}).strict().superRefine((value, context) => {
  if (!intelligenceRecommendationKinds.includes(value.arguments.kind)) {
    context.addIssue({ code: "custom", message: "Unsupported recommendation kind." });
  }
});

const recommendationEvidenceRequest = z.object({
  ...runIdentity,
  proposalKey: operationId,
  evidenceSetId: operationId,
  pageIndex: z.number().int().nonnegative(),
  previousPageHash: digest.optional(),
  citations: z.array(citation)
    .min(1)
    .max(operationsAutonomyRecommendationEvidenceChunkMaximumCitations),
  isDone: z.boolean(),
}).strict();

const callbackBase = {
  ...runIdentity,
  agentVersion: z.string().min(1).max(80),
  model: z.string().min(3).max(160),
  observedSignalKeys: z.array(z.enum(operationsHealthSignalKeys)).max(operationsHealthSignalKeys.length),
};

const callbackRequest = z.discriminatedUnion("status", [
  z.object({
    ...callbackBase,
    status: z.literal("running"),
    phase: z.enum(operationsAutonomyRunPhases.filter((phase) => phase !== "terminal")),
  }).strict(),
  z.object({
    ...callbackBase,
    status: z.enum(["succeeded", "no_op", "escalated"]),
    phase: z.literal("terminal"),
  }).strict(),
  z.object({
    ...callbackBase,
    status: z.literal("failed"),
    phase: z.literal("terminal"),
    failureCode: z.enum(["provider_failed", "tool_failed", "policy_violation", "callback_rejected"]),
  }).strict(),
]);

type SignedContext =
  | typeof operationsAutonomyReadSignatureContext
  | typeof operationsAutonomyWorkSignatureContext
  | typeof operationsAutonomyRecommendationSignatureContext
  | typeof operationsAutonomyRecommendationEvidenceSignatureContext
  | typeof operationsAutonomyCallbackSignatureContext;

type SignedBody = { response: Response } | { value: unknown };

async function signedBody(request: Request, context: SignedContext): Promise<SignedBody> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return { response: Response.json({ error: "unsupported_media_type" }, { status: 415 }) };
  }
  let body: string;
  try {
    body = await readBoundedRequestText(request, maximumBodyBytes);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError) {
      return { response: Response.json({ error: "payload_too_large" }, { status: 413 }) };
    }
    throw error;
  }
  try {
    const verified = await verifyServiceBody({
      context,
      secret: requireIntelligenceHmacSecret(
        context === operationsAutonomyReadSignatureContext ||
          context === operationsAutonomyWorkSignatureContext
          ? "INTELLIGENCE_READ_SECRET"
          : "INTELLIGENCE_CALLBACK_SECRET",
      ),
      timestamp: request.headers.get("x-c2c-timestamp") ?? "",
      signature: request.headers.get("x-c2c-signature") ?? "",
      body,
      now: Date.now(),
      maximumAgeMs: maximumSignatureAgeMs,
    });
    if (!verified) return { response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  } catch {
    return { response: Response.json({ error: "service_unavailable" }, { status: 503 }) };
  }
  try {
    const value: unknown = JSON.parse(body);
    return { value };
  } catch {
    return { response: Response.json({ error: "invalid_json" }, { status: 400 }) };
  }
}

function citationRows(value: unknown) {
  const rows: string[][] = [];
  const visit = (candidate: unknown) => {
    if (rows.length >= 64) return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    const entries = Object.entries(candidate);
    const facts = new Set<string>();
    for (const [, child] of entries) {
      if (
        (typeof child === "string" && child.length <= 200) ||
        (typeof child === "number" && Number.isSafeInteger(child))
      ) facts.add(String(child));
    }
    if (facts.size > 0) rows.push([...facts].sort());
    for (const [, child] of entries) visit(child);
  };
  visit(value);
  return rows;
}

function rejectedOperation() {
  return Response.json({ error: "authority_revoked" }, { status: 409 });
}

function rejection(error: unknown): Response {
  if (error instanceof ConvexError) {
    const data = error.data;
    const code =
      typeof data === "object" && data !== null && "code" in data && typeof data.code === "string"
        ? data.code
        : "OPERATIONS_AUTONOMY_REJECTED";
    if (code === "OPERATIONS_AUTONOMY_OPERATION_CONFLICT") {
      return Response.json({ error: "operation_conflict" }, { status: 409 });
    }
    if (code === "OPERATIONS_AUTONOMY_RUN_TERMINAL") {
      return Response.json({ error: "run_terminal" }, { status: 409 });
    }
    return Response.json({ error: "request_rejected" }, { status: 422 });
  }
  return Response.json({ error: "service_unavailable" }, { status: 503 });
}

export const autonomyReadEndpoint = httpAction(async (ctx, request) => {
  const signed = await signedBody(request, operationsAutonomyReadSignatureContext);
  if ("response" in signed) return signed.response;
  const parsed = readRequest.safeParse(signed.value);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const { cursor, ...readBase } = parsed.data;
  const read: OperationsAutonomyReadRequest = {
    ...readBase,
    ...(cursor === undefined ? {} : { cursor }),
  };
  try {
    const prepared = await ctx.runMutation(internal.operationsAutonomyReads.prepareRead, {
      request: read,
      now: Date.now(),
    });
    if (prepared.state === "rejected") return rejectedOperation();
    if (prepared.state === "replay") {
      return new Response(prepared.responseJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    let page;
    try {
      if (prepared.state === "capture") {
        const dataJson = await ctx.runAction(
          internal.operationsAutonomyReadPages.captureProjection,
          {
            eventId: prepared.eventId,
            read: prepared.read,
            generatedAt: prepared.generatedAt,
          },
        );
        await ctx.runMutation(internal.operationsAutonomyReads.storeFrozenTraversal, {
          request: read,
          dataJson,
          generatedAt: prepared.generatedAt,
          now: Date.now(),
        });
      }
      page = await ctx.runQuery(internal.operationsAutonomyReadPages.executePage, {
        runId: prepared.runId,
        read: prepared.read,
        cursorStateJson: prepared.cursorStateJson,
      });
    } catch {
      return Response.json({ error: "read_unavailable" }, { status: 503 });
    }
    const data: unknown = JSON.parse(page.dataJson);
    const dataBytes = new TextEncoder().encode(page.dataJson).byteLength;
    if (dataBytes > prepared.maximumBytes) {
      return Response.json({ error: "read_page_too_large" }, { status: 503 });
    }
    const committed = await ctx.runMutation(internal.operationsAutonomyReads.commitRead, {
      request: read,
      dataJson: page.dataJson,
      dataBytes,
      generatedAt: page.generatedAt,
      citationRows: citationRows(data),
      isDone: page.isDone,
      ...(page.nextCursorStateJson === undefined
        ? {}
        : { nextCursorStateJson: page.nextCursorStateJson }),
      now: Date.now(),
    });
    if (committed.state === "rejected") return rejectedOperation();
    return new Response(committed.responseJson, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return rejection(error);
  }
});

export const autonomyWorkEndpoint = httpAction(async (ctx, request) => {
  const signed = await signedBody(request, operationsAutonomyWorkSignatureContext);
  if ("response" in signed) return signed.response;
  const parsed = workRequest.safeParse(signed.value);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  try {
    const result = await ctx.runMutation(internal.operationsAutonomyOperations.authorizeWork, {
      request: parsed.data,
      now: Date.now(),
    });
    if (result.state === "rejected") return rejectedOperation();
    return new Response(result.responseJson, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return rejection(error);
  }
});

export const autonomyRecommendationEndpoint = httpAction(async (ctx, request) => {
  const signed = await signedBody(request, operationsAutonomyRecommendationSignatureContext);
  if ("response" in signed) return signed.response;
  const parsed = recommendationRequest.safeParse(signed.value);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const argumentsValue = parsed.data.arguments.kind === "open_support_case"
    ? {
        kind: parsed.data.arguments.kind,
        category: parsed.data.arguments.category,
        description: parsed.data.arguments.description,
        ...(parsed.data.arguments.roundId === undefined ? {} : { roundId: parsed.data.arguments.roundId }),
        ...(parsed.data.arguments.teamId === undefined ? {} : { teamId: parsed.data.arguments.teamId }),
      }
    : parsed.data.arguments;
  const { targetCitationIdentity, ...recommendationBase } = parsed.data;
  try {
    const result = await ctx.runMutation(
      internal.operationsAutonomyRecommendations.proposeRecommendation,
      {
        request: {
          ...recommendationBase,
          ...(targetCitationIdentity === undefined ? {} : { targetCitationIdentity }),
          arguments: argumentsValue,
        },
        now: Date.now(),
      },
    );
    if (result.state === "rejected") return rejectedOperation();
    return new Response(result.responseJson, {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return rejection(error);
  }
});

export const autonomyRecommendationEvidenceEndpoint = httpAction(async (ctx, request) => {
  const signed = await signedBody(
    request,
    operationsAutonomyRecommendationEvidenceSignatureContext,
  );
  if ("response" in signed) return signed.response;
  const parsed = recommendationEvidenceRequest.safeParse(signed.value);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const { previousPageHash, ...evidenceBase } = parsed.data;
  const cleanRequest = {
    ...evidenceBase,
    ...(previousPageHash === undefined ? {} : { previousPageHash }),
  };
  try {
    const result = await ctx.runMutation(
      internal.operationsAutonomyRecommendationEvidence.appendRecommendationEvidence,
      { request: cleanRequest, now: Date.now() },
    );
    if (result.state === "rejected") return rejectedOperation();
    return new Response(result.responseJson, {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return rejection(error);
  }
});

export const autonomyCallbackEndpoint = httpAction(async (ctx, request) => {
  const signed = await signedBody(request, operationsAutonomyCallbackSignatureContext);
  if ("response" in signed) return signed.response;
  const parsed = callbackRequest.safeParse(signed.value);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  try {
    const result = await ctx.runMutation(internal.operationsAutonomyCallbacks.applyCallback, {
      callback: parsed.data,
      now: Date.now(),
    });
    if (result.state === "rejected") return rejectedOperation();
    return new Response(result.responseJson, {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return rejection(error);
  }
});
