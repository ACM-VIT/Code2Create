import {
  participantEmailEventSignatureContext,
  participantEmailEventTypes,
  participantEmailProtocolVersion,
  verifyServiceBody,
} from "@code2create/domain";
import { z } from "zod";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { HttpBodyTooLargeError, readBoundedRequestText } from "./lib/boundedHttpBody";

const maximumBodyBytes = 16 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;

const emailEventSchema = z.strictObject({
  protocolVersion: z.literal(participantEmailProtocolVersion),
  eventId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(512),
  recipient: z.email().max(320),
  eventType: z.enum(participantEmailEventTypes),
  providerAt: z.number().int().nonnegative(),
  disableDestination: z.boolean(),
  providerErrorCode: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_]+$/u)
    .optional(),
});

async function payloadHash(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const participantEmailEvent = httpAction(async (ctx, request) => {
  const callbackSecret = process.env.EMAIL_EVENT_CALLBACK_SECRET?.trim();
  if (!callbackSecret) {
    return new Response("Participant email events are not configured.", { status: 503 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return new Response("Unsupported media type.", { status: 415 });
  }
  let body: string;
  try {
    body = await readBoundedRequestText(request, maximumBodyBytes);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError) {
      return new Response("Payload too large.", { status: 413 });
    }
    throw error;
  }
  const verified = await verifyServiceBody({
    context: participantEmailEventSignatureContext,
    secret: callbackSecret,
    timestamp: request.headers.get("x-c2c-timestamp") ?? "",
    signature: request.headers.get("x-c2c-signature") ?? "",
    body,
    now: Date.now(),
    maximumAgeMs: maximumSignatureAgeMs,
  });
  if (!verified) return new Response("Invalid event signature.", { status: 401 });
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }
  const parsed = emailEventSchema.safeParse(decoded);
  if (!parsed.success) return new Response("Invalid participant email event.", { status: 422 });
  const result = await ctx.runMutation(internal.participantNotificationState.recordProviderEvent, {
    eventId: parsed.data.eventId,
    providerMessageId: parsed.data.messageId,
    recipientEmailNormalized: parsed.data.recipient.toLocaleLowerCase("en"),
    eventType: parsed.data.eventType,
    providerAt: parsed.data.providerAt,
    disableDestination: parsed.data.disableDestination,
    ...(parsed.data.providerErrorCode !== undefined
      ? { providerErrorCode: parsed.data.providerErrorCode }
      : {}),
    payloadHash: await payloadHash(body),
  });
  return Response.json({ accepted: true, ...result });
});
