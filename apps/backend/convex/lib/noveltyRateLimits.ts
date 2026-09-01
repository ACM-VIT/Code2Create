import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";

import { components } from "../_generated/api";

export const noveltyRateLimiter = new RateLimiter(components.noveltyRateLimiter);

export function globalNoveltyRateLimit(configured?: string) {
  const rate = configured === undefined || configured.trim() === ""
    ? 1_800
    : Number(configured);
  if (!Number.isSafeInteger(rate) || rate < 60 || rate > 12_000) {
    throw new Error(
      "NOVELTY_GLOBAL_REQUESTS_PER_MINUTE must be a whole number from 60 through 12000.",
    );
  }
  return {
    kind: "token bucket" as const,
    rate,
    period: MINUTE,
    capacity: Math.min(200, Math.max(20, Math.ceil(rate / 30))),
    shards: 20,
  };
}

export function teamNoveltyRateLimit(maximumRequestsPerMinute: number) {
  return {
    kind: "fixed window" as const,
    rate: maximumRequestsPerMinute,
    period: MINUTE,
  };
}

export function backgroundNoveltyIndexRateLimit(configured?: string) {
  const rate = configured === undefined || configured.trim() === ""
    ? 300
    : Number(configured);
  if (!Number.isSafeInteger(rate) || rate < 60 || rate > 3_000) {
    throw new Error(
      "NOVELTY_INDEX_REQUESTS_PER_MINUTE must be a whole number from 60 through 3000.",
    );
  }
  return {
    kind: "token bucket" as const,
    rate,
    period: MINUTE,
    capacity: Math.min(20, Math.max(5, Math.ceil(rate / 30))),
    maxReserved: 1_500,
    shards: 10,
  };
}

export function backgroundNoveltyIndexDeduplicationLimit() {
  return {
    kind: "fixed window" as const,
    rate: 1,
    period: MINUTE,
  };
}
