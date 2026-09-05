import {
  SendEmailCommand,
  SESv2Client,
  type SendEmailCommandInput,
  type SendEmailCommandOutput,
} from "@aws-sdk/client-sesv2";
import type {
  ParticipantEmailSendRequest,
  ParticipantEmailSendResult,
} from "@code2create/domain";

export type SesEmailConfiguration = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  from: string;
  replyTo?: string;
  configurationSet?: string;
};

export type SesSender = (
  configuration: SesEmailConfiguration,
  input: SendEmailCommandInput,
) => Promise<SendEmailCommandOutput>;

function decodeBase64(value: string) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function errorMetadataStatus(error: unknown) {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return null;
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) {
    return null;
  }
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : null;
}

function normalizedErrorName(error: unknown) {
  const name = error instanceof Error ? error.name : "unknown";
  return name
    .replace(/Exception$/u, "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .toLocaleLowerCase("en");
}

function retryableSesFailure(status: number, name: string) {
  return (
    status === 429 ||
    status >= 500 ||
    name === "too_many_requests" ||
    name === "limit_exceeded" ||
    name === "service_unavailable"
  );
}

async function defaultSesSender(
  configuration: SesEmailConfiguration,
  input: SendEmailCommandInput,
) {
  const client = new SESv2Client({
    region: configuration.region,
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
      ...(configuration.sessionToken ? { sessionToken: configuration.sessionToken } : {}),
    },
    maxAttempts: 1,
  });
  return client.send(new SendEmailCommand(input));
}

export async function sendWithSes(
  request: ParticipantEmailSendRequest,
  configuration: SesEmailConfiguration,
  sender: SesSender = defaultSesSender,
): Promise<ParticipantEmailSendResult> {
  const requestTag = request.requestId
    .replace(/[^A-Za-z0-9_-]/gu, "_")
    .slice(0, 256);
  const input: SendEmailCommandInput = {
    FromEmailAddress: configuration.from,
    Destination: { ToAddresses: [request.to] },
    Content: {
      Simple: {
        Subject: { Data: request.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: request.text, Charset: "UTF-8" },
          Html: { Data: request.html, Charset: "UTF-8" },
        },
        Headers: request.headers.map((header) => ({
          Name: header.name,
          Value: header.value,
        })),
        Attachments: request.attachments.map((attachment) => ({
          RawContent: decodeBase64(attachment.contentBase64),
          FileName: attachment.filename,
          ContentType: attachment.contentType,
          ContentDisposition: attachment.disposition === "inline" ? "INLINE" : "ATTACHMENT",
          ContentTransferEncoding: "BASE64",
          ...(attachment.contentId ? { ContentId: attachment.contentId } : {}),
        })),
      },
    },
    ...(configuration.replyTo ? { ReplyToAddresses: [configuration.replyTo] } : {}),
    ...(configuration.configurationSet
      ? { ConfigurationSetName: configuration.configurationSet }
      : {}),
    EmailTags: [{ Name: "c2c_request_id", Value: requestTag }],
  };
  let output: SendEmailCommandOutput;
  try {
    output = await sender(configuration, input);
  } catch (error) {
    const status = errorMetadataStatus(error);
    if (status === null) {
      return {
        status: "ambiguous",
        provider: "aws_ses",
        errorCode: "aws_ses_request_ambiguous",
      };
    }
    const name = normalizedErrorName(error);
    return {
      status: "rejected",
      provider: "aws_ses",
      errorCode: `aws_ses_${name}`,
      retryable: retryableSesFailure(status, name),
    };
  }
  const messageId = output.MessageId?.trim();
  if (!messageId) {
    return {
      status: "ambiguous",
      provider: "aws_ses",
      errorCode: "aws_ses_response_ambiguous",
    };
  }
  return {
    status: "accepted",
    provider: "aws_ses",
    messageId,
    initialOutcome: "queued",
  };
}
