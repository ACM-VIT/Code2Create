import {
  outboundCallEventSignatureContext,
  outboundCallRequestSignatureContext,
  outboundCallProtocolVersion,
  signServiceBody,
  verifyServiceBody,
  type OutboundCallEvent,
  type OutboundCallEventType,
  type OutboundCallRequest,
} from "@code2create/domain";

import { outboundCallRequestSchema } from "./contracts.js";
import {
  AmbiguousCallDispatchError,
  fallbackVoiceTwiml,
  queueTwilioCall,
  synthesizedVoiceTwiml,
  synthesizeSpeech,
  twilioStatusEvent,
  verifyTwilioSignature,
  type QueuedCall,
  type TelephonyEnvironment,
} from "./telephony.js";

export interface VoiceEnvironment extends TelephonyEnvironment {
  OUTBOUND_CALLS: DurableObjectNamespace;
  OUTBOUND_CALL_REQUEST_SECRET: string;
  OUTBOUND_CALL_EVENT_SECRET: string;
}

type SessionPhase = "accepted" | "dispatching" | "queued" | "terminal";

type CallSession = {
  request: OutboundCallRequest;
  token: string;
  phase: SessionPhase;
  speech: "pending" | "synthesized" | "fallback";
  providerCallId: string | undefined;
  dispatchDeadlineAt: number | undefined;
  pendingEvents: OutboundCallEvent[];
  reportedEventTypes: OutboundCallEventType[];
  createdAt: number;
  updatedAt: number;
};

const sessionStorageKey = "call-session";
const audioStorageKey = "call-audio";
const maximumRequestBytes = 16 * 1_024;
const signatureMaximumAgeMs = 5 * 60 * 1_000;
const callbackRetryMs = 30 * 1_000;
const providerDispatchResolutionMs = 60 * 1_000;

