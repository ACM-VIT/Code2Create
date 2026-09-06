import { afterEach, describe, expect, test, vi } from "vitest";

import { lookupYouTubeVideos, youtubeDurationSeconds, youtubeVideoId } from "./youtubeCatalog";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_FALLBACK_KEYS;
});

describe("youtubeVideoId", () => {
  test("accepts a bare id and every usual link shape", () => {
    for (const value of [
      "dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD",
      "https://youtu.be/dQw4w9WgXcQ?si=abc",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "  https://www.youtube.com/live/dQw4w9WgXcQ  ",
    ]) {
      expect(youtubeVideoId(value)).toBe("dQw4w9WgXcQ");
    }
  });

  test("rejects other hosts, malformed ids, and free text", () => {
    for (const value of [
      "",
      "lofi beats",
      "dQw4w9WgXc",
      "https://vimeo.com/12345",
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/channel/UC1234567890",
    ]) {
      expect(youtubeVideoId(value)).toBeNull();
    }
  });
});

describe("youtubeDurationSeconds", () => {
  test("reads ISO 8601 durations as YouTube writes them", () => {
    expect(youtubeDurationSeconds("PT3M42S")).toBe(222);
    expect(youtubeDurationSeconds("PT1H2M")).toBe(3_720);
    expect(youtubeDurationSeconds("PT45S")).toBe(45);
    expect(youtubeDurationSeconds("P1DT2H")).toBe(93_600);
    expect(youtubeDurationSeconds("P0D")).toBe(0);
  });

  test("rejects anything else", () => {
    expect(youtubeDurationSeconds("3:42")).toBeNull();
    expect(youtubeDurationSeconds("PT")).toBe(0);
    expect(youtubeDurationSeconds("")).toBeNull();
  });
});

describe("YouTube API key fallback", () => {
  test("retries a rate-limited request with the next configured key", async () => {
    process.env.YOUTUBE_API_KEY = "primary";
    process.env.YOUTUBE_API_FALLBACK_KEYS = "fallback-one,fallback-two";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({
          items: [
            {
              id: "dQw4w9WgXcQ",
              snippet: { title: "Track", channelTitle: "Artist" },
              contentDetails: { duration: "PT3M42S", contentRating: {} },
              status: { embeddable: true },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(lookupYouTubeVideos(["dQw4w9WgXcQ"])).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get("key")).toBe("primary");
    expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get("key")).toBe(
      "fallback-one",
    );
  });

  test("also rotates keys for YouTube's quota-exceeded 403 response", async () => {
    process.env.YOUTUBE_API_KEY = "primary";
    process.env.YOUTUBE_API_FALLBACK_KEYS = "fallback";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { errors: [{ reason: "quotaExceeded" }] } },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ items: [] }));
    vi.stubGlobal("fetch", fetch);

    await expect(lookupYouTubeVideos(["dQw4w9WgXcQ"])).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
