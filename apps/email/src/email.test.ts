import { participantEmailEventSignatureContext, verifyServiceBody } from "@code2create/domain";
import type { ParticipantEmailEvent } from "@code2create/domain";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import {
  cloudflareEmailSendingEventSchema,
  normalizeCloudflareEmailEvent,
} from "./contracts.js";
import {
  consumeEmailEventMessages,
  relayEmailEvent,
  routeInboundEmail,
} from "./worker.js";
import type { EmailBridgeEnvironment } from "./worker.js";

const domain = "mail.code2create.example";
const eventTimestamp = "2026-08-08T12:00:00.000Z";
const callbackSecret = "participant-email-test-secret-with-32-characters";
const environment: EmailBridgeEnvironment = {
  CONVEX_EMAIL_EVENT_CALLBACK_URL:
    "https://backend.example.test/communications/cloudflare-email/events",
  EMAIL_EVENT_CALLBACK_SECRET: callbackSecret,
  EMAIL_SEND_INGRESS_SECRET: "participant-email-send-secret-with-32-characters",
  EMAIL_ROUTING_ADDRESS: "support@mail.code2create.example",
  EMAIL_ROUTING_FORWARD_TO: "operations@example.test",
  EMAIL_SENDING_DOMAIN: domain,
};

describe("Cloudflare Email Service bridge", () => {
  test("normalizes lifecycle events without retaining SMTP or message content", () => {
    expect(normalizedEvent({ kind: "delivered" })).toEqual({
      protocolVersion: "participant-email-v1",
      eventId: "email-event-1",
      messageId: "provider-message-1",
      recipient: "participant@example.test",
      eventType: "email.delivered",
      providerAt: Date.parse(eventTimestamp),
      disableDestination: false,
    });
    expect(normalizedEvent({ kind: "deferred" })).toMatchObject({
      eventType: "email.delivery_delayed",
      disableDestination: false,
      providerErrorCode: "cloudflare_email_deferred",
    });
    expect(
      normalizedEvent({ kind: "bounced", bounceType: "soft" }),
    ).toMatchObject({
      eventType: "email.bounced",
      disableDestination: false,
      providerErrorCode: "cloudflare_email_bounced_soft",
    });
    expect(
      normalizedEvent({ kind: "bounced", bounceType: "hard" }),
    ).toMatchObject({
      eventType: "email.bounced",
      disableDestination: true,
      providerErrorCode: "cloudflare_email_bounced_hard",
    });
    expect(normalizedEvent({ kind: "failed" })).toMatchObject({
      eventType: "email.failed",
      disableDestination: false,
      providerErrorCode: "cloudflare_email_failed",
    });
    expect(
      normalizedEvent({ kind: "rejected", reason: "suppressed" }),
    ).toMatchObject({
      eventType: "email.suppressed",
      disableDestination: true,
      providerErrorCode: "cloudflare_email_suppressed",
    });
    expect(
      normalizedEvent({ kind: "rejected", reason: "spam_policy" }),
    ).toMatchObject({
      eventType: "email.failed",
      disableDestination: false,
      providerErrorCode: "cloudflare_email_rejected",
    });
    expect(normalizedEvent({ kind: "complained" })).toMatchObject({
      eventType: "email.complained",
      disableDestination: true,
      providerErrorCode: "cloudflare_email_complained",
    });
  });

  test("rejects events from a different sending domain", () => {
    expect(() =>
      normalizeCloudflareEmailEvent(
        cloudflareEmailSendingEventSchema.parse(event({ kind: "delivered" })),
        "other.example",
      ),
    ).toThrow("unexpected domain");
  });

  test("relays the bounded event with an independently verifiable signature", async () => {
    const eventFetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = z.string().parse(init.body);
      const headers = new Headers(init.headers);
      expect(
        await verifyServiceBody({
          context: participantEmailEventSignatureContext,
          secret: callbackSecret,
          timestamp: headers.get("x-c2c-timestamp") ?? "",
          signature: headers.get("x-c2c-signature") ?? "",
          body,
          now: Date.now(),
          maximumAgeMs: 60_000,
        }),
      ).toBe(true);
      expect(JSON.parse(body)).toMatchObject({
        eventId: "email-event-1",
        messageId: "provider-message-1",
        eventType: "email.delivered",
      });
      return new Response(null, { status: 200 });
    });
    await relayEmailEvent(normalizedEvent({ kind: "delivered" }), environment, eventFetcher);
    expect(eventFetcher).toHaveBeenCalledOnce();
  });

  test("acknowledges successful Queue messages and retries failed callbacks independently", async () => {
    const firstAck = vi.fn();
    const firstRetry = vi.fn();
    const secondAck = vi.fn();
    const secondRetry = vi.fn();
    const relay = vi
      .fn<
        (event: ParticipantEmailEvent, relayEnvironment: EmailBridgeEnvironment) => Promise<void>
      >()
      .mockRejectedValueOnce(new Error("callback unavailable"))
      .mockResolvedValueOnce(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await consumeEmailEventMessages(
      [
        {
          id: "queue-message-1",
          body: event({ kind: "delivered" }),
          ack: () => {
            firstAck();
          },
          retry: () => {
            firstRetry();
          },
        },
        {
          id: "queue-message-2",
          body: event({ kind: "complained" }),
          ack: () => {
            secondAck();
          },
          retry: () => {
            secondRetry();
          },
        },
      ],
      environment,
      relay,
    );

    expect(firstAck).not.toHaveBeenCalled();
    expect(firstRetry).toHaveBeenCalledOnce();
    expect(secondAck).toHaveBeenCalledOnce();
    expect(secondRetry).not.toHaveBeenCalled();
    expect(relay).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(
      "Participant email event relay failed",
      "queue-message-1",
      "Error",
    );
    consoleError.mockRestore();
  });

  test("forwards an inbound routed message only to the configured verified destination", async () => {
    const forward = vi.fn(async (_recipient: string) => ({ messageId: "forwarded-message" }));
    const setReject = vi.fn();
    await routeInboundEmail(
      {
        to: "Support@mail.code2create.example",
        forward,
        setReject: (reason) => {
          setReject(reason);
        },
      },
      "support@mail.code2create.example",
      "operations@example.test",
    );
    expect(forward).toHaveBeenCalledWith("operations@example.test");
    expect(setReject).not.toHaveBeenCalled();

    await routeInboundEmail(
      {
        to: "other@mail.code2create.example",
        forward,
        setReject: (reason) => {
          setReject(reason);
        },
      },
      "support@mail.code2create.example",
      "operations@example.test",
    );
    expect(forward).toHaveBeenCalledOnce();
    expect(setReject).toHaveBeenCalledWith("Inbound support routing is unavailable.");

    await routeInboundEmail(
      {
        to: "support@mail.code2create.example",
        forward,
        setReject: (reason) => {
          setReject(reason);
        },
      },
      "support@mail.code2create.example",
      "not-an-email",
    );
    expect(setReject).toHaveBeenCalledWith("Inbound support routing is unavailable.");
  });
});

