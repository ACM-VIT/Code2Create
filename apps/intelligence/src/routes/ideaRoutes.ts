import { ideaIntelligenceIngressSignatureContext, verifyServiceBody } from "@code2create/domain";
import { dispatch } from "@flue/runtime";
import { Hono } from "hono";
import * as v from "valibot";

import { IdeaSubmission } from "../agents/idea-submission.ts";
import {
  HttpBodyInvalidEncodingError,
  HttpBodyTooLargeError,
  readBoundedRequestText,
} from "../lib/boundedHttpBody.ts";
import { OperationDeadlineError, settleWithin } from "../lib/deadline.ts";
import { ideaIntelligenceDispatchSchema } from "../lib/ideaProtocol.ts";
import { requireStrongServiceSecret } from "../lib/serviceSecret.ts";

const maximumBodyBytes = 16 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;
const admissionWaitMs = 10_000;

export const ideaRoutes = new Hono<{ Bindings: Cloudflare.Env }>();

ideaRoutes.post("/v1/idea-submissions", async (context) => {
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
    if (error instanceof HttpBodyTooLargeError)
      return context.json({ error: "payload_too_large" }, 413);
    if (error instanceof HttpBodyInvalidEncodingError)
      return context.json({ error: "invalid_encoding" }, 400);
    throw error;
  }
  const verified = await verifyServiceBody({
    context: ideaIntelligenceIngressSignatureContext,
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
  const parsed = v.safeParse(ideaIntelligenceDispatchSchema, json);
  if (!parsed.success) return context.json({ error: "invalid_request" }, 422);
  try {
    const receipt = await settleWithin(
      dispatch(IdeaSubmission, {
        id: parsed.output.recommendationId,
        initialData: {
          protocolVersion: parsed.output.protocolVersion,
          recommendationId: parsed.output.recommendationId,
          applicationId: parsed.output.applicationId,
          eventId: parsed.output.eventId,
          modelId: parsed.output.modelId,
        },
        message: {
          kind: "signal",
          type: "idea.submission.changed",
          body: "Analyze the current authorized submitted idea.",
          attributes: {
            recommendationId: parsed.output.recommendationId,
            contentVersion: String(parsed.output.contentVersion),
          },
        },
      }),
      admissionWaitMs,
    );
    return context.json(
      {
        state: "accepted" as const,
        applicationId: parsed.output.applicationId,
        instanceId: parsed.output.recommendationId,
        submissionId: receipt.submissionId,
        acceptedAt: receipt.acceptedAt,
      },
      202,
    );
  } catch (error) {
    if (error instanceof OperationDeadlineError) {
      return context.json({ error: "service_unavailable" }, 503, { "retry-after": "1" });
    }
    throw error;
  }
});
