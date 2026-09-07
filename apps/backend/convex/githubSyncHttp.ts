import {
  githubServiceSignatureMaximumAgeMs,
  githubSyncCallbackContext,
  githubWebhookCallbackContext,
  verifyServiceBody,
} from "@code2create/domain";
import { ConvexError } from "convex/values";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { HttpBodyTooLargeError, readBoundedRequestText } from "./lib/boundedHttpBody";
import {
  githubRepositorySyncCallbackSchema,
  githubWebhookCallbackSchema,
  type GithubRepositorySyncCallbackInput,
  type GithubWebhookCallbackInput,
} from "./lib/githubSyncProtocol";
import { requireIntelligenceHmacSecret } from "./lib/intelligenceServiceConfiguration";

/** Drops absent optional fields so the settlement matches the mutation's exact shape. */
function normalizedSettlement(callback: GithubRepositorySyncCallbackInput) {
  const { protocolVersion: _protocolVersion, completedAt: _completedAt, ...settlement } = callback;
  if (settlement.status !== "succeeded") return settlement;
  const { providerCommitAt, ...observation } = settlement.observation;
  return {
    ...settlement,
    observation: providerCommitAt === undefined ? observation : { ...observation, providerCommitAt },
  };
}

/** Drops absent optional fields so the event matches the mutation's exact shape. */
function normalizedEvent(event: GithubWebhookCallbackInput["event"]) {
  if (event.kind !== "push") return event;
  const { providerAt, ...push } = event;
  return providerAt === undefined ? push : { ...push, providerAt };
}

const callbackMaximumBytes = 128 * 1024;

type VerifiedJson = { ok: true; value: unknown } | { ok: false; response: Response };

function rejected(error: string, status: number): VerifiedJson {
  return { ok: false, response: Response.json({ error }, { status }) };
}

async function verifiedJson(request: Request, context: string): Promise<VerifiedJson> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return rejected("unsupported_media_type", 415);
  }
  let body: string;
  try {
    body = await readBoundedRequestText(request, callbackMaximumBytes);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError) return rejected("payload_too_large", 413);
    throw error;
  }
  const verified = await verifyServiceBody({
    context,
    secret: requireIntelligenceHmacSecret("INTELLIGENCE_CALLBACK_SECRET"),
    timestamp: request.headers.get("x-c2c-timestamp") ?? "",
    signature: request.headers.get("x-c2c-signature") ?? "",
    body,
    now: Date.now(),
    maximumAgeMs: githubServiceSignatureMaximumAgeMs,
  });
  if (!verified) return rejected("unauthorized", 401);
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return rejected("invalid_json", 400);
  }
}

/** Applies one Worker reconciliation result at most once per sync revision. */
export const repositorySyncCallback = httpAction(async (ctx, request) => {
  const verified = await verifiedJson(request, githubSyncCallbackContext);
  if (!verified.ok) return verified.response;
  const parsed = githubRepositorySyncCallbackSchema.safeParse(verified.value);
  if (!parsed.success) return Response.json({ error: "invalid_callback" }, { status: 422 });
  const state = await ctx.runMutation(internal.githubSync.apply, {
    settlement: normalizedSettlement(parsed.data),
  });
  return Response.json({ state }, { status: 202 });
});

/** Accepts one normalized provider delivery the Worker already authenticated. */
export const webhookCallback = httpAction(async (ctx, request) => {
  const verified = await verifiedJson(request, githubWebhookCallbackContext);
  if (!verified.ok) return verified.response;
  const parsed = githubWebhookCallbackSchema.safeParse(verified.value);
  if (!parsed.success) return Response.json({ error: "invalid_callback" }, { status: 422 });
  try {
    const result = await ctx.runMutation(internal.githubIntegrations.acceptWebhook, {
      deliveryId: parsed.data.deliveryId,
      eventName: parsed.data.eventName,
      payloadHash: parsed.data.payloadHash,
      event: normalizedEvent(parsed.data.event),
    });
    const state = result.duplicate
      ? "duplicate"
      : result.affectedBindings > 0 || parsed.data.event.kind === "ping"
        ? "accepted"
        : "ignored";
    return Response.json({ state }, { status: 202 });
  } catch (error) {
    if (error instanceof ConvexError) {
      return Response.json({ error: "delivery_collision" }, { status: 409 });
    }
    throw error;
  }
});
