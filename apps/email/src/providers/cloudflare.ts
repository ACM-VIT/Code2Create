import type {
  ParticipantEmailSendRequest,
  ParticipantEmailSendResult,
} from "@code2create/domain";
import { z } from "zod";

import { readBoundedResponseText } from "../httpBody.js";

const cloudflareApiBase = "https://api.cloudflare.com/client/v4/accounts";

export type CloudflareEmailConfiguration = {
  accountId: string;
  apiToken: string;
  from: string;
  replyTo?: string;
};

const providerError = z.object({
  code: z.number().int(),
  message: z.string().max(500),
});

const sendFailure = z.object({
  success: z.literal(false),
  errors: z.array(providerError).min(1).max(20),
});

const sendSuccess = z.object({
  success: z.literal(true),
  result: z.object({
    delivered: z.array(z.email().max(320)).max(1),
    message_id: z.string().min(1).max(512),
    permanent_bounces: z.array(z.email().max(320)).max(1),
    queued: z.array(z.email().max(320)).max(1),
  }),
});

function retryableProviderFailure(status: number, providerCode: number | undefined) {
  return (
    status === 429 ||
    status >= 500 ||
    providerCode === 10_004 ||
    providerCode === 10_002 ||
    providerCode === 10_003 ||
    providerCode === 10_100
  );
}

function providerErrorCode(status: number, code: number | undefined) {
  return code === undefined ? `cloudflare_email_http_${status}` : `cloudflare_email_${code}`;
}

export function interpretCloudflareEmailSendResponse(input: {
  status: number;
  ok: boolean;
  body: unknown;
  destinationEmail: string;
}): ParticipantEmailSendResult {
  const parsedFailure = sendFailure.safeParse(input.body);
  if (parsedFailure.success) {
    const code = parsedFailure.data.errors[0]?.code;
    return {
      status: "rejected",
      provider: "cloudflare_email",
      errorCode: providerErrorCode(input.status, code),
      retryable: retryableProviderFailure(input.status, code),
    };
  }
  const parsedSuccess = sendSuccess.safeParse(input.body);
  if (!input.ok || !parsedSuccess.success) {
    return {
      status: "ambiguous",
      provider: "cloudflare_email",
      errorCode: "cloudflare_email_response_ambiguous",
    };
  }
  const destination = input.destinationEmail.toLocaleLowerCase("en");
  const delivered = parsedSuccess.data.result.delivered.map((email) =>
    email.toLocaleLowerCase("en")
  );
  const permanentBounces = parsedSuccess.data.result.permanent_bounces.map((email) =>
    email.toLocaleLowerCase("en")
  );
  const queued = parsedSuccess.data.result.queued.map((email) =>
    email.toLocaleLowerCase("en")
  );
  const outcomes = [...delivered, ...permanentBounces, ...queued];
  if (outcomes.length !== 1 || outcomes[0] !== destination) {
    return {
      status: "ambiguous",
      provider: "cloudflare_email",
      errorCode: "cloudflare_email_recipient_outcome_invalid",
    };
  }
  return {
    status: "accepted",
    provider: "cloudflare_email",
    messageId: parsedSuccess.data.result.message_id,
    initialOutcome: delivered.length === 1
      ? "delivered"
      : permanentBounces.length === 1
        ? "permanent_bounce"
        : "queued",
  };
}

export async function sendWithCloudflare(
  request: ParticipantEmailSendRequest,
  configuration: CloudflareEmailConfiguration,
  providerFetch: typeof fetch = fetch,
): Promise<ParticipantEmailSendResult> {
  let response: Response;
  try {
    response = await providerFetch(
      `${cloudflareApiBase}/${encodeURIComponent(configuration.accountId)}/email/sending/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${configuration.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: configuration.from,
          to: request.to,
          subject: request.subject,
          text: request.text,
          html: request.html,
          ...(request.attachments.length > 0
            ? {
                attachments: request.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  type: attachment.contentType,
                  content: attachment.contentBase64,
                  disposition: attachment.disposition,
                  ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
                })),
              }
            : {}),
          headers: Object.fromEntries(request.headers.map((header) => [header.name, header.value])),
          ...(configuration.replyTo ? { reply_to: configuration.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return {
      status: "ambiguous",
      provider: "cloudflare_email",
      errorCode: "cloudflare_email_request_ambiguous",
    };
  }
  let decoded: unknown;
  try {
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
      throw new Error("The provider response is not JSON.");
    }
    decoded = JSON.parse(await readBoundedResponseText(response, 64 * 1_024));
  } catch {
    return {
      status: "ambiguous",
      provider: "cloudflare_email",
      errorCode: "cloudflare_email_response_ambiguous",
    };
  }
  return interpretCloudflareEmailSendResponse({
    status: response.status,
    ok: response.ok,
    body: decoded,
    destinationEmail: request.to,
  });
}
