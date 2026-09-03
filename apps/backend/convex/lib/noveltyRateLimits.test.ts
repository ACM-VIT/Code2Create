import { describe, expect, test } from "vitest";

import {
  backgroundNoveltyIndexDeduplicationLimit,
  backgroundNoveltyIndexRateLimit,
  globalNoveltyRateLimit,
} from "./noveltyRateLimits";

describe("globalNoveltyRateLimit", () => {
  test("uses a bounded default and accepts a deployment override", () => {
    expect(globalNoveltyRateLimit()).toMatchObject({
      kind: "token bucket",
      rate: 1_800,
      period: 60_000,
      shards: 20,
    });
    expect(globalNoveltyRateLimit("6000")).toMatchObject({
      rate: 6_000,
      capacity: 200,
    });
  });

  test("rejects an invalid provider budget", () => {
    expect(() => globalNoveltyRateLimit("0")).toThrow("NOVELTY_GLOBAL_REQUESTS_PER_MINUTE");
    expect(() => globalNoveltyRateLimit("100.5")).toThrow("NOVELTY_GLOBAL_REQUESTS_PER_MINUTE");
  });

  test("reserves a separately bounded background-index budget", () => {
    expect(backgroundNoveltyIndexRateLimit()).toMatchObject({
      kind: "token bucket",
      rate: 300,
      period: 60_000,
      maxReserved: 1_500,
      shards: 10,
    });
    expect(backgroundNoveltyIndexRateLimit("1200")).toMatchObject({
      rate: 1_200,
      capacity: 20,
    });
    expect(() => backgroundNoveltyIndexRateLimit("59")).toThrow(
      "NOVELTY_INDEX_REQUESTS_PER_MINUTE",
    );
    expect(() => backgroundNoveltyIndexRateLimit("3001")).toThrow(
      "NOVELTY_INDEX_REQUESTS_PER_MINUTE",
    );
    expect(backgroundNoveltyIndexDeduplicationLimit()).toEqual({
      kind: "fixed window",
      rate: 1,
      period: 60_000,
    });
  });
});