type EventFixture =
  | { kind: "delivered" }
  | { kind: "deferred" }
  | { kind: "bounced"; bounceType: "hard" | "soft" }
  | { kind: "failed" }
  | { kind: "rejected"; reason: string }
  | { kind: "complained" };

function normalizedEvent(fixture: EventFixture): ParticipantEmailEvent {
  return normalizeCloudflareEmailEvent(cloudflareEmailSendingEventSchema.parse(event(fixture)), domain);
}

function event(fixture: EventFixture) {
  const payload = {
    eventId: "email-event-1",
    messageId: "provider-message-1",
    recipient: "Participant@example.test",
    sender: "notifications@mail.code2create.example",
    subject: "Private status update",
  };
  const common = {
    source: { type: "email.sending", domain, zoneId: "zone-1" },
    metadata: {
      accountId: "account-1",
      eventSubscriptionId: "subscription-1",
      eventSchemaVersion: 1,
      eventTimestamp,
    },
  };
  if (fixture.kind === "delivered") {
    return {
      type: "cf.email.sending.message.delivered",
      ...common,
      payload: {
        ...payload,
        terminal: true,
        delivery: { status: "delivered", smtpResponse: "250 accepted" },
      },
    };
  }
  if (fixture.kind === "deferred") {
    return {
      type: "cf.email.sending.message.deferred",
      ...common,
      payload: {
        ...payload,
        terminal: false,
        delivery: { status: "deferred", smtpResponse: "451 retry later" },
        bounce: { type: "soft", reason: "temporary mailbox error" },
      },
    };
  }
  if (fixture.kind === "bounced") {
    return {
      type: "cf.email.sending.message.bounced",
      ...common,
      payload: {
        ...payload,
        terminal: true,
        delivery: { status: "bounced" },
        bounce: { type: fixture.bounceType, reason: "mailbox failure" },
      },
    };
  }
  if (fixture.kind === "failed") {
    return {
      type: "cf.email.sending.message.failed",
      ...common,
      payload: {
        ...payload,
        terminal: true,
        delivery: { status: "failed" },
        failure: { reason: "delivery_failed" },
      },
    };
  }
  if (fixture.kind === "rejected") {
    return {
      type: "cf.email.sending.message.rejected",
      ...common,
      payload: {
        ...payload,
        terminal: true,
        delivery: { status: "rejected" },
        rejection: { reason: fixture.reason, detail: "policy rejection" },
      },
    };
  }
  return {
    type: "cf.email.sending.message.complained",
    ...common,
    payload: {
      ...payload,
      terminal: true,
      delivery: { status: "complained" },
      complaint: { type: "abuse" },
    },
  };
}