function noStoreJson(value: object, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function boundedBody(request: Request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumRequestBytes) return null;
  const body = await request.text();
  return new TextEncoder().encode(body).byteLength <= maximumRequestBytes ? body : null;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function sameRequest(left: OutboundCallRequest, right: OutboundCallRequest) {
  return left.protocolVersion === right.protocolVersion &&
    left.deliveryId === right.deliveryId &&
    left.destinationPhoneE164 === right.destinationPhoneE164 &&
    left.script === right.script &&
    left.callbackUrl === right.callbackUrl;
}

function eventFor(
  session: CallSession,
  eventType: OutboundCallEventType,
  options: { providerCallId?: string; providerErrorCode?: string } = {},
): OutboundCallEvent {
  return {
    protocolVersion: outboundCallProtocolVersion,
    eventId: crypto.randomUUID(),
    deliveryId: session.request.deliveryId,
    eventType,
    providerAt: Date.now(),
    ...(options.providerCallId !== undefined
      ? { providerCallId: options.providerCallId }
      : {}),
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
  return eventType === "call.completed" ||
    eventType === "call.busy" ||
    eventType === "call.no_answer" ||
    eventType === "call.cancelled" ||
    eventType === "call.failed";
}

export class OutboundCallSession {
  constructor(
    private readonly state: DurableObjectState,
    private readonly environment: VoiceEnvironment,
  ) {}

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/create") {
      return this.create(request);
    }
    if (request.method === "POST" && url.pathname === "/status") {
      return this.status(request);
    }
    if (request.method === "POST" && url.pathname === "/voice") {
      return this.voice(request, false);
    }
    if (request.method === "POST" && url.pathname === "/fallback") {
      return this.voice(request, true);
    }
    if (request.method === "GET" && url.pathname === "/audio") {
      return this.audio(request);
    }
    return new Response("Not found.", { status: 404 });
  }

  async alarm() {
    if (!(await this.flushPendingEvents())) return;
    let session = await this.state.storage.get<CallSession>(sessionStorageKey);
    if (!session) return;
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
        phase: "terminal",
        dispatchDeadlineAt: undefined,
        pendingEvents: [
          ...session.pendingEvents,
          eventFor(session, "call.failed", {
            providerErrorCode: "provider_dispatch_ambiguous",
          }),
        ],
        updatedAt: Date.now(),
      };
      await this.state.storage.put(sessionStorageKey, session);
      await this.state.storage.setAlarm(Date.now());
      return;
    }
    if (session.phase !== "accepted") return;

    const audio = await synthesizeSpeech(this.environment, session.request.script);
    const current = await this.state.storage.get<CallSession>(sessionStorageKey);
    if (!current || current.phase !== "accepted") return;
    if (audio) await this.state.storage.put(audioStorageKey, audio);
    const dispatchDeadlineAt = Date.now() + providerDispatchResolutionMs;
    session = {
      ...current,
      speech: audio ? "synthesized" : "fallback",
      phase: "dispatching",
      dispatchDeadlineAt,
      updatedAt: Date.now(),
    };
    await this.state.storage.put(sessionStorageKey, session);
    await this.state.storage.setAlarm(dispatchDeadlineAt);

    let dispatchResult:
      | { ok: true; queued: QueuedCall }
      | { ok: false; error: unknown };
    try {
      dispatchResult = {
        ok: true,
        queued: await queueTwilioCall(this.environment, {
          deliveryId: session.request.deliveryId,
          token: session.token,
          destinationPhoneE164: session.request.destinationPhoneE164,
        }),
      };
    } catch (error) {
      dispatchResult = { ok: false, error };
    }
    if (!dispatchResult.ok) {
      const latest = await this.state.storage.get<CallSession>(sessionStorageKey);
      if (!latest) return;
      if (latest.phase !== "dispatching") {
        await this.state.storage.setAlarm(Date.now());
        return;
      }
      if (dispatchResult.error instanceof AmbiguousCallDispatchError) {
        await this.state.storage.setAlarm(dispatchDeadlineAt);
        return;
      }
      session = {
        ...latest,
        phase: "terminal",
        dispatchDeadlineAt: undefined,
        pendingEvents: [
          ...latest.pendingEvents,
          eventFor(latest, "call.failed", {
            providerErrorCode: "provider_rejected",
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
    if (!latest) return;
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
      if (!session || !event) return true;
      if (!(await relayEvent(this.environment, session.request, event))) {
        await this.state.storage.setAlarm(Date.now() + callbackRetryMs);
        return false;
      }
      const latest = await this.state.storage.get<CallSession>(sessionStorageKey);
      if (!latest) return true;
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
    if (body === null) return noStoreJson({ error: "request_too_large" }, 413);
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      return noStoreJson({ error: "invalid_json" }, 422);
    }
    const parsed = outboundCallRequestSchema.safeParse(decoded);
    if (!parsed.success) return noStoreJson({ error: "invalid_request" }, 422);
    const existing = await this.state.storage.get<CallSession>(sessionStorageKey);
    if (existing) {
      if (!sameRequest(existing.request, parsed.data)) {
        return noStoreJson({ error: "delivery_conflict" }, 409);
      }
      return noStoreJson({ accepted: true, deliveryId: existing.request.deliveryId }, 202);
    }
    const now = Date.now();
    const session: CallSession = {
      request: parsed.data,
      token: randomToken(),
      phase: "accepted",
      speech: "pending",
      providerCallId: undefined,
      dispatchDeadlineAt: undefined,
      pendingEvents: [],
      reportedEventTypes: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.state.storage.put(sessionStorageKey, session);
    await this.state.storage.setAlarm(now);
    return noStoreJson({ accepted: true, deliveryId: session.request.deliveryId }, 202);
  }

  private async voice(request: Request, forceFallback: boolean) {
    const session = await this.authorizedSession(request);
    if (!session) return new Response("Not found.", { status: 404 });
    const twiml = !forceFallback && session.speech === "synthesized"
      ? synthesizedVoiceTwiml(
          this.environment,
          session.request.deliveryId,
          session.token,
        )
      : fallbackVoiceTwiml(session.request.script);
    return new Response(twiml, {
      headers: {
        "content-type": "text/xml; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private async audio(request: Request) {
    const session = await this.authorizedSession(request);
    if (!session || session.speech !== "synthesized") {
      return new Response("Not found.", { status: 404 });
    }
    const audio = await this.state.storage.get<ArrayBuffer>(audioStorageKey);
    if (!audio) return new Response("Not found.", { status: 404 });
    return new Response(audio, {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "private, max-age=300",
      },
    });
  }

  private async status(request: Request) {
    const session = await this.authorizedSession(request);
    if (!session) return new Response("Not found.", { status: 404 });
    const body = await boundedBody(request);
    if (body === null) return new Response("Request too large.", { status: 413 });
    const form = new URLSearchParams(body);
    const originalUrl = request.headers.get("x-c2c-original-url") ?? "";
    const signature = request.headers.get("x-twilio-signature") ?? "";
    if (
      !originalUrl ||
      !(await verifyTwilioSignature({
        authToken: this.environment.TWILIO_AUTH_TOKEN,
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
      !providerCallId ||
      providerCallId.length > 128 ||
      !eventType ||
      (session.providerCallId !== undefined && session.providerCallId !== providerCallId)
    ) {
      return new Response("Invalid status.", { status: 422 });
    }
    const current = await this.authorizedSession(request);
    if (!current) return new Response("Not found.", { status: 404 });
    if (
      current.reportedEventTypes.includes(eventType) ||
      current.phase === "terminal"
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      current.providerCallId !== undefined &&
      current.providerCallId !== providerCallId
    ) {
      return new Response("Invalid status.", { status: 422 });
    }
    const updated: CallSession = {
      ...current,
      phase: terminalEvent(eventType) ? "terminal" : "queued",
      providerCallId,
      dispatchDeadlineAt: undefined,
      pendingEvents: [
        ...current.pendingEvents,
        eventFor(current, eventType, { providerCallId }),
      ],
      reportedEventTypes: [...current.reportedEventTypes, eventType],
      updatedAt: Date.now(),
    };
    await this.state.storage.put(sessionStorageKey, updated);
    await this.state.storage.setAlarm(Date.now());
    return new Response(null, { status: 204 });
  }

  private async authorizedSession(request: Request) {
    const session = await this.state.storage.get<CallSession>(sessionStorageKey);
    return session && request.headers.get("x-c2c-call-token") === session.token
      ? session
      : null;
  }
}

function decodedPathPart(value: string | undefined) {
  if (!value) return null;
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
    route: "create" | "voice" | "fallback" | "audio" | "status";
    request: Request;
    body?: string;
  },
) {
  const id = environment.OUTBOUND_CALLS.idFromName(args.deliveryId);
  const stub = environment.OUTBOUND_CALLS.get(id);
  const headers = new Headers();
  if (args.token !== undefined) headers.set("x-c2c-call-token", args.token);
  if (args.route === "status") {
    headers.set("x-c2c-original-url", args.request.url);
    const signature = args.request.headers.get("x-twilio-signature");
    if (signature) headers.set("x-twilio-signature", signature);
  }
  if (args.body !== undefined) headers.set("content-type", "application/json");
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
      return noStoreJson({
        service: "code2create-voice",
        ok: true,
        telephonyConfigured: Boolean(
          environment.TWILIO_ACCOUNT_SID &&
          environment.TWILIO_AUTH_TOKEN &&
          environment.TWILIO_FROM_NUMBER &&
          environment.PUBLIC_BASE_URL,
        ),
        speechProvider: environment.SARVAM_API_KEY ? "sarvam-bulbul-v3" : "twilio-say",
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/calls") {
      const body = await boundedBody(request);
      if (body === null) return noStoreJson({ error: "request_too_large" }, 413);
      const verified = await verifyServiceBody({
        context: outboundCallRequestSignatureContext,
        secret: environment.OUTBOUND_CALL_REQUEST_SECRET,
        timestamp: request.headers.get("x-c2c-timestamp") ?? "",
        signature: request.headers.get("x-c2c-signature") ?? "",
        body,
        now: Date.now(),
        maximumAgeMs: signatureMaximumAgeMs,
      });
      if (!verified) return noStoreJson({ error: "unauthorized" }, 401);
      let decoded: unknown;
      try {
        decoded = JSON.parse(body);
      } catch {
        return noStoreJson({ error: "invalid_json" }, 422);
      }
      const parsed = outboundCallRequestSchema.safeParse(decoded);
      if (!parsed.success) return noStoreJson({ error: "invalid_request" }, 422);
      return callStub(environment, {
        deliveryId: parsed.data.deliveryId,
        route: "create",
        request,
        body,
      });
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "twilio") return new Response("Not found.", { status: 404 });
    const route = parts[1];
    const deliveryId = decodedPathPart(parts[2]);
    const rawToken = route === "audio" ? parts[3]?.replace(/\.mp3$/u, "") : parts[3];
    const token = decodedPathPart(rawToken);
    if (
      !deliveryId ||
      !token ||
      !["voice", "fallback", "audio", "status"].includes(route ?? "")
    ) {
      return new Response("Not found.", { status: 404 });
    }
    const body = request.method === "POST" ? await boundedBody(request) : undefined;
    if (body === null) return new Response("Request too large.", { status: 413 });
    const internalRoute = route === "voice" || route === "fallback" || route === "audio" || route === "status"
      ? route
      : null;
    if (!internalRoute) return new Response("Not found.", { status: 404 });
    return callStub(environment, {
      deliveryId,
      token,
      route: internalRoute,
      request,
      ...(body !== undefined ? { body } : {}),
    });
  },
} satisfies ExportedHandler<VoiceEnvironment>;
