import {
  operationsIntelligenceProtocolVersion,
  type IdeaIntelligenceProjection,
  type IdeaIntelligenceSimilarityResult,
} from "@code2create/domain";
import { describe, expect, test, vi } from "vitest";

import { readIdeaProjection, readIdeaSimilarities } from "./ideaTransport.ts";

const bindings = {
  CONVEX_INTELLIGENCE_IDEA_READ_URL:
    "https://backend.example.test/intelligence/idea-submissions/read",
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
  overallParticipantCapacity: 825,
  sources: [{ sourceRef: "initial_idea", answer: "A bounded project idea." }],
  criteria: [
    {
      criterionKey: "problem_clarity",
      label: "Problem clarity",
      guidance: "Describe a concrete problem and intended user.",
    },
  ],
};

const similarityResult: IdeaIntelligenceSimilarityResult = {
  protocolVersion: operationsIntelligenceProtocolVersion,
  recommendationId: projection.recommendationId,
  applicationId: projection.applicationId,
  eventId: projection.eventId,
  contentVersion: projection.contentVersion,
  sourceInputFingerprint: projection.sourceInputFingerprint,
  sourceRefs: ["initial_idea"],
  historicalProjectCount: 200,
  historicalMatches: [
    {
      comparisonRef: "past_project_1",
      similarity: "high",
      themeLabel: "Campus queues",
      sourceYear: 2025,
      summary: "A prior project helped students predict queues at campus facilities.",
    },
  ],
  currentSubmissionMatches: [
    {
      comparisonRef: "current_submission_1",
      similarity: "moderate",
      summary: "A submitted project coordinates demand across shared campus services.",
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

describe("idea similarity transport identity", () => {
  test("derives the closed similarity route and binds the result to the frozen projection", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(similarityResult));
    await expect(
      readIdeaSimilarities({
        projection,
        sourceRefs: ["initial_idea"],
        operationId: "similarity:recommendation-1",
        bindings,
        request,
      }),
    ).resolves.toEqual(similarityResult);
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://backend.example.test/intelligence/idea-submissions/similarity",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      operation: "find_similar_ideas",
      recommendationId: projection.recommendationId,
      contentVersion: projection.contentVersion,
      sourceRefs: ["initial_idea"],
    });
    expect(new Headers(init?.headers).get("x-c2c-signature")).toBeTruthy();
  });

  test("rejects a similarity result for another application revision", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...similarityResult, contentVersion: 4 }));
    await expect(
      readIdeaSimilarities({
        projection,
        sourceRefs: ["initial_idea"],
        operationId: "similarity:recommendation-1",
        bindings,
        request,
      }),
    ).rejects.toThrow("invalid idea similarity result");
  });
});
