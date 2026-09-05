import {
  participantEmailSendProtocolVersion,
  participantEmailSendSignatureContext,
  signServiceBody,
  type ParticipantEmailSendRequest,
} from "@code2create/domain";
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { describe, expect, test, vi } from "vitest";

import { handleOutboundEmailRequest } from "./outbound.js";
import { interpretCloudflareEmailSendResponse } from "./providers/cloudflare.js";
import { sendWithSes, type SesEmailConfiguration } from "./providers/ses.js";

const destinationEmail = "participant@example.test";
const ingressSecret = "participant-email-send-secret-with-32-characters";
const sendRequest: ParticipantEmailSendRequest = {
  protocolVersion: participantEmailSendProtocolVersion,
  provider: "aws_ses",
  requestId: "delivery:one",
  to: destinationEmail,
  subject: "Your Code2Create update",
  text: "Open the participant portal.",
  html: "<p>Open the participant portal.</p>",
  headers: [{ name: "X-Code2Create-Delivery-ID", value: "delivery-one" }],
  attachments: [
    {
      filename: "mark.png",
      contentType: "image/png",
      contentBase64: "AQID",
      disposition: "inline",
      contentId: "mark",
    },
  ],
};
const sesConfiguration: SesEmailConfiguration = {
  region: "ap-south-1",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  from: "Code2Create <updates@example.test>",
  replyTo: "support@example.test",
  configurationSet: "code2create",
};

describe("Cloudflare Email Sending response contract", () => {
  test("accepts each documented single-recipient success outcome", () => {
    expect(
      interpretCloudflareEmailSendResponse({
        status: 200,
        ok: true,
        body: cloudflareSuccess({ delivered: ["Participant@example.test"] }),
        destinationEmail,
      }),
    ).toEqual({
      status: "accepted",
      provider: "cloudflare_email",
      messageId: "provider-message-1",
      initialOutcome: "delivered",
    });
    expect(
      interpretCloudflareEmailSendResponse({
        status: 200,
        ok: true,
        body: cloudflareSuccess({ queued: [destinationEmail] }),
        destinationEmail,
      }),
    ).toEqual({
      status: "accepted",
      provider: "cloudflare_email",
      messageId: "provider-message-1",
      initialOutcome: "queued",
    });
    expect(
      interpretCloudflareEmailSendResponse({
        status: 200,
        ok: true,
        body: cloudflareSuccess({ permanentBounces: [destinationEmail] }),
        destinationEmail,
      }),
    ).toEqual({
      status: "accepted",
      provider: "cloudflare_email",
      messageId: "provider-message-1",
      initialOutcome: "permanent_bounce",
    });
  });

  test("retries only a structured rejection that proves non-acceptance", () => {
    expect(
      interpretCloudflareEmailSendResponse({
        status: 429,
        ok: false,
        body: cloudflareFailure(10_004, "email.sending.error.throttled"),
        destinationEmail,
      }),
    ).toEqual({
      status: "rejected",
      provider: "cloudflare_email",
      errorCode: "cloudflare_email_10004",
      retryable: true,
    });
    expect(
      interpretCloudflareEmailSendResponse({
        status: 400,
        ok: false,
        body: cloudflareFailure(10_001, "email.sending.error.invalid_request_schema"),
        destinationEmail,
      }),
    ).toEqual({
      status: "rejected",
      provider: "cloudflare_email",
      errorCode: "cloudflare_email_10001",
      retryable: false,
    });
  });

  test("treats malformed, contradictory, or recipient-mismatched responses as ambiguous", () => {
    expect(
      interpretCloudflareEmailSendResponse({
        status: 200,
        ok: true,
        body: { success: true, result: { delivered: [destinationEmail] } },
        destinationEmail,
      }),
    ).toMatchObject({ status: "ambiguous", errorCode: "cloudflare_email_response_ambiguous" });
    expect(
      interpretCloudflareEmailSendResponse({
        status: 200,
        ok: true,
        body: cloudflareSuccess({ queued: ["other@example.test"] }),
        destinationEmail,
      }),
    ).toMatchObject({
      status: "ambiguous",
      errorCode: "cloudflare_email_recipient_outcome_invalid",
    });
  });
});

