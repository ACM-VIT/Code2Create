import { afterEach, expect, test, vi } from "vitest";
import { sendEmailThroughService } from "./emailServiceSending";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

test.each([
  [404, "rejected", "email_service_route_not_found"],
  [502, "ambiguous", "email_service_response_ambiguous"],
  [200, "ambiguous", "email_service_response_ambiguous"],
] as const)("classifies a plain HTTP %s response without assuming provider acceptance", async (httpStatus, status, errorCode) => {
  vi.stubEnv("EMAIL_SERVICE_URL", "https://email.example.test");
  vi.stubEnv("EMAIL_SEND_INGRESS_SECRET", "service-ingress-fixture-secret-with-32-characters");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not found.", { status: httpStatus })));
  expect(await sendEmailThroughService({
    requestId: "fixture", provider: "aws_ses", to: "fixture@example.test",
    subject: "Fixture", text: "Fixture", html: "<p>Fixture</p>", headers: [], attachments: [],
  })).toMatchObject({ status, errorCode, provider: "aws_ses" });
});
