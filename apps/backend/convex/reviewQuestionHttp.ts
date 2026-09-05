import {
  reviewQuestionCallbackContext,
  verifyServiceBody,
} from "@code2create/domain";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import {
  readBoundedRequestText,
  HttpBodyTooLargeError,
} from "./lib/boundedHttpBody";
import { requireIntelligenceHmacSecret } from "./lib/intelligenceServiceConfiguration";
import { reviewQuestionCallbackSchema } from "./lib/reviewQuestionProtocol";

export const callback = httpAction(async (ctx, request) => {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  )
    return Response.json({ error: "unsupported_media_type" }, { status: 415 });
  let body: string;
  try {
    body = await readBoundedRequestText(request, 128 * 1024);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError)
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    throw error;
  }
  const verified = await verifyServiceBody({
    context: reviewQuestionCallbackContext,
    secret: requireIntelligenceHmacSecret("INTELLIGENCE_CALLBACK_SECRET"),
    timestamp: request.headers.get("x-c2c-timestamp") ?? "",
    signature: request.headers.get("x-c2c-signature") ?? "",
    body,
    now: Date.now(),
    maximumAgeMs: 300000,
  });
  if (!verified)
    return Response.json({ error: "unauthorized" }, { status: 401 });
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!reviewQuestionCallbackSchema.safeParse(value).success)
    return Response.json({ error: "invalid_callback" }, { status: 422 });
  try {
    const state = await ctx.runMutation(internal.reviewQuestions.settle, {
      body,
    });
    return Response.json({ state }, { status: 202 });
  } catch (error) {
    if (error instanceof ConvexError)
      return Response.json(
        { error: "invalid_source_references" },
        { status: 422 },
      );
    throw error;
  }
});
