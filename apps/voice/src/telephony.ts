import type {
  OutboundCallEventType,
  VenueConfirmationCall,
} from "@code2create/domain";

import {
  sarvamErrorResponseSchema,
  sarvamOutboundResponseSchema,
  twilioCreateResponseSchema,
  twilioErrorResponseSchema,
} from "./contracts.js";

export type TelephonyEnvironment = {
  OUTBOUND_CALL_PRIMARY_PROVIDER?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  PUBLIC_BASE_URL: string;
  SARVAM_VOICE_AGENTS_API_KEY?: string;
  SARVAM_ORG_ID?: string;
  SARVAM_WORKSPACE_ID?: string;
  SARVAM_APP_ID?: string;
  SARVAM_APP_VERSION?: string;
  SARVAM_CONNECTION_ID?: string;
  SARVAM_AGENT_PHONE_NUMBER?: string;
};

export type TelephonyProvider = "twilio" | "sarvam";

export type QueuedCall = {
  provider: TelephonyProvider;
  providerCallId: string;
  providerStatus: string;
};

export class AmbiguousCallDispatchError extends Error {
  constructor() {
    super("The telephony provider response was ambiguous.");
    this.name = "AmbiguousCallDispatchError";
  }
}

export class RejectedCallDispatchError extends Error {
  constructor(
    readonly provider: TelephonyProvider,
    detail: string,
  ) {
    const name = provider === "twilio" ? "Twilio" : "Sarvam Voice Agents";
    super(`${name} rejected the call: ${detail}`);
    this.name = "RejectedCallDispatchError";
  }
}

export class TelephonyConfigurationError extends Error {
  constructor(message = "No outbound telephony provider is fully configured.") {
    super(message);
    this.name = "TelephonyConfigurationError";
  }
}

export const OUTBOUND_CALL_INTRODUCTION =
  "hi, i'm calling on behalf of the code2create team";

