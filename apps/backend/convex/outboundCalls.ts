"use node";

import { randomUUID } from "node:crypto";

import {
  outboundCallProtocolVersion,
  outboundCallRequestSignatureContext,
  signServiceBody,
  type OutboundCallRequest,
} from "@code2create/domain";
import { v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { readBoundedJsonResponse } from "./lib/boundedHttpBody";

const acceptedResponse = z
  .object({
    accepted: z.literal(true),
    deliveryId: z.string().min(1).max(128),
  })
  .strict();

function requiredServiceUrl(name: "OUTBOUND_CALL_WORKER_URL" | "CONVEX_SITE_URL") {
  const configured = process.env[name]?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  return url.protocol === "https:" ? url : null;
}

function outboundCallCallbackUrl() {
  const site = requiredServiceUrl("CONVEX_SITE_URL");
  return site
    ? new URL("/communications/outbound-call/events", site).toString()
    : null;
}

async function recordFailure(
  ctx: ActionCtx,
  args: {
    deliveryId: Id<"outboundCallDeliveries">;
    attemptId: string;
    errorCode: string;
    ambiguous: boolean;
    retryable: boolean;
  },
) {
  const result = await ctx.runMutation(
    internal.outboundCallState.recordDispatchFailure,
    args,
  );
  if (result.retry && result.delayMs !== undefined) {
    await ctx.scheduler.runAfter(result.delayMs, internal.outboundCalls.deliver, {
      deliveryId: args.deliveryId,
    });
  }
}

export const deliver = internalAction({
  args: { deliveryId: v.id("outboundCallDeliveries") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attemptId = randomUUID();
    const claim = await ctx.runMutation(internal.outboundCallState.claimDelivery, {
      deliveryId: args.deliveryId,
      attemptId,
    });
    if (!claim) return null;
    const worker = requiredServiceUrl("OUTBOUND_CALL_WORKER_URL");
    const callbackUrl = outboundCallCallbackUrl();
    const secret = process.env.OUTBOUND_CALL_REQUEST_SECRET?.trim();
    if (!worker || !callbackUrl || !secret) {
      await recordFailure(ctx, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: "outbound_call_not_configured",
        ambiguous: false,
        retryable: false,
      });
      return null;
    }
    const request: OutboundCallRequest = {
      protocolVersion: outboundCallProtocolVersion,
      deliveryId: claim.deliveryId,
      destinationPhoneE164: claim.destinationPhoneE164,
      script: claim.script,
      callbackUrl,
    };
    const body = JSON.stringify(request);
    const timestamp = String(Date.now());
    let signature: string;
    try {
      signature = await signServiceBody({
        context: outboundCallRequestSignatureContext,
        secret,
        timestamp,
        body,
      });
    } catch {
      await recordFailure(ctx, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: "outbound_call_secret_invalid",
        ambiguous: false,
        retryable: false,
      });
      return null;
    }
    let response: Response;
    try {
      response = await fetch(new URL("/v1/calls", worker), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-c2c-signature": signature,
          "x-c2c-timestamp": timestamp,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      await recordFailure(ctx, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: "outbound_call_request_ambiguous",
        ambiguous: true,
        retryable: true,
      });
      return null;
    }
    let decoded: unknown;
    try {
      decoded = await readBoundedJsonResponse(response, 16 * 1_024);
    } catch {
      await recordFailure(ctx, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: "outbound_call_response_ambiguous",
        ambiguous: true,
        retryable: true,
      });
      return null;
    }
    const accepted = acceptedResponse.safeParse(decoded);
    if (!response.ok || !accepted.success || accepted.data.deliveryId !== claim.deliveryId) {
      await recordFailure(ctx, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: response.ok
          ? "outbound_call_response_invalid"
          : `outbound_call_http_${response.status}`,
        ambiguous: response.ok || response.status >= 500,
        retryable: response.ok || response.status >= 500,
      });
      return null;
    }
    await ctx.runMutation(internal.outboundCallState.recordAccepted, {
      deliveryId: claim.deliveryId,
      attemptId,
    });
    return null;
  },
});
