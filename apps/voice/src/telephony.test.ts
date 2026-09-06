import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AmbiguousCallDispatchError,
  RejectedCallDispatchError,
  TelephonyConfigurationError,
  outboundCallProviderOrder,
  queueOutboundCall,
  queueSarvamCall,
  queueTwilioCall,
  sarvamConfigured,
  sarvamWebhookEvent,
  sarvamWebhookUrl,
  twilioStatusEvent,
  twilioVoiceXml,
  verifyTwilioSignature,
  withOutboundCallIntroduction,
} from "./telephony.js";

const environment = { PUBLIC_BASE_URL: "https://voice.example.com/" };
const sarvamEnvironment = {
  ...environment,
  SARVAM_VOICE_AGENTS_API_KEY: "  voice-agents-secret  ",
  SARVAM_ORG_ID: "org-1",
  SARVAM_WORKSPACE_ID: "workspace-1",
  SARVAM_APP_ID: "app-1",
  SARVAM_APP_VERSION: "15",
  SARVAM_CONNECTION_ID: "connection-1",
  SARVAM_AGENT_PHONE_NUMBER: "+917965854087",
};

afterEach(() => vi.restoreAllMocks());

describe("outbound voice transport", () => {
  test.each([429, 503])("a required Sarvam agent never falls back after HTTP %s", async (status) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ detail: "Provider unavailable" }, { status }),
    );
    await expect(queueOutboundCall({
      ...sarvamEnvironment, OUTBOUND_CALL_PRIMARY_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "secret", TWILIO_FROM_NUMBER: "+12025550123",
    }, {
      deliveryId: "outing-1", token: "token", destinationPhoneE164: "+919876543210",
      script: "Your outing is overdue. Please return and scan your ID.", requiredProvider: "sarvam",
    })).rejects.toBeInstanceOf(status === 429 ? RejectedCallDispatchError : AmbiguousCallDispatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("https://apps.sarvam.ai/");
  });

  test("a required Sarvam agent reports missing configuration without calling Twilio", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(queueOutboundCall({
      ...environment, TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "secret", TWILIO_FROM_NUMBER: "+12025550123",
    }, {
      deliveryId: "outing-1", token: "token", destinationPhoneE164: "+919876543210",
      script: "Your outing is overdue. Please return and scan your ID.", requiredProvider: "sarvam",
    })).rejects.toBeInstanceOf(TelephonyConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("builds capability-bound Sarvam webhooks and escaped TwiML", () => {
    expect(sarvamWebhookUrl(environment, "delivery/1", "token+1")).toBe(
      "https://voice.example.com/sarvam/status/delivery%2F1/token%2B1",
    );
    const xml = twilioVoiceXml("One & <two>");
    expect(xml).toContain(
      "hi, i&apos;m calling on behalf of the code2create team. One &amp; &lt;two&gt;",
    );
    expect(xml).toContain('voice="alice" language="en-US"');
    expect(xml).toContain("</Say><Hangup/>");
  });

  test("adds the Code2Create introduction exactly once", () => {
    const introduction =
      "hi, i'm calling on behalf of the code2create team";
    expect(withOutboundCallIntroduction("Code2Create needs you now.")).toBe(
      `${introduction}. Code2Create needs you now.`,
    );
    expect(withOutboundCallIntroduction(
      `${introduction}. Code2Create needs you now.`,
    ),
    ).toBe(`${introduction}. Code2Create needs you now.`);
  });

  test("normalizes provider lifecycle values", () => {
    expect(twilioStatusEvent("in-progress")).toBe("call.answered");
    expect(twilioStatusEvent("no-answer")).toBe("call.no_answer");
    expect(twilioStatusEvent("made-up")).toBeNull();
    expect(sarvamWebhookEvent("connected")).toBe("call.completed");
    expect(sarvamWebhookEvent("no_answer")).toBe("call.no_answer");
    expect(sarvamWebhookEvent("made-up")).toBeNull();
  });

  test("verifies the documented Twilio form signature algorithm", async () => {
    const authToken = "12345";
    const requestUrl = "https://example.com/myapp.php?foo=1&bar=2";
    const form = new URLSearchParams({
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      Digits: "1234",
      From: "+14158675310",
      To: "+18005551212",
    });
    expect(
      await verifyTwilioSignature({
        authToken,
        requestUrl,
        form,
        signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=",
      }),
    ).toBe(true);
  });

  test("sends each Twilio call-progress event as a repeated parameter", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ sid: "CA123", status: "queued" }));
    await expect(
      queueTwilioCall(
        {
          ...environment,
          TWILIO_ACCOUNT_SID: "AC123",
          TWILIO_AUTH_TOKEN: "secret",
          TWILIO_FROM_NUMBER: "+12025550123",
        },
        {
          deliveryId: "delivery-1",
          token: "token-1",
          destinationPhoneE164: "+919876543210",
        },
      ),
    ).resolves.toEqual({
      provider: "twilio",
      providerCallId: "CA123",
      providerStatus: "queued",
    });
    const request = fetchMock.mock.calls[0];
    if (request === undefined) {
      throw new Error("The call request was not sent.");
    }
    const body = request[1]?.body;
    if (!(body instanceof URLSearchParams)) {
      throw new Error("The call request did not contain form data.");
    }
    const form = new URLSearchParams(body);
    expect(form.getAll("StatusCallbackEvent")).toEqual([
      "initiated",
      "ringing",
      "answered",
      "completed",
    ]);
    expect(
      [...form.keys()].some((key) => key.startsWith("StatusCallbackEvent[")),
    ).toBe(false);
  });

  test("sends a managed Sarvam Voice Agents call over its Vobiz connection", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ attempt_id: "attempt-1" }));
    await expect(queueSarvamCall(sarvamEnvironment, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    }),
    ).resolves.toEqual({
      provider: "sarvam",
      providerCallId: "attempt-1",
      providerStatus: "queued",
    });
    const request = fetchMock.mock.calls[0];
    if (!request) throw new Error("The Sarvam request was not sent.");
    expect(String(request[0])).toBe(
      "https://apps.sarvam.ai/api/outbounds/v1/orgs/org-1/workspaces/workspace-1/outbounds",
    );
    expect(new Headers(request[1]?.headers).get("x-api-key")).toBe(
      "voice-agents-secret",
    );
    const body: unknown = JSON.parse(String(request[1]?.body));
    expect(body).toMatchObject({
      app_config: {
        app_id: "app-1",
        app_version: 15,
        connection_config: {
          connection_id: "connection-1",
          agent_phone_number: "+917965854087",
        },
        app_type: "agent",
        agent_variables: {
          call_message:
            "hi, i'm calling on behalf of the code2create team. Code2Create needs you now.",
        },
        app_overrides: {
          initial_language_name: "English",
        },
      },
      user_config: { user_phone_number: "+919876543210" },
      webhook_config: {
        url: "https://voice.example.com/sarvam/status/delivery-1/token-1",
        metadata: { delivery_id: "delivery-1" },
      },
    });
  });

  test("falls back to Sarvam only after a definite Twilio rejection", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          { message: "The Twilio route is unavailable." },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ attempt_id: "attempt-1" }));
    await expect(queueOutboundCall({
      ...sarvamEnvironment,
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "twilio-secret",
      TWILIO_FROM_NUMBER: "+12025550123",
    }, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    },
      ),
    ).resolves.toMatchObject({
      provider: "sarvam",
      providerCallId: "attempt-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("uses the configured primary provider before the fallback", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ attempt_id: "attempt-1" }));
    await expect(queueOutboundCall({
      ...sarvamEnvironment,
      OUTBOUND_CALL_PRIMARY_PROVIDER: "sarvam",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "twilio-secret",
      TWILIO_FROM_NUMBER: "+12025550123",
    }, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    },
      ),
    ).resolves.toMatchObject({ provider: "sarvam" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("apps.sarvam.ai");
  });

  test("falls back to Twilio after a definite Sarvam rejection", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ detail: "The Sarvam route is unavailable." }, { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ sid: "CA123", status: "queued" }));
    await expect(queueOutboundCall({
      ...sarvamEnvironment,
      OUTBOUND_CALL_PRIMARY_PROVIDER: "sarvam",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "twilio-secret",
      TWILIO_FROM_NUMBER: "+12025550123",
    }, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    },
      ),
    ).resolves.toMatchObject({ provider: "twilio", providerCallId: "CA123" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does not double-dial after an ambiguous Sarvam response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "temporary" }, { status: 503 }),
    );
    await expect(queueOutboundCall({
      ...sarvamEnvironment,
      OUTBOUND_CALL_PRIMARY_PROVIDER: "sarvam",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "twilio-secret",
      TWILIO_FROM_NUMBER: "+12025550123",
    }, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    },
      ),
    ).rejects.toBeInstanceOf(AmbiguousCallDispatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not double-dial after an ambiguous Twilio response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "temporary" }, { status: 503 }),
    );
    await expect(queueOutboundCall({
      ...sarvamEnvironment,
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "twilio-secret",
      TWILIO_FROM_NUMBER: "+12025550123",
    }, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    },
      ),
    ).rejects.toBeInstanceOf(AmbiguousCallDispatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not double-dial when the Twilio response body is interrupted", async () => {
    const interruptedResponse = Response.json({ sid: "CA123", status: "queued",
    });
    vi.spyOn(interruptedResponse, "text").mockRejectedValue(
      new Error("connection reset"),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      interruptedResponse);
    await expect(queueOutboundCall({
      ...sarvamEnvironment,
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "twilio-secret",
      TWILIO_FROM_NUMBER: "+12025550123",
    }, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    },
      ),
    ).rejects.toBeInstanceOf(AmbiguousCallDispatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("treats an interrupted Sarvam response body as ambiguous", async () => {
    const interruptedResponse = Response.json({ attempt_id: "attempt-1" });
    vi.spyOn(interruptedResponse, "text").mockRejectedValue(
      new Error("connection reset"),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(interruptedResponse);
    await expect(queueSarvamCall(sarvamEnvironment, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    }),
    ).rejects.toBeInstanceOf(AmbiguousCallDispatchError);
  });

  test("surfaces a definite Sarvam rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        detail: [{
          loc: ["body", "app_config", "app_version"],
          msg: "The app version is not deployed.",
          type: "value_error",
        },
          ],
      }, { status: 422 },
      ),
    );
    await expect(queueSarvamCall(sarvamEnvironment, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    }),
    ).rejects.toEqual(
      new RejectedCallDispatchError(
        "sarvam",
        "The app version is not deployed.",
      ),
    );
  });

  test("uses Sarvam when Twilio is not configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ attempt_id: "attempt-1" }));
    await expect(queueOutboundCall(sarvamEnvironment, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    }),
    ).resolves.toMatchObject({ provider: "sarvam" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("requires a positive integer Sarvam app version", () => {
    expect(sarvamConfigured({
      ...sarvamEnvironment,
      SARVAM_APP_VERSION: "13.5",
    }),
    ).toBe(false);
  });

  test("validates the configured primary provider", () => {
    expect(outboundCallProviderOrder(environment)).toEqual(["twilio", "sarvam",
    ]);
    expect(outboundCallProviderOrder({
      ...environment,
      OUTBOUND_CALL_PRIMARY_PROVIDER: " Sarvam ",
    }),
    ).toEqual(["sarvam", "twilio"]);
    expect(() => outboundCallProviderOrder({
      ...environment,
      OUTBOUND_CALL_PRIMARY_PROVIDER: "other",
    }),
    ).toThrow("must be either twilio or sarvam");
  });

  test("preserves a configured provider rejection when no fallback is available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "rejected" }, { status: 400 }),
    );
    await expect(queueOutboundCall({
      ...environment,
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "secret",
      TWILIO_FROM_NUMBER: "+12025550123",
    }, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    },
      ),
    ).rejects.toEqual(new RejectedCallDispatchError("twilio", "rejected"));
  });

  test("accepts a non-prefixed Voice Agents key and rejects whitespace-only keys", () => {
    expect(sarvamConfigured({
      ...sarvamEnvironment,
      SARVAM_VOICE_AGENTS_API_KEY: "voice-agents-key",
    }),
    ).toBe(true);
    expect(sarvamConfigured({
      ...sarvamEnvironment,
      SARVAM_VOICE_AGENTS_API_KEY: "   ",
    }),
    ).toBe(false);
  });

  test("fails clearly when neither provider is configured", async () => {
    await expect(queueOutboundCall(environment, {
      deliveryId: "delivery-1",
      token: "token-1",
      destinationPhoneE164: "+919876543210",
      script: "Code2Create needs you now.",
    }),
    ).rejects.toBeInstanceOf(TelephonyConfigurationError);
  });
});

