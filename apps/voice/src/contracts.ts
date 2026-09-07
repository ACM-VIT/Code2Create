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
    requiredProvider: z.literal("sarvam").optional(),
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

export const sarvamOutboundResponseSchema = z
  .object({
    attempt_id: z.string().min(1).max(128),
  })
  .loose();

export const sarvamErrorResponseSchema = z
  .object({
    detail: z
      .union([
        z.string().min(1).max(500),
        z.array(
          z
            .object({ msg: z.string().min(1).max(500) })
            .loose()),
      ])
      .optional(),
    message: z.string().min(1).max(500).optional(),
    error: z
      .object({ message: z.string().min(1).max(500) })
      .loose()
      .optional(),
  })
  .loose();

export const sarvamOutboundWebhookSchema = z
  .object({
    attempt_id: z.string().min(1).max(128),
    status: z.enum(["connected", "no_answer", "busy", "failed"]),
    channel_info: z
      .object({
        channel_type: z.literal("v2v"),
        channel_provider: z.string().min(1).max(80),
        agent_phone_number: e164Phone,
      })
      .loose(),
    final_agent_variables: z.unknown().optional(),
    interaction_transcript: z
      .array(
        z
          .object({
            role: z.enum(["agent", "user"]),
            en_text: z.string().max(4000),
          })
          .loose(),
      )
      .max(100)
      .nullable()
      .optional(),
    failure_reason: z.string().min(1).max(500).nullable().optional(),
    webhook_config: z
      .object({
        url: callbackUrl,
        metadata: z.record(z.string(), z.json()).nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

export const callAcceptedResponseSchema = z
  .object({ accepted: z.literal(true), deliveryId })
  .strict();
