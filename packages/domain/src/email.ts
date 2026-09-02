export const participantEmailProtocolVersion = "participant-email-v1" as const;

export const participantEmailEventSignatureContext =
  "code2create.participant-email.event.v1";

export const participantEmailEventTypes = [
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.failed",
  "email.suppressed",
  "email.complained",
] as const;

export type ParticipantEmailEventType = (typeof participantEmailEventTypes)[number];

export type ParticipantEmailEvent = {
  protocolVersion: typeof participantEmailProtocolVersion;
  eventId: string;
  messageId: string;
  recipient: string;
  eventType: ParticipantEmailEventType;
  providerAt: number;
  disableDestination: boolean;
  providerErrorCode?: string;
};