describe("Amazon SES provider", () => {
  test("maps HTML, text, custom headers, tags, and inline assets to SES v2", async () => {
    const sender = vi.fn(async (_configuration: SesEmailConfiguration, input: SendEmailCommandInput) => {
      expect(input).toMatchObject({
        FromEmailAddress: sesConfiguration.from,
        Destination: { ToAddresses: [destinationEmail] },
        ReplyToAddresses: [sesConfiguration.replyTo],
        ConfigurationSetName: sesConfiguration.configurationSet,
        EmailTags: [{ Name: "c2c_request_id", Value: "delivery_one" }],
        Content: {
          Simple: {
            Subject: { Data: sendRequest.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: sendRequest.text, Charset: "UTF-8" },
              Html: { Data: sendRequest.html, Charset: "UTF-8" },
            },
            Headers: sendRequest.headers.map((header) => ({
              Name: header.name,
              Value: header.value,
            })),
          },
        },
      });
      expect(input.Content?.Simple?.Attachments?.[0]).toMatchObject({
        FileName: "mark.png",
        ContentType: "image/png",
        ContentDisposition: "INLINE",
        ContentTransferEncoding: "BASE64",
        ContentId: "mark",
      });
      expect(Array.from(input.Content?.Simple?.Attachments?.[0]?.RawContent ?? [])).toEqual([
        1, 2, 3,
      ]);
      return { MessageId: "ses-message-1", $metadata: {} };
    });

    await expect(sendWithSes(sendRequest, sesConfiguration, sender)).resolves.toEqual({
      status: "accepted",
      provider: "aws_ses",
      messageId: "ses-message-1",
      initialOutcome: "queued",
    });
    expect(sender).toHaveBeenCalledOnce();
  });

  test("distinguishes definite SES rejections from ambiguous transport failures", async () => {
    const throttled = Object.assign(new Error("throttled"), {
      name: "TooManyRequestsException",
      $metadata: { httpStatusCode: 429 },
    });
    await expect(
      sendWithSes(sendRequest, sesConfiguration, async () => {
        throw throttled;
      }),
    ).resolves.toEqual({
      status: "rejected",
      provider: "aws_ses",
      errorCode: "aws_ses_too_many_requests",
      retryable: true,
    });
    await expect(
      sendWithSes(sendRequest, sesConfiguration, async () => {
        throw new TypeError("network stopped");
      }),
    ).resolves.toEqual({
      status: "ambiguous",
      provider: "aws_ses",
      errorCode: "aws_ses_request_ambiguous",
    });
  });
});

describe("authenticated outbound email endpoint", () => {
  test("verifies the signed request before dispatching to the selected provider", async () => {
    const body = JSON.stringify(sendRequest);
    const timestamp = String(Date.now());
    const signature = await signServiceBody({
      context: participantEmailSendSignatureContext,
      secret: ingressSecret,
      timestamp,
      body,
    });
    const sender = vi.fn(async () => ({ MessageId: "ses-message-2", $metadata: {} }));
    const response = await handleOutboundEmailRequest(
      new Request("https://email.example.test/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-c2c-signature": signature,
          "x-c2c-timestamp": timestamp,
        },
        body,
      }),
      sesEnvironment(),
      { sesSender: sender },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "accepted",
      provider: "aws_ses",
      messageId: "ses-message-2",
    });
    expect(sender).toHaveBeenCalledOnce();
  });

  test("rejects unsigned requests without contacting a provider", async () => {
    const sender = vi.fn();
    const response = await handleOutboundEmailRequest(
      new Request("https://email.example.test/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sendRequest),
      }),
      sesEnvironment(),
      { sesSender: sender },
    );
    expect(response.status).toBe(401);
    expect(sender).not.toHaveBeenCalled();
  });
});

function sesEnvironment() {
  return {
    EMAIL_SEND_INGRESS_SECRET: ingressSecret,
    AWS_SES_REGION: sesConfiguration.region,
    AWS_SES_ACCESS_KEY_ID: sesConfiguration.accessKeyId,
    AWS_SES_SECRET_ACCESS_KEY: sesConfiguration.secretAccessKey,
    AWS_SES_FROM: sesConfiguration.from,
    AWS_SES_REPLY_TO: "support@example.test",
    AWS_SES_CONFIGURATION_SET: "code2create",
  };
}

function cloudflareSuccess(input: {
  delivered?: string[];
  permanentBounces?: string[];
  queued?: string[];
}) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      delivered: input.delivered ?? [],
      message_id: "provider-message-1",
      permanent_bounces: input.permanentBounces ?? [],
      queued: input.queued ?? [],
    },
  };
}

function cloudflareFailure(code: number, message: string) {
  return {
    success: false,
    errors: [{ code, message }],
    messages: [],
    result: null,
  };
}
