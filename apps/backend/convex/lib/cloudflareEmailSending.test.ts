import { afterEach, describe, expect, test, vi } from "vitest";

import { authenticationOtpEmail, sendAuthenticationOtp } from "./authenticationEmail";
import { interpretCloudflareEmailSendResponse } from "./cloudflareEmailSending";

const destinationEmail = "participant@example.test";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

describe("authentication OTP email", () => {
  test("renders the six-digit code without putting account data in the message", () => {
    const message = authenticationOtpEmail("123456");
    expect(message.subject).toBe("Your Code2Create sign-in code");
    expect(message.text).toContain("123456");
    expect(message.html).toContain("123456");
    expect(message.text).toContain("10 minutes");
  });

  test("refuses malformed codes", () => {
    expect(() => authenticationOtpEmail("12345")).toThrow(/six digits/u);
    expect(() => authenticationOtpEmail("12345<")).toThrow(/six digits/u);
  });

  test("brands the message with marks hosted at the portal origin when one is known", () => {
    const branded = authenticationOtpEmail("123456", "https://c2c.acmvit.in");
    expect(branded.html).toContain("https://c2c.acmvit.in/assets/email/c2c-mark.png");
    expect(branded.html).toContain("https://c2c.acmvit.in/assets/email/acm-mark.png");
    expect(branded.html).toContain("ACM-VIT");
    const plain = authenticationOtpEmail("123456");
    expect(plain.html).not.toContain("<img");
    expect(plain.html).toContain("Code2Create");
  });

  test("delivers sign-in codes through the configured Cloudflare sender", async () => {
    vi.stubEnv("CLOUDFLARE_EMAIL_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_EMAIL_API_TOKEN", "test-token");
    vi.stubEnv("CLOUDFLARE_EMAIL_FROM", "Code2Create <updates@example.test>");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(
      successResponse({ queued: [destinationEmail] }),
    ), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await sendAuthenticationOtp({
      email: destinationEmail,
      otp: "123456",
      type: "sign-in",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/test-account/email/sending/send",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: expect.stringContaining('"to":"participant@example.test"'),
      }),
    );
  });

  test("reports deterministic transport failures instead of advancing to code entry", async () => {
    vi.stubEnv("CLOUDFLARE_EMAIL_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_EMAIL_API_TOKEN", "test-token");
    vi.stubEnv("CLOUDFLARE_EMAIL_FROM", "Code2Create <updates@example.test>");
    const dnsFailure = new TypeError("getaddrinfo ENOTFOUND api.cloudflare.com");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(dnsFailure));

    await expect(sendAuthenticationOtp({
      email: destinationEmail,
      otp: "123456",
      type: "sign-in",
    })).rejects.toThrow("Authentication email could not be sent.");
  });

  test("preserves the issued code when its own deadline leaves delivery ambiguous", async () => {
    vi.stubEnv("CLOUDFLARE_EMAIL_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_EMAIL_API_TOKEN", "test-token");
    vi.stubEnv("CLOUDFLARE_EMAIL_FROM", "Code2Create <updates@example.test>");
    const timedOut = AbortSignal.abort(new DOMException("deadline elapsed", "TimeoutError"));
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timedOut);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch stopped")));

    await expect(sendAuthenticationOtp({
      email: destinationEmail,
      otp: "123456",
      type: "sign-in",
    })).resolves.toBeUndefined();
  });

  test("does not send email sign-in codes to the VIT Workspace domain", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendAuthenticationOtp({
      email: "student@vitstudent.ac.in",
      otp: "123456",
      type: "sign-in",
    })).rejects.toThrow("continue with Google Workspace");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
