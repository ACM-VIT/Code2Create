import {
  operationsIntelligenceIngressSignatureContext,
  verifyServiceBody,
} from "@code2create/domain";
import { AgentInstanceExistsError, dispatch } from "@flue/runtime";
import { Hono } from "hono";
import * as v from "valibot";

import { OperationsBrief } from "../agents/operations-brief.ts";
import {
  HttpBodyInvalidEncodingError,
  HttpBodyTooLargeError,
  readBoundedRequestText,
} from "../lib/boundedHttpBody.ts";
import { OperationDeadlineError, settleWithin } from "../lib/deadline.ts";
import { requireStrongServiceSecret } from "../lib/serviceSecret.ts";
import { operationsIntelligenceRequestSchema } from "../protocol.ts";

const maximumBodyBytes = 64 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;
const admissionWaitMs = 10_000;

export const briefRoutes = new Hono<{ Bindings: Cloudflare.Env }>();

briefRoutes.post("/v1/operations-briefs", async (context) => {
  if (
    context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return context.json({ error: "unsupported_media_type" }, 415);
  }
  let body: string;
  try {
    body = await readBoundedRequestText(context.req.raw, maximumBodyBytes);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError) {
      return context.json({ error: "payload_too_large" }, 413);
    }
    if (error instanceof HttpBodyInvalidEncodingError) {
      return context.json({ error: "invalid_encoding" }, 400);
    }
    throw error;
  }
  const verified = await verifyServiceBody({
    context: operationsIntelligenceIngressSignatureContext,
    secret: requireStrongServiceSecret(
      context.env.INTELLIGENCE_INGRESS_SECRET,
      "INTELLIGENCE_INGRESS_SECRET",
    ),
    timestamp: context.req.header("x-c2c-timestamp") ?? "",
    signature: context.req.header("x-c2c-signature") ?? "",
    body,
    now: Date.now(),
    maximumAgeMs: maximumSignatureAgeMs,
  });
  if (!verified) return context.json({ error: "unauthorized" }, 401);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = v.safeParse(operationsIntelligenceRequestSchema, json);
  if (!parsed.success) return context.json({ error: "invalid_request" }, 422);
  try {
    const receipt = await settleWithin(
      dispatch(OperationsBrief, {
        id: parsed.output.briefId,
        uid: null,
        initialData: parsed.output,
        message: {
          kind: "signal",
          type: "operations.health.snapshot",
          body: "Prepare the bounded brief from this instance's frozen source snapshot.",
          attributes: {
            briefId: parsed.output.briefId,
            sourceChecksum: parsed.output.sourceChecksum,
          },
        },
      }),
      admissionWaitMs,
    );
    return context.json(
      {
        state: "accepted" as const,
        submissionId: receipt.submissionId,
        acceptedAt: receipt.acceptedAt,
      },
      202,
    );
  } catch (error) {
    if (error instanceof OperationDeadlineError) {
      return context.json({ error: "service_unavailable" }, 503, { "retry-after": "1" });
    }
    if (error instanceof AgentInstanceExistsError) {
      return context.json({ state: "already_exists" as const }, 202);
    }
    throw error;
  }
});
