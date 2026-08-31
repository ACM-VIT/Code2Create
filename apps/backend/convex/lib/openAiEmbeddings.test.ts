import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createOpenAiEmbeddings,
  OpenAiEmbeddingError,
} from "./openAiEmbeddings";

const request = {
  apiKey: "test-key",
  model: "text-embedding-3-small" as const,
  input: "A test project",
  timeoutMs: 100,
};

function embeddingResponse(requestId = "embedding-request") {
  return new Response(JSON.stringify({
    data: [{ embedding: [0.1, 0.2], index: 0 }],
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOpenAiEmbeddings", () => {
  test("retries one transient transport failure", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(embeddingResponse());
    vi.stubGlobal("fetch", fetch);

    const result = await createOpenAiEmbeddings({
      ...request,
      maximumAttempts: 2,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.requestId).toBe("embedding-request");
    expect(result.data).toEqual([{ embedding: [0.1, 0.2], index: 0 }]);
  });

  test("does not retry a non-transient provider response", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("invalid request", {
      status: 400,
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(createOpenAiEmbeddings({
      ...request,
      maximumAttempts: 2,
    })).rejects.toMatchObject({
      status: 400,
      timedOut: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("classifies runtime timeout errors without relying on DOMException", async () => {
    const timeout = new Error("request expired");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));

    const result = createOpenAiEmbeddings(request);
    await expect(result).rejects.toBeInstanceOf(OpenAiEmbeddingError);
    await expect(result).rejects.toMatchObject({ timedOut: true });
  });
});
