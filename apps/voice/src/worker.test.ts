import { afterEach, describe, expect, test, vi } from "vitest";
import type { MockInstance } from "vitest";

import type { OutboundCallRequest } from "@code2create/domain";
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
      providerCallId?: string;
      providerErrorCode?: string;
    });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("outbound call durable session", () => {
  test("reports an expired provider dispatch as ambiguous exactly once", async () => {
    const now = Date.UTC(2026, 8, 4, 10);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { session, storage } = fixture();
    storage.values.set("call-session", sessionRecord("dispatching", now));
    const callback = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await session.alarm();
    expect(storedSession(storage)).toMatchObject({
      phase: "ambiguous",
      reportedEventTypes: ["call.failed"],
      pendingEvents: [{
        eventType: "call.failed",
        providerErrorCode: "provider_dispatch_ambiguous",
      }],
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
        : Promise.resolve(new Response(null, { status: 204 }))
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
      new Response(null, { status: 204 }),
    );

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
      }],
    });
    await session.alarm();
    expect(relayedEvents(fetchMock)).toMatchObject([{
      eventType: "call.completed",
      providerCallId: "attempt-1",
    }]);
    expect(storedSession(storage).pendingEvents).toEqual([]);
  });
});
