import { RequestError } from "octokit";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  githubRepositoryIsStarred,
  githubUserAuthorizationConfiguration,
  isGitHubRateLimit,
  timedGitHubFetch,
} from "./githubClient";

describe("GitHub request boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("starts participant authorization without repository installation credentials", () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "participant-authorization-client");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "participant-authorization-secret");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");

    expect(githubUserAuthorizationConfiguration()).toEqual({
      clientId: "participant-authorization-client",
      clientSecret: "participant-authorization-secret",
    });
  });

  it("refuses to start participant OAuth when either credential is absent", () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "participant-authorization-client");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");

    expect(() => githubUserAuthorizationConfiguration()).toThrow(
      "Participant GitHub authorization",
    );
  });

  it("recognizes an existing star without changing it", async () => {
    const request = vi.fn(() => Promise.resolve({ status: 204 }));

    await expect(
      githubRepositoryIsStarred(request, "sgl-project", "sglang"),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith(
      "GET /user/starred/{owner}/{repo}",
      { owner: "sgl-project", repo: "sglang" },
    );
  });

  it("treats only GitHub's not-found response as a missing star", async () => {
    const notFound = new RequestError("Not Found", 404, {
      request: {
        headers: {},
        method: "GET",
        url: "https://api.github.com/user/starred/sgl-project/sglang",
      },
    });
    const unavailable = new RequestError("Unavailable", 503, {
      request: {
        headers: {},
        method: "GET",
        url: "https://api.github.com/user/starred/sgl-project/sglang",
      },
    });

    await expect(
      githubRepositoryIsStarred(() => Promise.reject(notFound), "sgl-project", "sglang"),
    ).resolves.toBe(false);
    await expect(
      githubRepositoryIsStarred(() => Promise.reject(unavailable), "sgl-project", "sglang"),
    ).rejects.toBe(unavailable);
  });

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
