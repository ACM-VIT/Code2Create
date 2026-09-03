import { describe, expect, test, vi } from "vitest";

import { parseIdeaWebSearchResponse, searchPublicIdeaContext } from "./ideaWebSearch.ts";

const providerResponse = {
  id: "resp_idea_search",
  status: "completed",
  output: [
    {
      type: "web_search_call",
      action: { type: "search", query: "campus queue prediction" },
    },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "Comparable queue-prediction systems exist, but their workflows differ.",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.edu/queue-research",
              title: "Queue research",
            },
            {
              type: "url_citation",
              url: "https://example.edu/queue-research",
              title: "Duplicate",
            },
          ],
        },
      ],
    },
  ],
};

describe("idea web search", () => {
  test("extracts a bounded cited summary and deduplicates source URLs", () => {
    expect(parseIdeaWebSearchResponse(providerResponse)).toEqual({
      summary: "Comparable queue-prediction systems exist, but their workflows differ.",
      sources: [
        {
          title: "Queue research",
          url: "https://example.edu/queue-research",
        },
      ],
    });
  });

  test("uses the frozen model and OpenAI's public web-search tool", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(providerResponse));
    await searchPublicIdeaContext({
      apiKey: "test-key",
      modelId: "gpt-5.6-luna",
      query: "campus queue prediction student facilities",
      request,
    });

    expect(request).toHaveBeenCalledOnce();
    const init = request.mock.calls[0]?.[1];
    if (typeof init?.body !== "string") throw new Error("The web-search request body is missing.");
    const body: unknown = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      tools: [{ type: "web_search", search_context_size: "medium" }],
      tool_choice: "required",
    });
  });

  test.each([
    "compare student@example.com queue tools",
    "compare https://example.com with queue tools",
    "compare queue tool for 9876543210",
  ])("rejects a query that could disclose participant data: %s", async (query) => {
    const request = vi.fn<typeof fetch>();
    await expect(
      searchPublicIdeaContext({
        apiKey: "test-key",
        modelId: "gpt-5.6-luna",
        query,
        request,
      }),
    ).rejects.toThrow("must not contain participant contact details or URLs");
    expect(request).not.toHaveBeenCalled();
  });
});
