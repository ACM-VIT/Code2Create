import {
  operationsIntelligenceProtocolVersion,
  type IdeaIntelligenceProjection,
} from "@code2create/domain";
import { describe, expect, test, vi } from "vitest";

import { readIdeaProjection } from "./ideaTransport.ts";

const bindings = {
  CONVEX_INTELLIGENCE_IDEA_READ_URL: "https://backend.example.test/idea-read",
  INTELLIGENCE_READ_SECRET: "idea-read-test-secret-".repeat(2),
};

const projection: IdeaIntelligenceProjection = {
  protocolVersion: operationsIntelligenceProtocolVersion,
  recommendationId: "recommendation-1",
  applicationId: "application-1",
  eventId: "event-1",
  modelId: "gpt-4.1-mini",
  promptVersion: "idea-prompt-v2",
  schemaVersion: "idea-schema-v1",
  evaluationSuiteVersion: "idea-eval-v1",
  contentVersion: 3,
  sourceInputFingerprint: "source-fingerprint-1",
  experienceBand: "first_year",
  sources: [{ sourceRef: "initial_idea", answer: "A bounded project idea." }],
  criteria: [
    {
      criterionKey: "problem_clarity",
      label: "Problem clarity",
      guidance: "Describe a concrete problem and intended user.",
    },
  ],
};

function readWith(result: IdeaIntelligenceProjection) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
  return readIdeaProjection({
    applicationId: "application-1",
    eventId: "event-1",
    recommendationId: "recommendation-1",
    operationId: "read:recommendation-1",
    bindings,
    request,
  });
}

describe("idea projection transport identity", () => {
  test("accepts the exact signed projection identity", async () => {
    await expect(readWith(projection)).resolves.toEqual(projection);
  });

  test.each([
    { eventId: "event-2" },
    { recommendationId: "recommendation-2" },
    { applicationId: "application-2" },
  ])("rejects a valid projection for another authority coordinate: %o", async (change) => {
    await expect(readWith({ ...projection, ...change })).rejects.toThrow("invalid idea projection");
  });
});
