import {
  participantEmailSendSignatureContext,
  verifyServiceBody,
} from "@code2create/domain";
import { afterEach, describe, expect, test, vi } from "vitest";

import { authenticationOtpEmail, sendAuthenticationOtp } from "./authenticationEmail";

const destinationEmail = "participant@example.test";
const ingressSecret = "participant-email-send-secret-with-32-characters";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

  test("delivers sign-in codes through the signed email-service boundary", async () => {
    configureEmailService();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const headers = new Headers(init?.headers);
      expect(
        await verifyServiceBody({
          context: participantEmailSendSignatureContext,
          secret: ingressSecret,
          timestamp: headers.get("x-c2c-timestamp") ?? "",
          signature: headers.get("x-c2c-signature") ?? "",
          body,
          now: Date.now(),
          maximumAgeMs: 60_000,
        }),
      ).toBe(true);
      expect(JSON.parse(body)).toMatchObject({
        protocolVersion: "participant-email-send-v1",
        provider: "aws_ses",
        to: destinationEmail,
        headers: [{ name: "X-Code2Create-Message-Type", value: "authentication-otp" }],
      });
      return Response.json({
        status: "accepted",
        provider: "aws_ses",
        messageId: "ses-message-1",
        initialOutcome: "queued",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendAuthenticationOtp({ email: destinationEmail, otp: "123456", type: "sign-in" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://email.example.test/send");
  });

  test("rejects a definite provider refusal", async () => {
    configureEmailService();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          status: "rejected",
          provider: "aws_ses",
          errorCode: "aws_ses_message_rejected",
          retryable: false,
        }),
      ),
    );
    await expect(
      sendAuthenticationOtp({ email: destinationEmail, otp: "123456", type: "sign-in" }),
    ).rejects.toThrow("rejected by the delivery provider");
  });

  test("preserves the issued code when delivery is ambiguous", async () => {
    configureEmailService();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch stopped")));
    await expect(
      sendAuthenticationOtp({ email: destinationEmail, otp: "123456", type: "sign-in" }),
    ).resolves.toBeUndefined();
  });

  test("does not send email sign-in codes to the VIT Workspace domain", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      sendAuthenticationOtp({
        email: "student@vitstudent.ac.in",
        otp: "123456",
        type: "sign-in",
      }),
    ).rejects.toThrow("continue with Google Workspace");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function configureEmailService() {
  vi.stubEnv("EMAIL_SERVICE_URL", "https://email.example.test");
  vi.stubEnv("EMAIL_SEND_INGRESS_SECRET", ingressSecret);
  vi.stubEnv("AUTHENTICATION_EMAIL_PROVIDER", "aws_ses");
}
