import { describe, expect, test } from "vitest";
import {
  shortlistProfileSchema,
  type ShortlistCandidateInput,
} from "@code2create/domain";
import {
  analyzeShortlistTask,
  embedShortlistProfile,
  evaluateLocalShortlistQuality,
} from "./shortlistModel.ts";

const candidate: ShortlistCandidateInput = {
  applicationId: "project-a",
  teamSize: 4,
  experienceBand: "first_year",
  quality: "accept",
  sources: [
    "initial_idea",
    "follow_up_1",
    "follow_up_2",
    "follow_up_3",
    "follow_up_4",
  ].map((sourceRef) => ({
    sourceRef,
    question: "Explain the workflow",
    answer: "Residents report collection failures to the assigned collector.",
  })),
  criteria: [
    {
      criterionKey: "clarity",
      label: "Clarity",
      guidance: "Describe a concrete user and workflow.",
    },
  ],
};
const profile = shortlistProfileSchema.parse({
  user: "Residents",
  problem: "Missed collections",
  workflow: "Send a location-tagged report to the assigned collector",
  mechanism: "Route by assigned collection zone",
  deliverable: "Report and acknowledgement",
  distinction: "Offline acknowledgement",
  domain: "civic",
  aiRole: "none",
  sourceRefs: ["initial_idea"],
  premise: {
    assessment: "supported",
    explanation: "The location identifies the responsible collection zone.",
    sourceRefs: ["follow_up_1"],
  },
  category: {
    datingOrRomanticMatchmaking: false,
    explanation: "Collection reporting",
    sourceRefs: ["initial_idea"],
  },
  criteria: [
    {
      criterionKey: "clarity",
      evidence: "strong",
      sourceRefs: ["follow_up_2"],
    },
  ],
});
const envelope = (value: object) =>
  Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(value) }],
      },
    ],
  });

describe("shortlist model boundary", () => {
  test("uses the frozen projection and strict JSON schema, without domain tools", async () => {
    const request: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.text.format.strict).toBe(true);
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(JSON.parse(body.input)).toEqual({ kind: "profile", candidate });
      expect(body.instructions).toContain("untrusted data");
      return envelope(profile);
    };
    await expect(
      analyzeShortlistTask({
        task: { kind: "profile", candidate },
        modelId: "test",
        apiKey: "test",
        request,
      }),
    ).resolves.toEqual(profile);
  });
  test("rejects invented source references and missing criterion coverage", async () => {
    for (const invalid of [
      { ...profile, sourceRefs: ["private-invented-source"] },
      { ...profile, criteria: [] },
    ]) {
      await expect(
        analyzeShortlistTask({
          task: { kind: "profile", candidate },
          modelId: "test",
          apiKey: "test",
          request: async () => envelope(invalid),
        }),
      ).rejects.toThrow();
    }
  });
  test("pair and audit tasks cannot browse or identify outside candidates", async () => {
    const request: typeof fetch = async (_url, init) => {
      expect(JSON.parse(String(init?.body)).tools).toBeUndefined();
      return envelope({
        warnings: [
          {
            applicationIds: ["outside-pool"],
            explanation: "Unsupported external attribution",
          },
        ],
      });
    };
    await expect(
      analyzeShortlistTask({
        task: {
          kind: "audit",
          candidates: [
            {
              applicationId: candidate.applicationId,
              suggestion: "accept",
              profile,
            },
          ],
        },
        modelId: "test",
        apiKey: "test",
        request,
      }),
    ).rejects.toThrow("Invalid audit evidence identity");
  });
  test("refusals, incomplete replies and provider failures do not become assessments", async () => {
    for (const response of [
      Response.json({ status: "incomplete", output: [] }),
      Response.json({ status: "completed", output: [] }),
      new Response("Unavailable", { status: 503 }),
    ]) {
      await expect(
        analyzeShortlistTask({
          task: { kind: "profile", candidate },
          modelId: "test",
          apiKey: "test",
          request: async () => response,
        }),
      ).rejects.toThrow();
    }
  });
  test("local original-rubric retries correct prohibited prose without bypassing the ladder", async () => {
    let calls = 0;
    const assessment = {
      recommendation: "accept",
      centralProposalConsistency: {
        assessment: "consistent",
        sourceRefs: ["initial_idea"],
      },
      criterionAssessments: [
        {
          criterionKey: "clarity",
          assessment: "meets",
          sourceRefs: ["follow_up_1"],
        },
      ],
      strengths: ["Concrete collection workflow"],
      concerns: [],
      confidence: "medium",
      limitations: ["Historical similarity corpus unavailable"],
    };
    const request: typeof fetch = async (_url, init) => {
      calls++;
      if (calls === 1)
        return envelope({
          ...assessment,
          strengths: ["The report receives a score"],
        });
      expect(JSON.parse(String(init?.body)).instructions).toContain(
        "prohibited_language",
      );
      return envelope(assessment);
    };
    await expect(
      evaluateLocalShortlistQuality({
        candidate,
        modelId: "test",
        apiKey: "test",
        request,
      }),
    ).resolves.toEqual(assessment);
    expect(calls).toBe(2);
  });
  test("embeddings require the exact finite vector contract", async () => {
    await expect(
      embedShortlistProfile("text", "test", async () =>
        Response.json({ data: [{ index: 0, embedding: [1] }] }),
      ),
    ).rejects.toThrow("Invalid shortlist embedding");
    const vector = Array.from({ length: 1536 }, () => 0.1);
    await expect(
      embedShortlistProfile("text", "test", async () =>
        Response.json({ data: [{ index: 0, embedding: vector }] }),
      ),
    ).resolves.toEqual(vector);
  });
});
