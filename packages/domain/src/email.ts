export const participantEmailProtocolVersion = "participant-email-v1" as const;

export const participantEmailEventSignatureContext = "code2create.participant-email.event.v1";

export const participantEmailSendProtocolVersion = "participant-email-send-v1" as const;

export const participantEmailSendSignatureContext = "code2create.participant-email.send.v1";

export const participantEmailProviders = ["cloudflare_email", "aws_ses"] as const;

export type ParticipantEmailProvider = (typeof participantEmailProviders)[number];

export const participantEmailProviderLabels: Record<ParticipantEmailProvider, string> = {
  cloudflare_email: "Cloudflare Email Sending",
  aws_ses: "Amazon SES",
};

export type ParticipantEmailAttachment = {
  filename: string;
  contentType: string;
  contentBase64: string;
  disposition: "inline" | "attachment";
  contentId?: string;
};

export type ParticipantEmailSendRequest = {
  protocolVersion: typeof participantEmailSendProtocolVersion;
  provider: ParticipantEmailProvider;
  requestId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Array<{ name: string; value: string }>;
  attachments: ParticipantEmailAttachment[];
};

export type ParticipantEmailSendResult =
  | {
      status: "accepted";
      provider: ParticipantEmailProvider;
      messageId: string;
      initialOutcome: "queued" | "delivered" | "permanent_bounce";
    }
  | {
      status: "rejected";
      provider: ParticipantEmailProvider;
      errorCode: string;
      retryable: boolean;
    }
  | {
      status: "ambiguous";
      provider: ParticipantEmailProvider;
      errorCode: string;
    };

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
