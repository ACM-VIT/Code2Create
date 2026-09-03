import { afterEach, describe, expect, test, vi } from "vitest";

import {
  noveltyJudgeMaximumOutputTokens,
  noveltyJudgeModelId,
  noveltyJudgePromptVersion,
  OpenAiNoveltyJudgeError,
  requestOpenAiNoveltyJudgments,
  requestOpenAiNoveltyJudgmentsWithFallback,
} from "./openAiNoveltyJudge";

const request = {
  apiKey: "novelty-test-key",
  query: "A voice assistant that helps farmers identify crop disease from symptoms.",
  candidates: [
    {
      key: "corpus:farmer-assistant",
      text: "An AI crop doctor for farmers that diagnoses plant disease.",
    },
    {
      key: "corpus:campus-garden",
      text: "A volunteer exchange for students maintaining a campus garden.",
    },
  ],
  safetyIdentifier: "team_opaque_123",
  timeoutMs: 100,
};

function providerResponse(output: unknown) {
  return new Response(
    JSON.stringify({
      id: "resp_novelty_test",
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: typeof output === "string" ? output : JSON.stringify(output),
            },
          ],
        },
      ],
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "request-novelty-test",
      },
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestOpenAiNoveltyJudgments", () => {
  test("sends the bounded Luna contract and returns validated judgments", async () => {
    const fetch = vi.fn().mockResolvedValue(
      providerResponse({
        comparisons: [
          {
            candidateKey: "corpus:campus-garden",
            relationship: "different",
            confidence: "high",
            sharedDimensions: [],
          },
          {
            candidateKey: "corpus:farmer-assistant",
            relationship: "same_core_idea",
            confidence: "high",
            sharedDimensions: ["audience", "problem", "mechanism", "outcome"],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await requestOpenAiNoveltyJudgments(request);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: noveltyJudgeModelId,
      store: false,
      reasoning: { effort: "low" },
      max_output_tokens: noveltyJudgeMaximumOutputTokens,
      safety_identifier: request.safetyIdentifier,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          strict: true,
          schema: {
            properties: {
              comparisons: {
                minItems: 2,
                maxItems: 2,
                items: {
                  properties: {
                    candidateKey: {
                      enum: request.candidates.map((candidate) => candidate.key),
                    },
                  },
                },
              },
            },
            additionalProperties: false,
          },
        },
      },
    });
    expect(body.instructions).toContain("untrusted project descriptions");
    expect(body.instructions).toContain("Do not evaluate writing quality");
    expect(JSON.parse(body.input)).toEqual({
      release: noveltyJudgePromptVersion,
      query: request.query,
      candidates: request.candidates,
    });
    expect(result).toEqual({
      comparisons: [
        {
          candidateKey: "corpus:farmer-assistant",
          relationship: "same_core_idea",
          confidence: "high",
          sharedDimensions: ["audience", "problem", "mechanism", "outcome"],
        },
        {
          candidateKey: "corpus:campus-garden",
          relationship: "different",
          confidence: "high",
          sharedDimensions: [],
        },
      ],
      responseId: "resp_novelty_test",
      requestId: "request-novelty-test",
      outputChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result).not.toHaveProperty("outputText");
  });

  test.each([
    ["malformed JSON", "not-json"],
    [
      "a missing candidate",
      {
        comparisons: [
          {
            candidateKey: "corpus:farmer-assistant",
            relationship: "same_core_idea",
            confidence: "high",
            sharedDimensions: ["audience", "problem"],
          },
        ],
      },
    ],
    [
      "an unknown candidate",
      {
        comparisons: [
          {
            candidateKey: "corpus:farmer-assistant",
            relationship: "same_core_idea",
            confidence: "high",
            sharedDimensions: ["audience", "problem"],
          },
          {
            candidateKey: "unknown",
            relationship: "different",
            confidence: "low",
            sharedDimensions: [],
          },
        ],
      },
    ],
    [
      "duplicate candidate keys",
      {
        comparisons: [
          {
            candidateKey: "corpus:farmer-assistant",
            relationship: "same_core_idea",
            confidence: "high",
            sharedDimensions: ["audience", "problem"],
          },
          {
            candidateKey: "corpus:farmer-assistant",
            relationship: "different",
            confidence: "low",
            sharedDimensions: [],
          },
        ],
      },
    ],
  ])("rejects %s without exposing the raw output", async (_label, output) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse(output)));

    const result = requestOpenAiNoveltyJudgments(request);
    await expect(result).rejects.toBeInstanceOf(OpenAiNoveltyJudgeError);
    await expect(result).rejects.toMatchObject({
      status: 200,
      timedOut: false,
      failureCategory: "provider_response_invalid",
      message: "The novelty judge returned an invalid response.",
    });
  });

  test("classifies a rate-limited provider response without retrying", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetch);

    await expect(requestOpenAiNoveltyJudgments(request)).rejects.toMatchObject({
      status: 429,
      timedOut: false,
      failureCategory: "provider_rate_limited",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    [429, "judge_provider_rate_limited"],
    [408, "judge_provider_http_408"],
    [500, "judge_provider_http_500"],
    [502, "judge_provider_http_502"],
    [503, "judge_provider_http_503"],
    [504, "judge_provider_http_504"],
  ])("falls back to embeddings for transient HTTP %i", async (status, failureCategory) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status })));

    await expect(requestOpenAiNoveltyJudgmentsWithFallback(request)).resolves.toEqual({
      kind: "embedding_fallback",
      failureCategory,
    });
  });

  test("falls back to embeddings for a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection reset")));

    await expect(requestOpenAiNoveltyJudgmentsWithFallback(request)).resolves.toEqual({
      kind: "embedding_fallback",
      failureCategory: "judge_provider_request_failed",
    });
  });

  test("classifies timeout aborts without retrying", async () => {
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("The novelty request has no timeout signal.");
          signal.addEventListener(
            "abort",
            () => {
              const timeout = new Error("request expired");
              timeout.name = "TimeoutError";
              reject(timeout);
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      requestOpenAiNoveltyJudgments({
        ...request,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({
      status: undefined,
      timedOut: true,
      failureCategory: "provider_request_timed_out",
    });
    await expect(
      requestOpenAiNoveltyJudgmentsWithFallback({
        ...request,
        timeoutMs: 5,
      }),
    ).resolves.toEqual({
      kind: "embedding_fallback",
      failureCategory: "judge_provider_timed_out",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test.each([401, 501, 505])("does not hide permanent HTTP %i errors", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider error", { status })));

    await expect(requestOpenAiNoveltyJudgmentsWithFallback(request)).rejects.toMatchObject({
      status,
      failureCategory: "provider_http_error",
    });
  });

  test("does not hide an invalid structured response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse("not-json")));

    await expect(requestOpenAiNoveltyJudgmentsWithFallback(request)).rejects.toMatchObject({
      status: 200,
      failureCategory: "provider_response_invalid",
    });
  });

  test("does not hide an invalid internal request", async () => {
    await expect(
      requestOpenAiNoveltyJudgmentsWithFallback({
        ...request,
        candidates: [],
      }),
    ).rejects.toMatchObject({
      failureCategory: "invalid_input",
    });
  });
});
