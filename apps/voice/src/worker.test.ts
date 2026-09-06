import { afterEach, describe, expect, test, vi } from "vitest";
import type { MockInstance } from "vitest";

import type { OutboundCallRequest,
  VenueCallResponse,
} from "@code2create/domain";
import { outboundCallProtocolVersion } from "@code2create/domain";

import { OutboundCallSession } from "./worker.js";
import type { VoiceEnvironment } from "./worker.js";

type StoredValue = boolean | number | object | string | null;

class MemoryStorage {
  readonly values = new Map<string, StoredValue>();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T) {
    this.values.set(key, value as StoredValue);
  }

  async setAlarm(alarmAt: number) {
    this.alarmAt = alarmAt;
  }
}

type StoredSession = {
  phase: string;
  token: string;
  provider?: string;
  providerCallId?: string;
  pendingEvents: Array<{
    eventType: string;
    providerCallId?: string;
    providerErrorCode?: string;
  }>;
  reportedEventTypes: string[];
};

const request: OutboundCallRequest = {
  protocolVersion: outboundCallProtocolVersion,
  deliveryId: "delivery-1",
  destinationPhoneE164: "+919876543210",
  script: "Code2Create needs you now.",
  callbackUrl: "https://backend.example.com/callback",
};

const sarvamEnvironment = {
  PUBLIC_BASE_URL: "https://voice.example.com",
  OUTBOUND_CALL_REQUEST_SECRET: "request-secret-at-least-32-bytes-long",
  OUTBOUND_CALL_EVENT_SECRET: "event-secret-at-least-32-bytes-long",
  OUTBOUND_CALL_PRIMARY_PROVIDER: "sarvam",
  SARVAM_VOICE_AGENTS_API_KEY: "voice-agents-secret",
  SARVAM_ORG_ID: "org-1",
  SARVAM_WORKSPACE_ID: "workspace-1",
  SARVAM_APP_ID: "app-1",
  SARVAM_APP_VERSION: "15",
  SARVAM_CONNECTION_ID: "connection-1",
  SARVAM_AGENT_PHONE_NUMBER: "+917965854087",
  OUTBOUND_CALLS: {} as DurableObjectNamespace,
} satisfies VoiceEnvironment;

function fixture(environment: VoiceEnvironment = sarvamEnvironment) {
  const storage = new MemoryStorage();
  const state = Object.assign(Object.create(null), {
    storage,
  }) as DurableObjectState;
  return {
    storage,
    session: new OutboundCallSession(state, environment),
  };
}

function storedSession(storage: MemoryStorage) {
  const session = storage.values.get("call-session");
  if (!session || typeof session !== "object") {
    throw new Error("The call session was not stored.");
  }
  return session as StoredSession;
}

function sessionRecord(
  phase: "accepted" | "ambiguous" | "dispatching",
  now: number,
) {
  return {
    request,
    token: "callback-token",
    phase,
    provider: undefined,
    providerCallId: undefined,
    dispatchDeadlineAt: phase === "dispatching" ? now - 1 : undefined,
    pendingEvents: [],
    reportedEventTypes: phase === "ambiguous" ? ["call.failed"] : [],
    createdAt: now - 100,
    updatedAt: now - 100,
  };
}

function sarvamCallback(status: "connected" | "failed" = "connected") {
  return new Request("https://voice.internal/sarvam-status", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-c2c-call-token": "callback-token",
    },
    body: JSON.stringify({
      attempt_id: "attempt-1",
      status,
      channel_info: {
        channel_type: "v2v",
        channel_provider: "vobiz",
        agent_phone_number: "+917965854087",
      },
    }),
  });
}