test("a confirmation pins the conversational agent and cannot fall back to an announcement", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ detail: "Agent unavailable" }, { status: 422 }),
    );
  await expect(
    queueOutboundCall(
      {
        ...sarvamEnvironment,
        OUTBOUND_CALL_PRIMARY_PROVIDER: "twilio",
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "secret",
        TWILIO_FROM_NUMBER: "+12025550123",
      },
      {
        deliveryId: "confirmation-1",
        token: "token",
        destinationPhoneE164: "+919876543210",
        script: "May I confirm your availability?",
        venueConfirmation: {
          appId: "confirmation-agent",
          appVersion: 4,
          reviewerName: "Reviewer",
          venueName: "Hall",
          expiresAt: Date.now() + 600000,
        },
      },
    ),
  ).rejects.toBeInstanceOf(RejectedCallDispatchError);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(String(url)).toContain("apps.sarvam.ai");
  expect(JSON.parse(String(init?.body))).toMatchObject({
    app_config: {
      app_id: "confirmation-agent",
      app_version: 4,
      agent_variables: {
        call_message:
          "hi, i'm calling on behalf of the code2create team. May I confirm your availability?",
        reviewer_name: "Reviewer",
        venue_name: "Hall",
        outcome: "unclear",
        confirmed: false,
      },
    },
  });
});
