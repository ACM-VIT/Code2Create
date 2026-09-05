import {
  participantEmailProviders,
  participantEmailSendSignatureContext,
  participantEmailReadinessSignatureContext,
  verifyServiceBody,
  type ParticipantEmailSendRequest,
  type ParticipantEmailSendResult,
} from "@code2create/domain";

import { HttpBodyTooLargeError, readBoundedRequestText } from "./httpBody.js";
import { z } from "zod";
import { participantEmailSendRequestSchema } from "./outboundContracts.js";
import {
  sendWithCloudflare,
  type CloudflareEmailConfiguration,
} from "./providers/cloudflare.js";
import { sendWithSes, type SesEmailConfiguration, type SesSender } from "./providers/ses.js";

const maximumSendRequestBytes = 6 * 1_024 * 1_024;

export interface OutboundEmailEnvironment {
  EMAIL_SEND_INGRESS_SECRET: string;
  OUTBOUND_EMAILS: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  CLOUDFLARE_EMAIL_ACCOUNT_ID?: string;
  CLOUDFLARE_EMAIL_API_TOKEN?: string;
  CLOUDFLARE_EMAIL_FROM?: string;
  CLOUDFLARE_EMAIL_REPLY_TO?: string;
  AWS_SES_REGION?: string;
  AWS_SES_ACCESS_KEY_ID?: string;
  AWS_SES_SECRET_ACCESS_KEY?: string;
  AWS_SES_SESSION_TOKEN?: string;
  AWS_SES_FROM?: string;
  AWS_SES_REPLY_TO?: string;
  AWS_SES_CONFIGURATION_SET?: string;
}

type ProviderDependencies = {
  cloudflareFetch?: typeof fetch;
  sesSender?: SesSender;
};

function configuredCloudflare(
  environment: OutboundEmailEnvironment,
): CloudflareEmailConfiguration | null {
  const accountId = environment.CLOUDFLARE_EMAIL_ACCOUNT_ID?.trim();
  const apiToken = environment.CLOUDFLARE_EMAIL_API_TOKEN?.trim();
  const from = environment.CLOUDFLARE_EMAIL_FROM?.trim();
  const replyTo = environment.CLOUDFLARE_EMAIL_REPLY_TO?.trim();
  return accountId && apiToken && from
    ? { accountId, apiToken, from, ...(replyTo ? { replyTo } : {}) }
    : null;
}

function configuredSes(environment: OutboundEmailEnvironment): SesEmailConfiguration | null {
  const region = environment.AWS_SES_REGION?.trim();
  const accessKeyId = environment.AWS_SES_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.AWS_SES_SECRET_ACCESS_KEY?.trim();
  const sessionToken = environment.AWS_SES_SESSION_TOKEN?.trim();
  const from = environment.AWS_SES_FROM?.trim();
  const replyTo = environment.AWS_SES_REPLY_TO?.trim();
  const configurationSet = environment.AWS_SES_CONFIGURATION_SET?.trim();
  if (!region || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(region)) return null;
  return accessKeyId && secretAccessKey && from
    ? {
        region,
        accessKeyId,
        secretAccessKey,
        from,
        ...(sessionToken ? { sessionToken } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(configurationSet ? { configurationSet } : {}),
      }
    : null;
}

export async function sendOutboundEmail(
  request: ParticipantEmailSendRequest,
  environment: OutboundEmailEnvironment,
  dependencies: ProviderDependencies = {},
): Promise<ParticipantEmailSendResult> {
  if (request.provider === "cloudflare_email") {
    const configuration = configuredCloudflare(environment);
    if (!configuration) {
      return {
        status: "rejected",
        provider: request.provider,
        errorCode: "cloudflare_email_not_configured",
        retryable: false,
      };
    }
    return sendWithCloudflare(request, configuration, dependencies.cloudflareFetch);
  }
  const configuration = configuredSes(environment);
  if (!configuration) {
    return {
      status: "rejected",
      provider: request.provider,
      errorCode: "aws_ses_not_configured",
      retryable: false,
    };
  }
  return sendWithSes(request, configuration, dependencies.sesSender);
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function handleOutboundEmailRequest(
  request: Request,
  environment: OutboundEmailEnvironment,
) {
  const readiness = new URL(request.url).pathname === "/readiness";
  let body: string;
  try {
    body = await readBoundedRequestText(request, maximumSendRequestBytes);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof HttpBodyTooLargeError ? "request_too_large" : "request_unreadable" },
      400,
    );
  }
  const timestamp = request.headers.get("x-c2c-timestamp") ?? "";
  const signature = request.headers.get("x-c2c-signature") ?? "";
  let verified = false;
  try {
    verified = await verifyServiceBody({
      context: readiness ? participantEmailReadinessSignatureContext : participantEmailSendSignatureContext,
      secret: environment.EMAIL_SEND_INGRESS_SECRET,
      timestamp,
      signature,
      body,
      now: Date.now(),
      maximumAgeMs: 5 * 60 * 1_000,
    });
  } catch {
    return jsonResponse({ error: "service_not_configured" }, 503);
  }
  if (!verified) return jsonResponse({ error: "unauthorized" }, 401);
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  if (readiness) {
    const parsed = z.object({ provider: z.enum(participantEmailProviders) }).strict().safeParse(decoded);
    if (!parsed.success) return jsonResponse({ error: "invalid_request" }, 400);
    return jsonResponse({ provider: parsed.data.provider, configured: !!environment.OUTBOUND_EMAILS &&
      (parsed.data.provider === "aws_ses" ? configuredSes(environment) !== null : configuredCloudflare(environment) !== null) });
  }
  const parsed = participantEmailSendRequestSchema.safeParse(decoded);
  if (!parsed.success) return jsonResponse({ error: "invalid_request" }, 400);
  const validatedRequest = parsed.data;
  const delivery = environment.OUTBOUND_EMAILS.getByName(validatedRequest.requestId);
  return delivery.fetch(new Request("https://email-dispatch.internal/send", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(validatedRequest),
  }));
}