function relayedEvents(fetchMock: MockInstance<typeof fetch>) {
  return fetchMock.mock.calls
    .filter(([input]) => String(input) === request.callbackUrl)
    .map(([, init]) => JSON.parse(String(init?.body)) as {
      eventType: string;
          venueResponse?: VenueCallResponse;
          providerCallId?: string;
      providerErrorCode?: string;
    },
    );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("outbound call durable session", () => {
  test("preserves the required Sarvam agent through ingress, storage and duplicate dispatch", async () => {
    const { session, storage } = fixture({
      ...sarvamEnvironment, OUTBOUND_CALL_PRIMARY_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "secret", TWILIO_FROM_NUMBER: "+12025550123",
    });
    const script = "Your 15-minute outing is over. Please return and have staff scan your ID.";
    const create = () => session.fetch(new Request("https://voice.internal/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, requiredProvider: "sarvam", script }),
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => Promise.resolve(
      String(input).startsWith("https://apps.sarvam.ai/")
        ? Response.json({ attempt_id: "attempt-1" })
        : new Response(null, { status: 204 }),
    ));
    expect((await create()).status).toBe(202);
    expect((await create()).status).toBe(202);
    await session.alarm(); await session.alarm();
    const providerCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith("https://apps.sarvam.ai/"));
    expect(providerCalls).toHaveLength(1);
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("twilio"))).toBe(true);
    const body: unknown = JSON.parse(String(providerCalls[0]![1]?.body));
    expect(body).toMatchObject({ app_config: { agent_variables: { call_message: expect.stringContaining(script) } } });
    expect(storedSession(storage)).toMatchObject({ provider: "sarvam", providerCallId: "attempt-1" });
  });

  test("reports an expired provider dispatch as ambiguous exactly once", async () => {
    const now = Date.UTC(2026, 8, 4, 10);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { session, storage } = fixture();
    storage.values.set("call-session", sessionRecord("dispatching", now));
    const callback = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }));

    await session.alarm();
    expect(storedSession(storage)).toMatchObject({
      phase: "ambiguous",
      reportedEventTypes: ["call.failed"],
      pendingEvents: [{
        eventType: "call.failed",
        providerErrorCode: "provider_dispatch_ambiguous",
      },
      ],
    });

    await session.alarm();
    await session.alarm();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(storedSession(storage).pendingEvents).toEqual([]);
  });

  test("keeps a terminal callback that arrives before provider acceptance", async () => {
    const now = Date.UTC(2026, 8, 4, 10);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { session, storage } = fixture();
    storage.values.set("call-session", sessionRecord("accepted", now));
    let acceptProvider: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      String(input).startsWith("https://apps.sarvam.ai/")
        ? new Promise<Response>((resolve) => {
            acceptProvider = resolve;
          })
        : Promise.resolve(new Response(null, { status: 204 })),
      );

    const dispatch = session.alarm();
    await vi.waitFor(() => {
      expect(storedSession(storage).phase).toBe("dispatching");
      expect(acceptProvider).toBeDefined();
    });
    await expect(session.fetch(sarvamCallback())).resolves.toMatchObject({
      status: 204,
    });
    acceptProvider?.(Response.json({ attempt_id: "attempt-1" }));
    await dispatch;

    expect(storedSession(storage)).toMatchObject({
      phase: "terminal",
      provider: "sarvam",
      providerCallId: "attempt-1",
    });
    expect(storedSession(storage).reportedEventTypes).toEqual([
      "call.completed",
      "call.queued",
    ]);
    await session.alarm();
    expect(relayedEvents(fetchMock)).toMatchObject([
      { eventType: "call.queued", providerCallId: "attempt-1" },
      { eventType: "call.completed", providerCallId: "attempt-1" },
    ]);
    expect(storedSession(storage).pendingEvents).toEqual([]);
  });

  test("lets a terminal callback resolve an ambiguous dispatch", async () => {
    const now = Date.UTC(2026, 8, 4, 10);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { session, storage } = fixture();
    storage.values.set("call-session", sessionRecord("ambiguous", now));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }));

    await expect(session.fetch(sarvamCallback())).resolves.toMatchObject({
      status: 204,
    });
    expect(storedSession(storage)).toMatchObject({
      phase: "terminal",
      provider: "sarvam",
      providerCallId: "attempt-1",
      pendingEvents: [{
        eventType: "call.completed",
        providerCallId: "attempt-1",
      },
      ],
    });
    await session.alarm();
    expect(relayedEvents(fetchMock)).toMatchObject([{
      eventType: "call.completed",
      providerCallId: "attempt-1",
    },
    ]);
    expect(storedSession(storage).pendingEvents).toEqual([]);
  });
});

test("relays a conversational answer once with its transcript and the original call identity", async () => {
  const { storage, session } = fixture();
  await storage.put("call-session", {
    ...sessionRecord("dispatching", Date.now()),
    request: {
      ...request,
      venueConfirmation: {
        appId: "confirmation-agent",
        appVersion: 4,
        reviewerName: "Reviewer",
        venueName: "Hall",
        expiresAt: Date.now() + 600000,
      },
    },
  });
  const callbackBody = {
    attempt_id: "attempt-1",
    status: "connected",
    channel_info: {
      channel_type: "v2v",
      channel_provider: "vobiz",
      agent_phone_number: "+917965854087",
    },
    final_agent_variables: {
      outcome: "away",
      confirmed: true,
      summary: "Away for 10 minutes",
      return_in_minutes: 10,
    },
    interaction_transcript: [
      {
        role: "agent",
        en_text: "You are away and unavailable for ten minutes, correct?",
      },
      { role: "user", en_text: "Yes, that is correct." },
    ],
  };
  const callback = () =>
    new Request("https://voice.internal/sarvam-status", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-call-token": "callback-token",
      },
      body: JSON.stringify(callbackBody),
    });
  expect((await session.fetch(callback())).status).toBe(204);
  expect((await session.fetch(callback())).status).toBe(204);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ accepted: true }));
  await session.alarm();
  expect(relayedEvents(fetchMock)).toHaveLength(1);
  expect(relayedEvents(fetchMock)[0]).toMatchObject({
    eventType: "call.completed",
    providerCallId: "attempt-1",
    venueResponse: {
      outcome: "away",
      confirmed: true,
      returnInMinutes: 10,
      transcript: [
        {
          role: "agent",
          text: callbackBody.interaction_transcript[0]?.en_text,
        },
        { role: "user", text: callbackBody.interaction_transcript[1]?.en_text },
      ],
    },
  });
});
