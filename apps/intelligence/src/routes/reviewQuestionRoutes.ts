import {
  reviewQuestionIngressContext,
  verifyServiceBody,
} from "@code2create/domain";
import { AgentInstanceExistsError, dispatch } from "@flue/runtime";
import { Hono } from "hono";
import * as v from "valibot";
import { ReviewQuestions } from "../agents/review-questions.ts";
import {
  readBoundedRequestText,
  HttpBodyTooLargeError,
  HttpBodyInvalidEncodingError,
} from "../lib/boundedHttpBody.ts";
import { settleWithin, OperationDeadlineError } from "../lib/deadline.ts";
import { requireStrongServiceSecret } from "../lib/serviceSecret.ts";
import { reviewQuestionRequestSchema } from "../lib/reviewQuestionProtocol.ts";

export const reviewQuestionRoutes = new Hono<{ Bindings: Cloudflare.Env }>();
reviewQuestionRoutes.post("/v1/review-questions", async (context) => {
  if (
    context.req.header("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  )
    return context.json({ error: "unsupported_media_type" }, 415);
  let body: string;
  try {
    body = await readBoundedRequestText(context.req.raw, 12 * 1024 * 1024);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError)
      return context.json({ error: "payload_too_large" }, 413);
    if (error instanceof HttpBodyInvalidEncodingError)
      return context.json({ error: "invalid_encoding" }, 400);
    throw error;
  }
  if (
    !(await verifyServiceBody({
      context: reviewQuestionIngressContext,
      secret: requireStrongServiceSecret(
        context.env.INTELLIGENCE_INGRESS_SECRET,
        "INTELLIGENCE_INGRESS_SECRET",
      ),
      timestamp: context.req.header("x-c2c-timestamp") ?? "",
      signature: context.req.header("x-c2c-signature") ?? "",
      body,
      now: Date.now(),
      maximumAgeMs: 300000,
    }))
  )
    return context.json({ error: "unauthorized" }, 401);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = v.safeParse(reviewQuestionRequestSchema, value);
  if (!parsed.success) return context.json({ error: "invalid_request" }, 422);
  const initialData = parsed.output;
  try {
    await settleWithin(
      dispatch(ReviewQuestions, {
        id: `${parsed.output.jobId}:${parsed.output.attempt}:${parsed.output.partId}:${parsed.output.partAttempt}`,
        uid: null,
        initialData,
        message: {
              kind: "signal",
              type: "review.evidence.ready",
              body: "Prepare optional verbal questions from this instance's frozen evidence.",
            },
      }),
      10000,
    );
    return context.json({ state: "accepted" }, 202);
  } catch (error) {
    if (error instanceof AgentInstanceExistsError)
      return context.json({ state: "already_exists" }, 202);
    if (error instanceof OperationDeadlineError)
      return context.json({ error: "service_unavailable" }, 503);
    throw error;
  }
});
