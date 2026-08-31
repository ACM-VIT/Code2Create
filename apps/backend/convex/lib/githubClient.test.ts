import { afterEach, describe, expect, it, vi } from "vitest";

import { isGitHubRateLimit, timedGitHubFetch } from "./githubClient";

describe("GitHub request boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("gives every provider request a fresh deadline", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        if (!init?.signal) throw new Error("The GitHub request has no deadline.");
        signals.push(init.signal);
        return Promise.resolve(Response.json({ ok: true }));
      }),
    );

    await timedGitHubFetch("https://api.github.com/app");
    await timedGitHubFetch("https://api.github.com/installation/repositories");

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("aborts a slow provider request at the boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("The GitHub request has no deadline.");
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ),
    );

    await expect(
      timedGitHubFetch("https://api.github.com/app", undefined, 1),
    ).rejects.toBeDefined();
  });

  it("distinguishes primary and secondary rate limits from missing permissions", () => {
    expect(isGitHubRateLimit(429, {})).toBe(true);
    expect(isGitHubRateLimit(403, { "x-ratelimit-remaining": "0" })).toBe(true);
    expect(isGitHubRateLimit(403, { "x-ratelimit-remaining": 0 })).toBe(true);
    expect(isGitHubRateLimit(403, { "retry-after": "60" })).toBe(true);
    expect(isGitHubRateLimit(403, {})).toBe(false);
  });
});
