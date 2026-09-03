import type { OutboundCallEventType } from "@code2create/domain";

import { twilioCreateResponseSchema, twilioErrorResponseSchema } from "./contracts.js";

export type TelephonyEnvironment = {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
  PUBLIC_BASE_URL: string;
  SARVAM_API_KEY?: string;
};

export type QueuedCall = {
  providerCallId: string;
  providerStatus: string;
};

export class AmbiguousCallDispatchError extends Error {
  constructor() {
    super("The telephony provider response was ambiguous.");
    this.name = "AmbiguousCallDispatchError";
  }
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

export function voiceRouteUrl(
  environment: Pick<TelephonyEnvironment, "PUBLIC_BASE_URL">,
  route: "voice" | "status" | "fallback",
  deliveryId: string,
  token: string,
) {
  return `${requiredHttpsBaseUrl(environment.PUBLIC_BASE_URL)}/twilio/${route}/${encodeURIComponent(deliveryId)}/${encodeURIComponent(token)}`;
}

export function audioRouteUrl(
  environment: Pick<TelephonyEnvironment, "PUBLIC_BASE_URL">,
  deliveryId: string,
  token: string,
) {
  return `${requiredHttpsBaseUrl(environment.PUBLIC_BASE_URL)}/twilio/audio/${encodeURIComponent(deliveryId)}/${encodeURIComponent(token)}.mp3`;
}

export function synthesizedVoiceTwiml(
  environment: Pick<TelephonyEnvironment, "PUBLIC_BASE_URL">,
  deliveryId: string,
  token: string,
) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${escapeXml(audioRouteUrl(environment, deliveryId, token))}</Play></Response>`;
}

export function fallbackVoiceTwiml(script: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice" language="en-IN">${escapeXml(script)}</Say></Response>`;
}

export async function synthesizeSpeech(environment: TelephonyEnvironment, script: string) {
  if (environment.SARVAM_API_KEY === undefined || environment.SARVAM_API_KEY.length === 0) {
    return null;
  }
  const response = await fetch("https://api.sarvam.ai/text-to-speech/stream", {
    method: "POST",
    headers: {
      "api-subscription-key": environment.SARVAM_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text: script,
      language_code: "en-IN",
      speaker: "shubh",
      pace: 1.05,
      speech_sample_rate: 8000,
      model: "bulbul:v3",
      temperature: 0.55,
      output_audio_codec: "mp3",
      output_audio_bitrate: "32k",
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    return null;
  }
  const audio = await response.arrayBuffer();
  if (audio.byteLength < 1000) {
    return null;
  }
  const bytes = new Uint8Array(audio, 0, Math.min(3, audio.byteLength));
  const mp3 =
    (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0);
  return mp3 ? audio : null;
}

export async function queueTwilioCall(
  environment: TelephonyEnvironment,
  args: { deliveryId: string; token: string; destinationPhoneE164: string },
): Promise<QueuedCall> {
  const endpoint =
    "https://api.twilio.com/2010-04-01/Accounts/" +
    `${encodeURIComponent(environment.TWILIO_ACCOUNT_SID)}/Calls.json`;
  const body = new URLSearchParams({
    To: args.destinationPhoneE164,
    From: environment.TWILIO_FROM_NUMBER,
    Url: voiceRouteUrl(environment, "voice", args.deliveryId, args.token),
    Method: "POST",
    FallbackUrl: voiceRouteUrl(environment, "fallback", args.deliveryId, args.token),
    FallbackMethod: "POST",
    StatusCallback: voiceRouteUrl(environment, "status", args.deliveryId, args.token),
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
        authorization: `Basic ${btoa(`${environment.TWILIO_ACCOUNT_SID}:${environment.TWILIO_AUTH_TOKEN}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AmbiguousCallDispatchError();
  }
  const text = await response.text();
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    if (response.ok) {
      throw new AmbiguousCallDispatchError();
    }
    throw new Error(`Twilio rejected the call with HTTP ${response.status}.`);
  }
  if (!response.ok) {
    const error = twilioErrorResponseSchema.safeParse(decoded);
    const detail =
      error.success && error.data.message !== undefined
        ? error.data.message
        : `HTTP ${response.status}`;
    throw new Error(`Twilio rejected the call: ${detail}`);
  }
  const accepted = twilioCreateResponseSchema.safeParse(decoded);
  if (!accepted.success) {
    throw new AmbiguousCallDispatchError();
  }
  return {
    providerCallId: accepted.data.sid,
    providerStatus: accepted.data.status ?? "queued",
  };
}

export function twilioStatusEvent(status: string): OutboundCallEventType | null {
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

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    // These are raw bytes for btoa, not Unicode scalar values.
    // oxlint-disable-next-line unicorn/prefer-code-point
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
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
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(args.authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const expected = bytesToBase64(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed))),
  );
  if (expected.length !== args.signature.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    // Twilio signatures are ASCII Base64; comparing UTF-16 code units is deliberate.
    // oxlint-disable-next-line unicorn/prefer-code-point
    difference |= expected.charCodeAt(index) ^ args.signature.charCodeAt(index);
  }
  return difference === 0;
}
