import {
  participantEmailEventSignatureContext,
  signServiceBody,
} from "@code2create/domain";
import { z } from "zod";

import { normalizeCloudflareEmailEvent } from "./contracts.js";

export interface EmailBridgeEnvironment {
  CONVEX_EMAIL_EVENT_CALLBACK_URL: string;
  EMAIL_EVENT_CALLBACK_SECRET: string;
  EMAIL_ROUTING_ADDRESS: string;
  EMAIL_ROUTING_FORWARD_TO: string;
  EMAIL_SENDING_DOMAIN: string;
}

type EventFetcher = (url: string, init: RequestInit) => Promise<Response>;

type RoutedEmailMessage = {
  readonly to: string;
  forward(recipient: string): Promise<unknown>;
  setReject(reason: string): void;
};

type EmailEventQueueMessage = {
  readonly id: string;
  readonly body: unknown;
  ack(): void;
  retry(): void;
};

type EmailEventRelay = (
  input: unknown,
  environment: EmailBridgeEnvironment,
) => Promise<void>;

const callbackUrlSchema = z.url().refine((value) => value.startsWith("https://"), {
  message: "Expected an HTTPS callback URL.",
});

const emailAddressSchema = z.email().max(320);

export async function relayEmailEvent(
  input: unknown,
  environment: EmailBridgeEnvironment,
  eventFetcher: EventFetcher = fetch,
) {
  const event = normalizeCloudflareEmailEvent(input, environment.EMAIL_SENDING_DOMAIN);
  const body = JSON.stringify(event);
  const timestamp = String(Date.now());
  const signature = await signServiceBody({
    context: participantEmailEventSignatureContext,
    secret: environment.EMAIL_EVENT_CALLBACK_SECRET,
    timestamp,
    body,
  });
  const response = await eventFetcher(
    callbackUrlSchema.parse(environment.CONVEX_EMAIL_EVENT_CALLBACK_URL),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-signature": signature,
        "x-c2c-timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Convex rejected a participant email event with HTTP ${response.status}.`);
  }
}

export async function routeInboundEmail(
  message: RoutedEmailMessage,
  configuredAddress: string,
  configuredRecipient: string,
) {
  const address = emailAddressSchema.safeParse(configuredAddress.trim().toLocaleLowerCase("en"));
  const recipient = emailAddressSchema.safeParse(configuredRecipient.trim());
  if (
    !address.success ||
    !recipient.success ||
    message.to.trim().toLocaleLowerCase("en") !== address.data
  ) {
    message.setReject("Inbound support routing is unavailable.");
    return;
  }
  await message.forward(recipient.data);
}

export async function consumeEmailEventMessages(
  messages: readonly EmailEventQueueMessage[],
  environment: EmailBridgeEnvironment,
  relay: EmailEventRelay = relayEmailEvent,
) {
  for (const message of messages) {
    try {
      await relay(message.body, environment);
      message.ack();
    } catch (error) {
      console.error(
        "Participant email event relay failed",
        message.id,
        error instanceof Error ? error.name : "unknown_error",
      );
      message.retry();
    }
  }
}

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ service: "code2create-email", ok: true });
    }
    return new Response("Not found.", { status: 404 });
  },
  async queue(batch, environment) {
    await consumeEmailEventMessages(batch.messages, environment);
  },
  async email(message, environment) {
    await routeInboundEmail(
      message,
      environment.EMAIL_ROUTING_ADDRESS,
      environment.EMAIL_ROUTING_FORWARD_TO,
    );
  },
} satisfies ExportedHandler<EmailBridgeEnvironment>;
