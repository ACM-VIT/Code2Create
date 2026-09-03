import { afterEach, describe, expect, test, vi } from "vitest";

import {
  audioRouteUrl,
  fallbackVoiceTwiml,
  queueTwilioCall,
  synthesizeSpeech,
  synthesizedVoiceTwiml,
  twilioStatusEvent,
  verifyTwilioSignature,
} from "./telephony.js";

const environment = { PUBLIC_BASE_URL: "https://voice.example.com/" };

afterEach(() => vi.restoreAllMocks());

describe("outbound voice transport", () => {
  test("builds bounded public media routes and escaped TwiML", () => {
    expect(audioRouteUrl(environment, "delivery/1", "token+1")).toBe(
      "https://voice.example.com/twilio/audio/delivery%2F1/token%2B1.mp3",
    );
    expect(synthesizedVoiceTwiml(environment, "delivery/1", "token+1")).toContain(
      "delivery%2F1/token%2B1.mp3",
    );
    expect(fallbackVoiceTwiml("One & <two>")).toContain("One &amp; &lt;two&gt;");
  });

  test("normalizes Twilio lifecycle values", () => {
    expect(twilioStatusEvent("in-progress")).toBe("call.answered");
    expect(twilioStatusEvent("no-answer")).toBe("call.no_answer");
    expect(twilioStatusEvent("made-up")).toBeNull();
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

  test("sends Sarvam's current streaming request shape", async () => {
    const audio = new Uint8Array(1001);
    audio.set([0x49, 0x44, 0x33]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(audio, { status: 200 }));
    await expect(
      synthesizeSpeech(
        {
          ...environment,
          TWILIO_ACCOUNT_SID: "AC123",
          TWILIO_AUTH_TOKEN: "secret",
          TWILIO_FROM_NUMBER: "+12025550123",
          SARVAM_API_KEY: "sarvam-secret",
        },
        "Code2Create needs you now.",
      ),
    ).resolves.toBeInstanceOf(ArrayBuffer);
    const request = fetchMock.mock.calls[0];
    if (request === undefined) {
      throw new Error("The speech request was not sent.");
    }
    expect(request[0]).toBe("https://api.sarvam.ai/text-to-speech/stream");
    const body = request[1]?.body;
    // The assertion verifies the exact transport representation sent to fetch.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (typeof body !== "string") {
      throw new TypeError("The speech request did not contain a string body.");
    }
    expect(body).toContain('"language_code":"en-IN"');
    expect(body).toContain('"model":"bulbul:v3"');
    expect(body).toContain('"output_audio_codec":"mp3"');
    expect(body).toContain('"speech_sample_rate":8000');
    expect(body).not.toContain("target_language_code");
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
    ).resolves.toEqual({ providerCallId: "CA123", providerStatus: "queued" });
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
    expect([...form.keys()].some((key) => key.startsWith("StatusCallbackEvent["))).toBe(false);
  });
});
