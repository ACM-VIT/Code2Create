import { describe, expect, test } from "vitest";

import { interpretCloudflareEmailSendResponse } from "./cloudflareEmailSending";

const destinationEmail = "participant@example.test";

describe("Cloudflare Email Sending response contract", () => {
  test("accepts each documented single-recipient success outcome", () => {
    expect(interpretCloudflareEmailSendResponse({
      status: 200,
      ok: true,
      body: successResponse({ delivered: ["Participant@example.test"] }),
      destinationEmail,
    })).toEqual({
      kind: "accepted",
      providerMessageId: "provider-message-1",
      initialOutcome: "delivered",
    });

    expect(interpretCloudflareEmailSendResponse({
      status: 200,
      ok: true,
      body: successResponse({ queued: [destinationEmail] }),
      destinationEmail,
    })).toEqual({
      kind: "accepted",
      providerMessageId: "provider-message-1",
      initialOutcome: "queued",
    });

    expect(interpretCloudflareEmailSendResponse({
      status: 200,
      ok: true,
      body: successResponse({ permanentBounces: [destinationEmail] }),
      destinationEmail,
    })).toEqual({
      kind: "accepted",
      providerMessageId: "provider-message-1",
      initialOutcome: "permanent_bounce",
    });
  });

  test("retries only a structured provider rejection that proves non-acceptance", () => {
    expect(interpretCloudflareEmailSendResponse({
      status: 429,
      ok: false,
      body: failureResponse(10_004, "email.sending.error.throttled"),
      destinationEmail,
    })).toEqual({
      kind: "rejected",
      errorCode: "cloudflare_email_10004",
      retryable: true,
    });

    expect(interpretCloudflareEmailSendResponse({
      status: 400,
      ok: false,
      body: failureResponse(10_001, "email.sending.error.invalid_request_schema"),
      destinationEmail,
    })).toEqual({
      kind: "rejected",
      errorCode: "cloudflare_email_10001",
      retryable: false,
    });
  });

  test("treats malformed or contradictory responses as ambiguous", () => {
    expect(interpretCloudflareEmailSendResponse({
      status: 200,
      ok: true,
      body: { success: true, result: { delivered: [destinationEmail] } },
      destinationEmail,
    })).toEqual({
      kind: "ambiguous",
      errorCode: "cloudflare_email_response_ambiguous",
    });

    expect(interpretCloudflareEmailSendResponse({
      status: 500,
      ok: false,
      body: successResponse({ queued: [destinationEmail] }),
      destinationEmail,
    })).toEqual({
      kind: "ambiguous",
      errorCode: "cloudflare_email_response_ambiguous",
    });
  });

  test("rejects a success body that does not describe exactly the intended recipient", () => {
    expect(interpretCloudflareEmailSendResponse({
      status: 200,
      ok: true,
      body: successResponse({ queued: ["other@example.test"] }),
      destinationEmail,
    })).toEqual({
      kind: "ambiguous",
      errorCode: "cloudflare_email_recipient_outcome_invalid",
    });

    expect(interpretCloudflareEmailSendResponse({
      status: 200,
      ok: true,
      body: successResponse({
        delivered: [destinationEmail],
        queued: [destinationEmail],
      }),
      destinationEmail,
    })).toEqual({
      kind: "ambiguous",
      errorCode: "cloudflare_email_recipient_outcome_invalid",
    });
  });
});

function successResponse(input: {
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

function failureResponse(code: number, message: string) {
  return {
    success: false,
    errors: [{ code, message }],
    messages: [],
    result: null,
  };
}
