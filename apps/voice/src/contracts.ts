import {
  outboundCallEventTypes,
  outboundCallProtocolVersion,
} from "@code2create/domain";
import type { OutboundCallRequest } from "@code2create/domain";
import { z } from "zod";

const deliveryId = z.string().min(1).max(128);
const e164Phone = z.string().regex(/^\+[1-9]\d{7,14}$/u);
const callbackUrl = z.url().refine((value) => value.startsWith("https://"), {
  message: "Expected an HTTPS callback URL.",
});

export const outboundCallRequestSchema: z.ZodType<OutboundCallRequest> = z
  .object({
    protocolVersion: z.literal(outboundCallProtocolVersion),
    deliveryId,
    destinationPhoneE164: e164Phone,
    script: z.string().min(8).max(600),
    callbackUrl,
  })
  .strict();

export const outboundCallEventSchema = z
  .object({
    protocolVersion: z.literal(outboundCallProtocolVersion),
    eventId: z.uuid(),
    deliveryId,
    eventType: z.enum(outboundCallEventTypes),
    providerAt: z.number().int().nonnegative(),
    providerCallId: z.string().min(1).max(128).optional(),
    providerErrorCode: z.string().min(1).max(120).optional(),
  })
  .strict();

export const twilioCreateResponseSchema = z
  .object({
    sid: z.string().min(1).max(128),
    status: z.string().min(1).max(40).optional(),
  })
  .loose();

export const twilioErrorResponseSchema = z
  .object({ message: z.string().min(1).max(500).optional() })
  .loose();

export const callAcceptedResponseSchema = z
  .object({ accepted: z.literal(true), deliveryId })
  .strict();
