export const outboundCallProtocolVersion = "2026-08-25" as const;

export const outboundCallRequestSignatureContext =
  "code2create.outbound-call.request.v1";

export const outboundCallEventSignatureContext =
  "code2create.outbound-call.event.v1";

export const outboundCallEventTypes = [
  "call.queued",
  "call.initiated",
  "call.ringing",
  "call.answered",
  "call.completed",
  "call.busy",
  "call.no_answer",
  "call.cancelled",
  "call.failed",
] as const;

export type OutboundCallEventType = (typeof outboundCallEventTypes)[number];

export type OutboundCallRequest = {
  protocolVersion: typeof outboundCallProtocolVersion;
  deliveryId: string;
  destinationPhoneE164: string;
  script: string;
  callbackUrl: string;
};

export type OutboundCallEvent = {
  protocolVersion: typeof outboundCallProtocolVersion;
  eventId: string;
  deliveryId: string;
  eventType: OutboundCallEventType;
  providerAt: number;
  providerCallId?: string;
  providerErrorCode?: string;
};
