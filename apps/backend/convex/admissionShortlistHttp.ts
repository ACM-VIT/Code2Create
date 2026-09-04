import { z } from "zod";
import {
  shortlistCallbackContext,
  shortlistVersion,
  verifyServiceBody,
} from "@code2create/domain";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { readBoundedRequestText } from "./lib/boundedHttpBody";
import { requireIntelligenceHmacSecret } from "./lib/intelligenceServiceConfiguration";

const callback = z.strictObject({
  version: z.literal(shortlistVersion),
  jobId: z.string().min(1).max(100),
  runId: z.string().min(1).max(100),
  attempt: z.number().int().positive(),
  resultJson: z.string().max(180000),
  embedding: z.array(z.number()).max(1536),
});
export const endpoint = httpAction(async (ctx, request) => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return new Response(null, { status: 415 });
  let body: string;
  try {
    body = await readBoundedRequestText(request, 256 * 1024);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (
    !(await verifyServiceBody({
      context: shortlistCallbackContext,
      secret: requireIntelligenceHmacSecret("INTELLIGENCE_CALLBACK_SECRET"),
      timestamp: request.headers.get("x-c2c-timestamp") ?? "",
      signature: request.headers.get("x-c2c-signature") ?? "",
      body,
      now: Date.now(),
      maximumAgeMs: 5 * 60_000,
    }))
  )
    return new Response(null, { status: 401 });
  try {
    const parsed = callback.parse(JSON.parse(body));
    await ctx.runMutation(internal.admissionShortlist.settleJob, {
      jobId: parsed.jobId,
      runId: parsed.runId,
      attempt: parsed.attempt,
      resultJson: parsed.resultJson,
      embedding: parsed.embedding,
    });
    return Response.json({ state: "accepted" }, { status: 202 });
  } catch {
    return Response.json({ error: "invalid_or_stale_result" }, { status: 422 });
  }
});
