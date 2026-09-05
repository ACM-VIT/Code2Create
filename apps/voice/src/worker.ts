import {
  outboundCallEventSignatureContext,
  outboundCallRequestSignatureContext,
  outboundCallProtocolVersion,
  signServiceBody,
  verifyServiceBody,
} from "@code2create/domain";
import type {
  OutboundCallEvent,
  OutboundCallEventType,
  OutboundCallRequest,
  VenueCallResponse,
} from "@code2create/domain";

import { venueCallResponse } from "./venue-confirmation.js";

import {
  outboundCallRequestSchema,
  sarvamOutboundWebhookSchema,
} from "./contracts.js";
import {
  AmbiguousCallDispatchError,
  outboundCallProviderOrder,
  RejectedCallDispatchError,
  TelephonyConfigurationError,
  queueOutboundCall,
  sarvamConfigured,
  sarvamWebhookUrl,
  sarvamWebhookEvent,
  twilioConfigured,
  twilioStatusEvent,
  twilioVoiceXml,
  verifyTwilioSignature,
} from "./telephony.js";
import type {
  QueuedCall,
  TelephonyEnvironment,
  TelephonyProvider,
} from "./telephony.js";

export interface VoiceEnvironment extends TelephonyEnvironment {
  OUTBOUND_CALLS: DurableObjectNamespace;
  OUTBOUND_CALL_REQUEST_SECRET: string;
  OUTBOUND_CALL_EVENT_SECRET: string;
}

type SessionPhase =
  "accepted"
  | "dispatching"
  | "queued"
  | "ambiguous"
  | "terminal";

type CallSession = {
  request: OutboundCallRequest;
  token: string;
  phase: SessionPhase;
  provider: TelephonyProvider | undefined;
  providerCallId: string | undefined;
  dispatchDeadlineAt: number | undefined;
  pendingEvents: OutboundCallEvent[];
  reportedEventTypes: OutboundCallEventType[];
  createdAt: number;
  updatedAt: number;
};

const sessionStorageKey = "call-session";
const maximumRequestBytes = 16 * 1024;
const maximumSarvamWebhookBytes = 256 * 1024;
const signatureMaximumAgeMs = 5 * 60 * 1000;
const callbackRetryMs = 30 * 1000;
const providerDispatchResolutionMs = 60 * 1000;

type NoStoreJsonBody = Record<string, boolean | number | string>;

function noStoreJson(value: NoStoreJsonBody, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function boundedBody(
  request: Request,
  maximumBytes = maximumRequestBytes,
) {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumBytes) {
    return null;
  }
  const body = await request.text();
  return new TextEncoder().encode(body).byteLength <= maximumBytes ? body : null;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    // These are raw bytes for btoa, not Unicode scalar values.
    // oxlint-disable-next-line unicorn/prefer-code-point
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function sameRequest(left: OutboundCallRequest, right: OutboundCallRequest) {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.deliveryId === right.deliveryId &&
    left.destinationPhoneE164 === right.destinationPhoneE164 &&
    left.script === right.script &&
    left.callbackUrl === right.callbackUrl &&
    JSON.stringify(left.venueConfirmation) ===
      JSON.stringify(right.venueConfirmation)
  );
}

function eventFor(
  session: CallSession,
  eventType: OutboundCallEventType,
  options: { providerCallId?: string; providerErrorCode?: string;
    venueResponse?: VenueCallResponse;
  } = {},
): OutboundCallEvent {
  return {
    protocolVersion: outboundCallProtocolVersion,
    eventId: crypto.randomUUID(),
    deliveryId: session.request.deliveryId,
    eventType,
    providerAt: Date.now(),
    ...(options.venueResponse ? { venueResponse: options.venueResponse } : {}),
    ...(options.providerCallId !== undefined ? { providerCallId: options.providerCallId } : {}),
    ...(options.providerErrorCode !== undefined
      ? { providerErrorCode: options.providerErrorCode }
      : {}),
  };
}

