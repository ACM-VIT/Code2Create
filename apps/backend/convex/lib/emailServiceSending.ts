import {
  participantEmailProviders,
  participantEmailSendProtocolVersion,
  participantEmailSendSignatureContext,
  signServiceBody,
  type ParticipantEmailProvider,
  type ParticipantEmailSendRequest,
  type ParticipantEmailSendResult,
} from "@code2create/domain";
import { z } from "zod";

import { readBoundedJsonResponse } from "./boundedHttpBody";

const providerSchema = z.enum(participantEmailProviders);
const resultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    provider: providerSchema,
    messageId: z.string().min(1).max(512),
    initialOutcome: z.enum(["queued", "delivered", "permanent_bounce"]),
  }),
  z.object({
    status: z.literal("rejected"),
    provider: providerSchema,
    errorCode: z.string().min(1).max(200),
    retryable: z.boolean(),
  }),
  z.object({
    status: z.literal("ambiguous"),
    provider: providerSchema,
    errorCode: z.string().min(1).max(200),
  }),
]);

type EmailServiceConfiguration = { url: string; secret: string };

function emailServiceConfiguration(): EmailServiceConfiguration | null {
  const configuredUrl = process.env.EMAIL_SERVICE_URL?.trim();
  const secret = process.env.EMAIL_SEND_INGRESS_SECRET?.trim();
  if (!configuredUrl || !secret || new TextEncoder().encode(secret).byteLength < 32) return null;
  let url: URL;
  try {
    url = new URL("/send", configuredUrl);
  } catch {
    return null;
  }
  const localDevelopment = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(localDevelopment && url.protocol === "http:")) return null;
  return { url: url.toString(), secret };
}

export function emailServiceConfigured() {
  return emailServiceConfiguration() !== null;
}

export function configuredParticipantEmailProvider(
  value: string | undefined,
): ParticipantEmailProvider | null {
  const parsed = providerSchema.safeParse(value?.trim());
  return parsed.success ? parsed.data : null;
}

export async function sendEmailThroughService(
  input: Omit<ParticipantEmailSendRequest, "protocolVersion">,
): Promise<ParticipantEmailSendResult> {
  const configuration = emailServiceConfiguration();
  if (!configuration) {
    return {
      status: "rejected",
      provider: input.provider,
      errorCode: "email_service_not_configured",
      retryable: false,
    };
  }
  const request: ParticipantEmailSendRequest = {
    protocolVersion: participantEmailSendProtocolVersion,
    ...input,
  };
  const body = JSON.stringify(request);
  const timestamp = String(Date.now());
  const signature = await signServiceBody({
    context: participantEmailSendSignatureContext,
    secret: configuration.secret,
    timestamp,
    body,
  });
  let response: Response;
  try {
    response = await fetch(configuration.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-signature": signature,
        "x-c2c-timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return {
      status: "ambiguous",
      provider: input.provider,
      errorCode: "email_service_request_ambiguous",
    };
  }
  // This route is owned by the email Worker. A missing route cannot have
  // forwarded the request to a provider; keep it eligible for an ops retry.
  if (response.status === 404) {
    return {
      status: "rejected",
      provider: input.provider,
      errorCode: "email_service_route_not_found",
      retryable: false,
    };
  }
  let decoded: unknown;
  try {
    decoded = await readBoundedJsonResponse(response, 64 * 1_024);
  } catch {
    return {
      status: "ambiguous",
      provider: input.provider,
      errorCode: "email_service_response_ambiguous",
    };
  }
  const parsed = resultSchema.safeParse(decoded);
  if (!response.ok || !parsed.success || parsed.data.provider !== input.provider) {
    return {
      status: "ambiguous",
      provider: input.provider,
      errorCode: "email_service_response_ambiguous",
    };
  }
  return parsed.data;
}
