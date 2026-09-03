import { describe, expect, test } from "vitest";

import { youtubeDurationSeconds, youtubeVideoId } from "./youtubeCatalog";

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