async function relayEvent(
  environment: VoiceEnvironment,
  request: OutboundCallRequest,
  event: OutboundCallEvent,
) {
  const body = JSON.stringify(event);
  const timestamp = String(Date.now());
  const signature = await signServiceBody({
    context: outboundCallEventSignatureContext,
    secret: environment.OUTBOUND_CALL_EVENT_SECRET,
    timestamp,
    body,
  });
  try {
    const response = await fetch(request.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-signature": signature,
        "x-c2c-timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function terminalEvent(eventType: OutboundCallEventType) {
  return (
    eventType === "call.completed" ||
    eventType === "call.busy" ||
    eventType === "call.no_answer" ||
    eventType === "call.cancelled" ||
    eventType === "call.failed"
  );
}

function samePhoneNumber(left: string, right: string) {
  return left.replaceAll(/\D/gu, "") === right.replaceAll(/\D/gu, "");
}

export class OutboundCallSession {
  private readonly state: DurableObjectState;
  private readonly environment: VoiceEnvironment;

  constructor(state: DurableObjectState, environment: VoiceEnvironment) {
    this.state = state;
    this.environment = environment;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/create") {
      return this.create(request);
    }
    if (request.method === "POST" && url.pathname === "/status") {
      return this.twilioStatus(request);
    }
    if (request.method === "POST" && url.pathname === "/voice") {
      return this.voice(request);
    }
    if (request.method === "POST" && url.pathname === "/fallback") {
      return this.voice(request);
    }
    if (request.method === "POST" && url.pathname === "/sarvam-status") {
      return this.sarvamStatus(request);
    }
    return new Response("Not found.", { status: 404 });
  }

  async alarm() {
    if (!(await this.flushPendingEvents())) {
      return;
    }
    let session = await this.state.storage.get<CallSession>(sessionStorageKey);
    if (session === undefined) {
      return;
    }
    if (session.phase === "dispatching") {
      const dispatchDeadlineAt = session.dispatchDeadlineAt;
      if (dispatchDeadlineAt === undefined) {
        throw new Error("A dispatching call has no resolution deadline.");
      }
      if (Date.now() < dispatchDeadlineAt) {
        await this.state.storage.setAlarm(dispatchDeadlineAt);
        return;
      }
      session = {
        ...session,
        phase: "ambiguous",
        dispatchDeadlineAt: undefined,
        pendingEvents: [
          ...session.pendingEvents,
          eventFor(session, "call.failed", {
            providerErrorCode: "provider_dispatch_ambiguous",
          }),
        ],
        reportedEventTypes: [...session.reportedEventTypes, "call.failed"],
        updatedAt: Date.now(),
      };
      await this.state.storage.put(sessionStorageKey, session);
      await this.state.storage.setAlarm(Date.now());
      return;
    }
    if (session.phase !== "accepted") {
      return;
    }

    const current = await this.state.storage.get<CallSession>(sessionStorageKey);
    if (current === undefined || current.phase !== "accepted") {
      return;
    }
    const dispatchDeadlineAt = Date.now() + providerDispatchResolutionMs;
    session = {
      ...current,
      phase: "dispatching",
      dispatchDeadlineAt,
      updatedAt: Date.now(),
    };
    await this.state.storage.put(sessionStorageKey, session);
    await this.state.storage.setAlarm(dispatchDeadlineAt);

    let dispatchResult: { ok: true; queued: QueuedCall } | { ok: false; error: unknown };
    try {
      dispatchResult = {
        ok: true,
        queued: await queueOutboundCall(this.environment, {
          deliveryId: session.request.deliveryId,
          token: session.token,
          destinationPhoneE164: session.request.destinationPhoneE164,
          script: session.request.script,
          venueConfirmation: session.request.venueConfirmation,
        }),
      };
    } catch (error) {
      dispatchResult = { ok: false, error };
    }
    if (!dispatchResult.ok) {
      const latest = await this.state.storage.get<CallSession>(sessionStorageKey);
      if (latest === undefined) {
        return;
      }
      if (latest.phase !== "dispatching") {
        await this.state.storage.setAlarm(Date.now());
        return;
      }
      if (dispatchResult.error instanceof AmbiguousCallDispatchError) {
        await this.state.storage.setAlarm(dispatchDeadlineAt);
        return;
      }
      const providerErrorCode = dispatchResult.error instanceof RejectedCallDispatchError
        ? `${dispatchResult.error.provider}_rejected`
        : dispatchResult.error instanceof TelephonyConfigurationError
          ? "telephony_not_configured"
          : "provider_rejected";
      session = {
        ...latest,
        phase: "terminal",
        dispatchDeadlineAt: undefined,
        pendingEvents: [
          ...latest.pendingEvents,
          eventFor(latest, "call.failed", {
            providerErrorCode,
          }),
        ],
        reportedEventTypes: [...latest.reportedEventTypes, "call.failed"],
        updatedAt: Date.now(),
      };
      await this.state.storage.put(sessionStorageKey, session);
      await this.state.storage.setAlarm(Date.now());
      return;
    }
    const queued = dispatchResult.queued;
    const latest = await this.state.storage.get<CallSession>(sessionStorageKey);
    if (latest === undefined) {
      return;
    }
    if (
      latest.provider !== undefined &&
      latest.provider !== queued.provider
    ) {
      throw new Error("The telephony provider changed during dispatch.");
    }
    if (
      latest.providerCallId !== undefined &&
      latest.providerCallId !== queued.providerCallId
    ) {
      throw new Error("The telephony provider returned conflicting call IDs.");
    }
    const queuedReported = latest.reportedEventTypes.includes("call.queued");
    session = {
      ...latest,
      phase: latest.phase === "terminal" ? "terminal" : "queued",
      provider: queued.provider,
      providerCallId: queued.providerCallId,
      dispatchDeadlineAt: undefined,
      pendingEvents: queuedReported
        ? latest.pendingEvents
        : [
            eventFor(latest, "call.queued", {
              providerCallId: queued.providerCallId,
            }),
            ...latest.pendingEvents,
          ],
      reportedEventTypes: queuedReported
        ? latest.reportedEventTypes
        : [...latest.reportedEventTypes, "call.queued"],
      updatedAt: Date.now(),
    };
    await this.state.storage.put(sessionStorageKey, session);
    await this.state.storage.setAlarm(Date.now());
  }

  private async flushPendingEvents() {
    while (true) {
      const session = await this.state.storage.get<CallSession>(sessionStorageKey);
      const event = session?.pendingEvents[0];
      if (session === undefined || event === undefined) {
        return true;
      }
      if (!(await relayEvent(this.environment, session.request, event))) {
        await this.state.storage.setAlarm(Date.now() + callbackRetryMs);
        return false;
      }
      const latest = await this.state.storage.get<CallSession>(sessionStorageKey);
      if (latest === undefined) {
        return true;
      }
      await this.state.storage.put(sessionStorageKey, {
        ...latest,
        pendingEvents: latest.pendingEvents.filter(
          (candidate) => candidate.eventId !== event.eventId,
        ),
        updatedAt: Date.now(),
      });
    }
  }

  private async create(request: Request) {
    const body = await boundedBody(request);
    if (body === null) {
      return noStoreJson({ error: "request_too_large" }, 413);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      return noStoreJson({ error: "invalid_json" }, 422);
    }
    const parsed = outboundCallRequestSchema.safeParse(decoded);
    if (!parsed.success) {
      return noStoreJson({ error: "invalid_request" }, 422);
    }
    const existing = await this.state.storage.get<CallSession>(sessionStorageKey);
    if (existing !== undefined) {
      if (!sameRequest(existing.request, parsed.data)) {
        return noStoreJson({ error: "delivery_conflict" }, 409);
      }
      return noStoreJson({ accepted: true, deliveryId: existing.request.deliveryId }, 202,
      );
    }
    const now = Date.now();
    const session: CallSession = {
      request: parsed.data,
      token: randomToken(),
      phase: "accepted",
      provider: undefined,
      providerCallId: undefined,
      dispatchDeadlineAt: undefined,
      pendingEvents: [],
      reportedEventTypes: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.state.storage.put(sessionStorageKey, session);
    await this.state.storage.setAlarm(now);
    return noStoreJson({ accepted: true, deliveryId: session.request.deliveryId }, 202,
    );
  }

  private async voice(request: Request) {
    const session = await this.authorizedSession(request);
    if (session === null) {
      return new Response("Not found.", { status: 404 });
    }
    if (session.request.venueConfirmation)
      return new Response("Conversation requires the configured agent.", {
        status: 409,
      });
    return new Response(twilioVoiceXml(session.request.script), {
      headers: {
        "content-type": "text/xml; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private async twilioStatus(request: Request) {
    const session = await this.authorizedSession(request);
    if (session === null) {
      return new Response("Not found.", { status: 404 });
    }
    const body = await boundedBody(request);
    if (body === null) {
      return new Response("Request too large.", { status: 413 });
    }
    const form = new URLSearchParams(body);
    const originalUrl = request.headers.get("x-c2c-original-url") ?? "";
    const signature = request.headers.get("x-twilio-signature") ?? "";
    const authToken = this.environment.TWILIO_AUTH_TOKEN?.trim();
    if (
      authToken === undefined ||
      authToken.length === 0 ||
      originalUrl.length === 0 ||
      !(await verifyTwilioSignature({
        authToken,
        requestUrl: originalUrl,
        form,
        signature,
      }))
    ) {
      return new Response("Unauthorized.", { status: 401 });
    }
    const providerCallId = form.get("CallSid")?.trim() ?? "";
    const eventType = twilioStatusEvent(form.get("CallStatus") ?? "");
    if (
      session.request.venueConfirmation !== undefined ||
      providerCallId.length === 0 ||
      providerCallId.length > 128 ||
      eventType === null ||
      (session.provider !== undefined && session.provider !== "twilio") ||
      (session.providerCallId !== undefined && session.providerCallId !== providerCallId)
    ) {
      return new Response("Invalid status.", { status: 422 });
    }
    return this.recordProviderEvent(
      request,
      "twilio",
      providerCallId,
      eventType,
      204,
    );
  }

  private async sarvamStatus(request: Request) {
    const session = await this.authorizedSession(request);
    if (!session) return new Response("Not found.", { status: 404 });
    const body = await boundedBody(request, maximumSarvamWebhookBytes);
    if (body === null) return new Response("Request too large.", { status: 413 });
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON.", { status: 422 });
    }
    const parsed = sarvamOutboundWebhookSchema.safeParse(decoded);
    if (!parsed.success) {
      return new Response("Invalid callback.", { status: 422 });
    }
    const providerCallId = parsed.data.attempt_id;
    const eventType = sarvamWebhookEvent(parsed.data.status);
    const agentPhoneNumber = this.environment.SARVAM_AGENT_PHONE_NUMBER;
    const webhookConfig = parsed.data.webhook_config;
    const expectedWebhookUrl = sarvamWebhookUrl(
      this.environment,
      session.request.deliveryId,
      session.token,
    );
    if (
      !eventType ||
      !agentPhoneNumber ||
      parsed.data.channel_info.channel_provider.trim().toLocaleLowerCase("en") !==
        "vobiz" ||
      !samePhoneNumber(
        parsed.data.channel_info.agent_phone_number,
        agentPhoneNumber,
      ) ||
      (webhookConfig !== null &&
        webhookConfig !== undefined &&
        (webhookConfig.url !== expectedWebhookUrl ||
          webhookConfig.metadata?.delivery_id !== session.request.deliveryId)) ||
      (session.provider !== undefined && session.provider !== "sarvam") ||
      (session.providerCallId !== undefined && session.providerCallId !== providerCallId)
    ) {
      return new Response("Invalid callback.", { status: 422 });
    }
    return this.recordProviderEvent(
      request,
      "sarvam",
      providerCallId,
      eventType,
      204,
      parsed.data.status === "failed" ? "sarvam_failed" : undefined,
      session.request.venueConfirmation && parsed.data.status === "connected"
        ? venueCallResponse(
            parsed.data.final_agent_variables,
            parsed.data.interaction_transcript,
          )
        : undefined,
    );
  }

  private async recordProviderEvent(
    request: Request,
    provider: TelephonyProvider,
    providerCallId: string,
    eventType: OutboundCallEventType,
    successStatus: 200 | 204,
    providerErrorCode?: string,
    venueResponse?: VenueCallResponse,
  ) {
    const current = await this.authorizedSession(request);
    if (!current) return new Response("Not found.", { status: 404 });
    if (
      (current.provider !== undefined && current.provider !== provider) ||
      (current.providerCallId !== undefined &&
      current.providerCallId !== providerCallId)
    ) {
      return new Response("Invalid status.", { status: 422 });
    }
    // Convex treats ambiguity as completed; only a definitive provider outcome
    // may resolve it without reopening the delivery as active.
    if (current.phase === "ambiguous" && !terminalEvent(eventType)) {
      return new Response(null, { status: successStatus });
    }
    if (
      (current.reportedEventTypes.includes(eventType) &&
        current.phase !== "ambiguous") ||
      current.phase === "terminal"
    ) {
      return new Response(null, { status: successStatus });
    }
    const updated: CallSession = {
      ...current,
      phase: terminalEvent(eventType) ? "terminal" : "queued",
      provider,
      providerCallId,
      dispatchDeadlineAt: undefined,
      pendingEvents: [
        ...current.pendingEvents,
        eventFor(current, eventType, {
          providerCallId,
          ...(providerErrorCode === undefined ? {} : { providerErrorCode }),
          ...(venueResponse === undefined ? {} : { venueResponse }),
        }),
      ],
      reportedEventTypes: [...current.reportedEventTypes, eventType],
      updatedAt: Date.now(),
    };
    await this.state.storage.put(sessionStorageKey, updated);
    await this.state.storage.setAlarm(Date.now());
    return new Response(null, { status: successStatus });
  }

  private async authorizedSession(request: Request) {
    const session = await this.state.storage.get<CallSession>(sessionStorageKey);
    return session !== undefined && request.headers.get("x-c2c-call-token") === session.token
      ? session
      : null;
  }
}

function decodedPathPart(value: string | undefined) {
  if (value === undefined || value.length === 0) {
    return null;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function callStub(
  environment: VoiceEnvironment,
  args: {
    deliveryId: string;
    token?: string;
    route: "create"
      | "voice"
      | "fallback"
      | "status"
      | "sarvam-status";
    request: Request;
    body?: string;
  },
) {
  const id = environment.OUTBOUND_CALLS.idFromName(args.deliveryId);
  const stub = environment.OUTBOUND_CALLS.get(id);
  const headers = new Headers();
  if (args.token !== undefined) {
    headers.set("x-c2c-call-token", args.token);
  }
  if (args.route === "status") {
    headers.set("x-c2c-original-url", args.request.url);
    const signature = args.request.headers.get("x-twilio-signature");
    if (signature !== null && signature.length > 0) {
      headers.set("x-twilio-signature", signature);
    }
  }
  if (args.body !== undefined) {
    headers.set(
      "content-type",
      args.request.headers.get("content-type") ?? "application/octet-stream",
    );
  }
  return stub.fetch(`https://voice.internal/${args.route}`, {
    method: args.request.method,
    headers,
    ...(args.body !== undefined ? { body: args.body } : {}),
  });
}

export default {
  async fetch(request, environment) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      let primaryProvider: TelephonyProvider;
      let fallbackProvider: TelephonyProvider;
      try {
        [primaryProvider, fallbackProvider] = outboundCallProviderOrder(environment);
      } catch (error) {
        if (!(error instanceof TelephonyConfigurationError)) throw error;
        return noStoreJson({
          service: "code2create-voice",
          ok: false,
          telephonyConfigured: false,
          configurationError: error.message,
        }, 503,
        );
      }
      const twilioIsConfigured = twilioConfigured(environment);
      const sarvamIsConfigured = sarvamConfigured(environment);
      return noStoreJson({
        service: "code2create-voice",
        ok: true,
        telephonyConfigured:
          twilioIsConfigured || sarvamIsConfigured,
        primaryProvider,
        fallbackProvider,
        twilioConfigured: twilioIsConfigured,
        sarvamConfigured: sarvamIsConfigured,
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/calls") {
      const body = await boundedBody(request);
      if (body === null) {
        return noStoreJson({ error: "request_too_large" }, 413);
      }
      const verified = await verifyServiceBody({
        context: outboundCallRequestSignatureContext,
        secret: environment.OUTBOUND_CALL_REQUEST_SECRET,
        timestamp: request.headers.get("x-c2c-timestamp") ?? "",
        signature: request.headers.get("x-c2c-signature") ?? "",
        body,
        now: Date.now(),
        maximumAgeMs: signatureMaximumAgeMs,
      });
      if (!verified) {
        return noStoreJson({ error: "unauthorized" }, 401);
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(body);
      } catch {
        return noStoreJson({ error: "invalid_json" }, 422);
      }
      const parsed = outboundCallRequestSchema.safeParse(decoded);
      if (!parsed.success) {
        return noStoreJson({ error: "invalid_request" }, 422);
      }
      return callStub(environment, {
        deliveryId: parsed.data.deliveryId,
        route: "create",
        request,
        body,
      });
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const provider = parts[0];
    const route = parts[1];
    const deliveryId = decodedPathPart(parts[2]);
    const token = decodedPathPart(parts[3]);
    if (deliveryId === null || token === null) {
      return new Response("Not found.", { status: 404 });
    }
    const maximumBytes = provider === "sarvam" && route === "status"
      ? maximumSarvamWebhookBytes
      : maximumRequestBytes;
    const body = request.method === "POST"
      ? await boundedBody(request, maximumBytes)
      : undefined;
    if (body === null) {
      return new Response("Request too large.", { status: 413 });
    }

    const internalRoute = provider === "twilio" &&
        (route === "voice" || route === "fallback" || route === "status")
      ? route
      : provider === "sarvam" && route === "status"
        ? "sarvam-status"
        : null;
    if (internalRoute === null) {
      return new Response("Not found.", { status: 404 });
    }
    return callStub(environment, {
      deliveryId,
      token,
      route: internalRoute,
      request,
      ...(body !== undefined ? { body } : {}),
    });
  },
} satisfies ExportedHandler<VoiceEnvironment>;
