import {
  participantEmailProtocolVersion,
  type ParticipantEmailEvent,
} from "@code2create/domain";
import { z } from "zod";

const boundedText = (minimum: number, maximum: number) =>
  z.string().min(minimum).max(maximum);

const sourceSchema = z.object({
  type: z.literal("email.sending"),
  domain: boundedText(1, 253),
});

const metadataSchema = z.object({
  eventSchemaVersion: z.literal(1),
  eventTimestamp: z.iso.datetime({ offset: true }),
});

const payloadBase = z.object({
  eventId: boundedText(1, 128),
  messageId: boundedText(1, 512),
  recipient: z.email().max(320),
});

const eventBase = {
  source: sourceSchema,
  metadata: metadataSchema,
};

export const cloudflareEmailSendingEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cf.email.sending.message.delivered"),
    ...eventBase,
    payload: payloadBase.extend({
      delivery: z.object({ status: z.literal("delivered") }),
    }),
  }),
  z.object({
    type: z.literal("cf.email.sending.message.deferred"),
    ...eventBase,
    payload: payloadBase.extend({
      delivery: z.object({ status: z.literal("deferred") }),
    }),
  }),
  z.object({
    type: z.literal("cf.email.sending.message.bounced"),
    ...eventBase,
    payload: payloadBase.extend({
      delivery: z.object({ status: z.literal("bounced") }),
      bounce: z.object({ type: z.enum(["hard", "soft"]) }),
    }),
  }),
  z.object({
    type: z.literal("cf.email.sending.message.failed"),
    ...eventBase,
    payload: payloadBase.extend({
      delivery: z.object({ status: z.literal("failed") }),
    }),
  }),
  z.object({
    type: z.literal("cf.email.sending.message.rejected"),
    ...eventBase,
    payload: payloadBase.extend({
      delivery: z.object({ status: z.literal("rejected") }),
      rejection: z.object({ reason: boundedText(1, 120) }),
    }),
  }),
  z.object({
    type: z.literal("cf.email.sending.message.complained"),
    ...eventBase,
    payload: payloadBase.extend({
      delivery: z.object({ status: z.literal("complained") }),
    }),
  }),
]);

export function normalizeCloudflareEmailEvent(
  input: unknown,
  expectedDomain: string,
): ParticipantEmailEvent {
  const event = cloudflareEmailSendingEventSchema.parse(input);
  if (event.source.domain.toLocaleLowerCase("en") !== expectedDomain.toLocaleLowerCase("en")) {
    throw new Error("Cloudflare Email Sending event came from an unexpected domain.");
  }
  const common = {
    protocolVersion: participantEmailProtocolVersion,
    eventId: event.payload.eventId,
    messageId: event.payload.messageId,
    recipient: event.payload.recipient.toLocaleLowerCase("en"),
    providerAt: Date.parse(event.metadata.eventTimestamp),
  };
  switch (event.type) {
    case "cf.email.sending.message.delivered":
      return { ...common, eventType: "email.delivered", disableDestination: false };
    case "cf.email.sending.message.deferred":
      return {
        ...common,
        eventType: "email.delivery_delayed",
        disableDestination: false,
        providerErrorCode: "cloudflare_email_deferred",
      };
    case "cf.email.sending.message.bounced":
      return {
        ...common,
        eventType: "email.bounced",
        disableDestination: event.payload.bounce.type === "hard",
        providerErrorCode: `cloudflare_email_bounced_${event.payload.bounce.type}`,
      };
    case "cf.email.sending.message.failed":
      return {
        ...common,
        eventType: "email.failed",
        disableDestination: false,
        providerErrorCode: "cloudflare_email_failed",
      };
    case "cf.email.sending.message.rejected": {
      const suppressed = event.payload.rejection.reason === "suppressed";
      return {
        ...common,
        eventType: suppressed ? "email.suppressed" : "email.failed",
        disableDestination: suppressed,
        providerErrorCode: suppressed
          ? "cloudflare_email_suppressed"
          : "cloudflare_email_rejected",
      };
    }
    case "cf.email.sending.message.complained":
      return {
        ...common,
        eventType: "email.complained",
        disableDestination: true,
        providerErrorCode: "cloudflare_email_complained",
      };
  }
}