export function withOutboundCallIntroduction(script: string) {
  const message = script.trim();
  if (!message) return OUTBOUND_CALL_INTRODUCTION;
  if (
    message
      .toLocaleLowerCase("en")
      .startsWith(OUTBOUND_CALL_INTRODUCTION.toLocaleLowerCase("en"))
  ) {
    return message;
  }
  return `${OUTBOUND_CALL_INTRODUCTION}. ${message}`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function requiredHttpsBaseUrl(value: string) {
  const base = value.trim().replace(/\/+$/u, "");
  if (!base.startsWith("https://")) {
    throw new Error("PUBLIC_BASE_URL must be an HTTPS URL.");
  }
  return base;
}

function sarvamAppVersion(environment: TelephonyEnvironment) {
  const value = environment.SARVAM_APP_VERSION?.trim();
  if (!value || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function sarvamVoiceAgentsApiKey(environment: TelephonyEnvironment) {
  const value = environment.SARVAM_VOICE_AGENTS_API_KEY?.trim();
  return value || null;
}

function configuredValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function outboundCallProviderOrder(
  environment: TelephonyEnvironment,
): readonly [TelephonyProvider, TelephonyProvider] {
  const primaryProvider = configuredValue(
    environment.OUTBOUND_CALL_PRIMARY_PROVIDER,
  );
  const configured = primaryProvider?.toLocaleLowerCase("en") ?? null;
  if (configured === null || configured === "twilio") {
    return ["twilio", "sarvam"];
  }
  if (configured === "sarvam") {
    return ["sarvam", "twilio"];
  }
  throw new TelephonyConfigurationError(
    "OUTBOUND_CALL_PRIMARY_PROVIDER must be either twilio or sarvam.",
  );
}

export function twilioConfigured(environment: TelephonyEnvironment) {
  return Boolean(
    configuredValue(environment.TWILIO_ACCOUNT_SID) &&
    configuredValue(environment.TWILIO_AUTH_TOKEN) &&
    configuredValue(environment.TWILIO_FROM_NUMBER),
  );
}

export function sarvamConfigured(environment: TelephonyEnvironment) {
  return Boolean(
    sarvamVoiceAgentsApiKey(environment) &&
    configuredValue(environment.SARVAM_ORG_ID) &&
    configuredValue(environment.SARVAM_WORKSPACE_ID) &&
    configuredValue(environment.SARVAM_APP_ID) &&
    sarvamAppVersion(environment) !== null &&
    configuredValue(environment.SARVAM_CONNECTION_ID) &&
    configuredValue(environment.SARVAM_AGENT_PHONE_NUMBER),
  );
}

export function twilioRouteUrl(
  environment: Pick<TelephonyEnvironment, "PUBLIC_BASE_URL">,
  route: "voice" | "status" | "fallback",
  deliveryId: string,
  token: string,
) {
  return `${requiredHttpsBaseUrl(environment.PUBLIC_BASE_URL)}/twilio/${route}/${encodeURIComponent(deliveryId)}/${encodeURIComponent(token)}`;
}

export function sarvamWebhookUrl(
  environment: Pick<TelephonyEnvironment, "PUBLIC_BASE_URL">,
  deliveryId: string,
  token: string,
) {
  return `${requiredHttpsBaseUrl(environment.PUBLIC_BASE_URL)}/sarvam/status/${encodeURIComponent(deliveryId)}/${encodeURIComponent(token)}`;
}

export function twilioVoiceXml(script: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice" language="en-US">${escapeXml(withOutboundCallIntroduction(script))}</Say><Hangup/></Response>`;
}

export async function queueTwilioCall(
  environment: TelephonyEnvironment,
  args: { deliveryId: string; token: string; destinationPhoneE164: string },
): Promise<QueuedCall> {
  const accountSid = configuredValue(environment.TWILIO_ACCOUNT_SID);
  const authToken = configuredValue(environment.TWILIO_AUTH_TOKEN);
  const fromNumber = configuredValue(environment.TWILIO_FROM_NUMBER);
  if (!accountSid || !authToken || !fromNumber) {
    throw new TelephonyConfigurationError();
  }
  const endpoint =
    "https://api.twilio.com/2010-04-01/Accounts/" +
    `${encodeURIComponent(accountSid)}/Calls.json`;
  const body = new URLSearchParams({
    To: args.destinationPhoneE164,
    From: fromNumber,
    Url: twilioRouteUrl(environment, "voice", args.deliveryId, args.token),
    Method: "POST",
    FallbackUrl: twilioRouteUrl(
      environment,
      "fallback",
      args.deliveryId,
      args.token,
    ),
    FallbackMethod: "POST",
    StatusCallback: twilioRouteUrl(
      environment,
      "status",
      args.deliveryId,
      args.token,
    ),
    StatusCallbackMethod: "POST",
    Timeout: "25",
  });
  for (const event of ["initiated", "ringing", "answered", "completed"]) {
    body.append("StatusCallbackEvent", event);
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AmbiguousCallDispatchError();
  }
  return decodeTwilioResponse(response);
}

async function decodeTwilioResponse(response: Response): Promise<QueuedCall> {
  if (response.status === 408 || response.status >= 500) {
    throw new AmbiguousCallDispatchError();
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new AmbiguousCallDispatchError();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    if (response.ok) {
      throw new AmbiguousCallDispatchError();
    }
    throw new RejectedCallDispatchError("twilio", `HTTP ${response.status}`);
  }
  if (!response.ok) {
    const error = twilioErrorResponseSchema.safeParse(decoded);
    const detail =
      error.success && error.data.message !== undefined
        ? error.data.message
        : `HTTP ${response.status}`;
    throw new RejectedCallDispatchError("twilio", detail);
  }
  const accepted = twilioCreateResponseSchema.safeParse(decoded);
  if (!accepted.success) {
    throw new AmbiguousCallDispatchError();
  }
  return {
    provider: "twilio",
    providerCallId: accepted.data.sid,
    providerStatus: accepted.data.status ?? "queued",
  };
}

export async function queueSarvamCall(
  environment: TelephonyEnvironment,
  args: {
    deliveryId: string;
    token: string;
    destinationPhoneE164: string;
    script: string;
    venueConfirmation?: VenueConfirmationCall | undefined;
  },
): Promise<QueuedCall> {
  const apiKey = sarvamVoiceAgentsApiKey(environment);
  const orgId = configuredValue(environment.SARVAM_ORG_ID);
  const workspaceId = configuredValue(environment.SARVAM_WORKSPACE_ID);
  const appId =
    args.venueConfirmation?.appId ?? configuredValue(environment.SARVAM_APP_ID);
  const appVersion =
    args.venueConfirmation?.appVersion ?? sarvamAppVersion(environment);
  const connectionId = configuredValue(environment.SARVAM_CONNECTION_ID);
  const agentPhoneNumber = configuredValue(environment.SARVAM_AGENT_PHONE_NUMBER,
  );
  if (
    !apiKey ||
    !orgId ||
    !workspaceId ||
    !appId ||
    appVersion === null ||
    !connectionId ||
    !agentPhoneNumber
  ) {
    throw new TelephonyConfigurationError();
  }
  const endpoint =
    "https://apps.sarvam.ai/api/outbounds/v1/orgs/" +
    `${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/outbounds`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        app_config: {
          app_id: appId,
          app_version: appVersion,
          connection_config: {
            connection_id: connectionId,
            agent_phone_number: agentPhoneNumber,
          },
          app_type: "agent",
          agent_variables: {
            call_message: withOutboundCallIntroduction(args.script),
            ...(args.venueConfirmation
              ? {
                  reviewer_name: args.venueConfirmation.reviewerName,
                  venue_name: args.venueConfirmation.venueName,
                  outcome: "unclear",
                  confirmed: false,
                  summary: "",
                  return_in_minutes: null,
                }
              : {}),
          },
          app_overrides: {
            initial_language_name: "English",
          },
        },
        user_config: {
          user_phone_number: args.destinationPhoneE164,
        },
        webhook_config: {
          url: sarvamWebhookUrl(
            environment,
            args.deliveryId,
            args.token),
          metadata: {
            delivery_id: args.deliveryId,
          },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AmbiguousCallDispatchError();
  }
  return decodeSarvamResponse(response);
}

async function decodeSarvamResponse(response: Response): Promise<QueuedCall> {
  if (response.status === 408 || response.status >= 500) {
    throw new AmbiguousCallDispatchError();
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new AmbiguousCallDispatchError();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    if (response.ok) throw new AmbiguousCallDispatchError();
    throw new RejectedCallDispatchError("sarvam", `HTTP ${response.status}`);
  }
  if (!response.ok) {
    const error = sarvamErrorResponseSchema.safeParse(decoded);
    const detail = error.success
      ? typeof error.data.detail === "string"
        ? error.data.detail
        : (error.data.detail?.[0]?.msg ??
          error.data.message ??
          error.data.error?.message ??
          `HTTP ${response.status}`)
      : `HTTP ${response.status}`;
    throw new RejectedCallDispatchError("sarvam", detail);
  }
  const accepted = sarvamOutboundResponseSchema.safeParse(decoded);
  if (!accepted.success) throw new AmbiguousCallDispatchError();
  return {
    provider: "sarvam",
    providerCallId: accepted.data.attempt_id,
    providerStatus: "queued",
  };
}

function providerConfigured(
  environment: TelephonyEnvironment,
  provider: TelephonyProvider,
) {
  return provider === "twilio"
    ? twilioConfigured(environment)
    : sarvamConfigured(environment);
}

function queueProviderCall(
  provider: TelephonyProvider,
  environment: TelephonyEnvironment,
  args: {
    deliveryId: string;
    token: string;
    destinationPhoneE164: string;
    script: string;
    venueConfirmation?: VenueConfirmationCall | undefined;
  },
) {
  return provider === "twilio"
    ? queueTwilioCall(environment, args)
    : queueSarvamCall(environment, args);
}

export async function queueOutboundCall(
  environment: TelephonyEnvironment,
  args: {
    deliveryId: string;
    token: string;
    destinationPhoneE164: string;
    script: string;
    venueConfirmation?: VenueConfirmationCall | undefined;
  },
) {
  if (args.venueConfirmation) {
    if (args.venueConfirmation.expiresAt <= Date.now())
      throw new TelephonyConfigurationError(
        "The confirmation request expired.",
      );
    return queueSarvamCall(environment, args);
  }
  const providerOrder = outboundCallProviderOrder(environment);
  let lastRejection: RejectedCallDispatchError | null = null;
  for (const provider of providerOrder) {
    if (!providerConfigured(environment, provider)) continue;
    try {
      return await queueProviderCall(provider, environment, args);
    } catch (error) {
      if (!(error instanceof RejectedCallDispatchError)) {
        throw error;
      }
      lastRejection = error;
    }
  }
  if (lastRejection !== null) throw lastRejection;
  throw new TelephonyConfigurationError();
}

export function twilioStatusEvent(status: string,
): OutboundCallEventType | null {
  switch (status.trim().toLocaleLowerCase("en")) {
    case "queued": {
      return "call.queued";
    }
    case "initiated": {
      return "call.initiated";
    }
    case "ringing": {
      return "call.ringing";
    }
    case "in-progress": {
      return "call.answered";
    }
    case "completed": {
      return "call.completed";
    }
    case "busy": {
      return "call.busy";
    }
    case "no-answer": {
      return "call.no_answer";
    }
    case "canceled": {
      return "call.cancelled";
    }
    case "failed": {
      return "call.failed";
    }
    default: {
      return null;
    }
  }
}

export function sarvamWebhookEvent(
  status: string,
): OutboundCallEventType | null {
  switch (status.trim().toLocaleLowerCase("en")) {
    case "connected":
      return "call.completed";
    case "no_answer":
      return "call.no_answer";
    case "busy":
      return "call.busy";
    case "failed":
      return "call.failed";
    default:
      return null;
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    // These are raw bytes for btoa, not Unicode scalar values.
    // oxlint-disable-next-line unicorn/prefer-code-point
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    // These inputs are ASCII Base64 signatures, so comparing UTF-16 code units is deliberate.
    // oxlint-disable-next-line unicorn/prefer-code-point
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyTwilioSignature(args: {
  authToken: string;
  requestUrl: string;
  form: URLSearchParams;
  signature: string;
}) {
  const keys = [...new Set(args.form.keys())].toSorted();
  let signed = args.requestUrl;
  for (const key of keys) {
    for (const value of args.form.getAll(key).toSorted()) {
      signed += `${key}${value}`;
    }
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(args.authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const expected = bytesToBase64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        new TextEncoder().encode(signed),
      ),
    ),
  );
  return constantTimeEqual(expected, args.signature);
}
