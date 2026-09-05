import { venueCallResponseSchema } from "./lib/venueCallValidators";
import {
  outboundCallEventSignatureContext,
  outboundCallEventTypes,
  outboundCallProtocolVersion,
  verifyServiceBody,
} from "@code2create/domain";
import { z } from "zod";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const maximumBodyBytes = 512 * 1_024;
const signatureMaximumAgeMs = 5 * 60 * 1_000;

const eventSchema = z
  .object({
    protocolVersion: z.literal(outboundCallProtocolVersion),
    eventId: z.uuid(),
    deliveryId: z.string().min(1).max(128),
    eventType: z.enum(outboundCallEventTypes),
    providerAt: z.number().int().nonnegative(),
    providerCallId: z.string().min(1).max(128).optional(),
    providerErrorCode: z.string().min(1).max(120).optional(),
    venueResponse: venueCallResponseSchema.optional(),
  })
  .strict();

export const outboundCallEvent = httpAction(async (ctx, request) => {
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) {
    return Response.json({ error: "request_too_large" }, { status: 413 });
  }
  const secret = process.env.OUTBOUND_CALL_EVENT_SECRET?.trim();
  if (!secret) return Response.json({ error: "service_unavailable" }, { status: 503 });
  let verified = false;
  try {
    verified = await verifyServiceBody({
      context: outboundCallEventSignatureContext,
      secret,
      timestamp: request.headers.get("x-c2c-timestamp") ?? "",
      signature: request.headers.get("x-c2c-signature") ?? "",
      body,
      now: Date.now(),
      maximumAgeMs: signatureMaximumAgeMs,
    });
  } catch {
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }
  if (!verified) return Response.json({ error: "unauthorized" }, { status: 401 });
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 422 });
  }
  const parsed = eventSchema.safeParse(decoded);
  if (!parsed.success) return Response.json({ error: "invalid_event" }, { status: 422 });
  await ctx.runMutation(internal.outboundCallState.recordProviderEvent, {
    providerEventId: parsed.data.eventId,
    deliveryId: parsed.data.deliveryId,
    eventType: parsed.data.eventType,
    providerAt: parsed.data.providerAt,
    ...(parsed.data.venueResponse
      ? { venueResponse: parsed.data.venueResponse }
      : {}),
    ...(parsed.data.providerCallId !== undefined
      ? { providerCallId: parsed.data.providerCallId }
      : {}),
    ...(parsed.data.providerErrorCode !== undefined
      ? { providerErrorCode: parsed.data.providerErrorCode }
      : {}),
  });
  return Response.json({ accepted: true });
});
