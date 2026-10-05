import {
  githubServiceSignatureMaximumAgeMs,
  githubSyncIngressContext,
  githubWebhookProtocolVersion,
  verifyServiceBody,
  type GithubWebhookReceipt,
} from "@code2create/domain";
import { Hono } from "hono";
import * as v from "valibot";

import {
  HttpBodyInvalidEncodingError,
  HttpBodyTooLargeError,
  readBoundedRequestBytes,
  readBoundedRequestText,
} from "../lib/boundedHttpBody.ts";
import { githubSyncRequestSchema, normalizedGithubWebhookEvent } from "../lib/githubProtocol.ts";
import { reconcileRepository } from "../lib/githubSync.ts";
import {
  forwardGithubWebhook,
  GithubCallbackError,
  publishRepositorySync,
} from "../lib/githubTransport.ts";
import { payloadHash, verifyGithubWebhookSignature } from "../lib/githubWebhookSignature.ts";
import {
  captureIntelligenceFailure,
  postHogIntelligenceObservabilityConfigured,
} from "../lib/posthogObservability.ts";
import { requireStrongServiceSecret } from "../lib/serviceSecret.ts";

const syncRequestMaximumBytes = 16 * 1024;
const webhookMaximumBytes = 2_000_000;

export const githubRoutes = new Hono<{ Bindings: Cloudflare.Env }>();

githubRoutes.post("/v1/github/repository-syncs", async (context) => {
  if (context.req.header("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return context.json({ error: "unsupported_media_type" }, 415);
  }
  let body: string;
  try {
    body = await readBoundedRequestText(context.req.raw, syncRequestMaximumBytes);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError) {
      return context.json({ error: "payload_too_large" }, 413);
    }
    if (error instanceof HttpBodyInvalidEncodingError) {
      return context.json({ error: "invalid_encoding" }, 400);
    }
    throw error;
  }
  if (
    !(await verifyServiceBody({
      context: githubSyncIngressContext,
      secret: requireStrongServiceSecret(
        context.env.INTELLIGENCE_INGRESS_SECRET,
        "INTELLIGENCE_INGRESS_SECRET",
      ),
      timestamp: context.req.header("x-c2c-timestamp") ?? "",
      signature: context.req.header("x-c2c-signature") ?? "",
      body,
      now: Date.now(),
      maximumAgeMs: githubServiceSignatureMaximumAgeMs,
    }))
  ) {
    return context.json({ error: "unauthorized" }, 401);
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = v.safeParse(githubSyncRequestSchema, value);
  if (!parsed.success) return context.json({ error: "invalid_request" }, 422);
  const { rootPath, ...request } = parsed.output;
  const syncRequest = rootPath === undefined ? request : { ...request, rootPath };
  const configuration = {
    appId: context.env.GITHUB_APP_ID,
    privateKey: context.env.GITHUB_APP_PRIVATE_KEY,
  };
  const bindings = context.env;
  // The provider round trips outlive Convex's request deadline, so acceptance is
  // acknowledged first and the settlement travels back over the signed callback.
  context.executionCtx.waitUntil(
    reconcileRepository(syncRequest, configuration, fetch).then((callback) =>
      publishRepositorySync(callback, bindings),
    ),
  );
  return context.json({ state: "accepted" }, 202);
});

githubRoutes.post("/v1/github/webhook", async (context) => {
  const signature = context.req.header("x-hub-signature-256") ?? "";
  const deliveryId = context.req.header("x-github-delivery")?.trim() ?? "";
  const eventName = context.req.header("x-github-event")?.trim() ?? "";
  if (
    signature.length === 0 ||
    deliveryId.length === 0 ||
    deliveryId.length > 100 ||
    eventName.length === 0 ||
    eventName.length > 80
  ) {
    return context.json({ error: "missing_github_headers" }, 400);
  }
  let body: Uint8Array;
  try {
    body = await readBoundedRequestBytes(context.req.raw, webhookMaximumBytes);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError) {
      return context.json({ error: "payload_too_large" }, 413);
    }
    throw error;
  }
  const webhookSecret = context.env.GITHUB_WEBHOOK_SECRET.trim();
  if (webhookSecret.length === 0) return context.json({ error: "webhook_not_configured" }, 503);
  if (!(await verifyGithubWebhookSignature(webhookSecret, body, signature))) {
    return context.json({ error: "unauthorized" }, 401);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const event = normalizedGithubWebhookEvent(eventName, payload);
  if (event === null) return context.body(null, 204);
  if (event === "invalid") return context.json({ error: "invalid_payload" }, 400);
  let receipt: GithubWebhookReceipt;
  try {
    receipt = await forwardGithubWebhook(
      {
        protocolVersion: githubWebhookProtocolVersion,
        deliveryId,
        eventName,
        payloadHash: await payloadHash(body),
        event,
      },
      context.env,
    );
  } catch (error) {
    if (!(error instanceof GithubCallbackError)) throw error;
    if (postHogIntelligenceObservabilityConfigured(context.env)) {
      context.executionCtx.waitUntil(
        captureIntelligenceFailure(context.env, `github_webhook_callback_${error.reason}`, {
          c2c_route: "/v1/github/webhook",
          c2c_github_event: eventName,
          ...(error.upstreamStatus === undefined
            ? {}
            : { c2c_upstream_status: error.upstreamStatus }),
        }),
      );
    }
    // A non-2xx keeps the delivery failed in GitHub so it can be redelivered.
    return context.json(
      { error: "convex_callback_failed" },
      error.reason === "timeout" ? 504 : 502,
    );
  }
  return context.json(receipt, 202);
});
