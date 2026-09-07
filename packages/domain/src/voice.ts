export const reviewerCallConsentPolicyVersion = "reviewer-duty-call-consent-v2";
export const reviewerCallScriptPolicyVersion = "reviewer-duty-call-v2";

export const outboundCallProtocolVersion = "outbound-call-v1" as const;

export const outboundCallRequestSignatureContext = "code2create.outbound-call.request.v1";

export const outboundCallEventSignatureContext = "code2create.outbound-call.event.v1";

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
  requiredProvider?: "sarvam" | undefined;
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
