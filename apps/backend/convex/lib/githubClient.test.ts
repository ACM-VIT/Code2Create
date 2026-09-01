import { RequestError } from "octokit";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  githubRepositoryIsStarred,
  githubOAuthGrantRevocationRequest,
  githubStarAuthorizationUrl,
  githubStarOAuthConfiguration,
  githubUserStarRequest,
  isGitHubRateLimit,
  timedGitHubFetch,
} from "./githubClient";

describe("GitHub request boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("starts participant authorization without repository installation credentials", () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "participant-authorization-client");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "participant-authorization-secret");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");

    expect(githubStarOAuthConfiguration()).toEqual({
      clientId: "participant-authorization-client",
      clientSecret: "participant-authorization-secret",
    });
  });

  it("refuses to start participant OAuth when either credential is absent", () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "participant-authorization-client");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");

    expect(() => githubStarOAuthConfiguration()).toThrow(
      "GitHub star OAuth App",
    );
  });

  it("forces an account choice for every participant authorization", () => {
    const authorizationUrl = new URL(githubStarAuthorizationUrl({
      clientId: "participant-authorization-client",
      redirectUri: "https://participant.example.test/onboarding/github/callback",
      state: "opaque-state",
      codeChallenge: "pkce-challenge",
    }));

    expect(authorizationUrl.origin).toBe("https://github.com");
    expect(authorizationUrl.pathname).toBe("/login/oauth/authorize");
    expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
      client_id: "participant-authorization-client",
      redirect_uri: "https://participant.example.test/onboarding/github/callback",
      state: "opaque-state",
      code_challenge: "pkce-challenge",
      code_challenge_method: "S256",
      scope: "public_repo",
      prompt: "select_account",
    });
  });

  it("uses GitHub's documented empty-body star request", () => {
    const request = githubUserStarRequest(
      "gho_participant_token",
      "sgl-project",
      "sglang",
    );

    expect(request).toEqual({
      url: "https://api.github.com/user/starred/sgl-project/sglang",
      init: {
        method: "PUT",
        headers: {
          accept: "application/vnd.github+json",
          authorization: "Bearer gho_participant_token",
          "content-length": "0",
          "x-github-api-version": "2026-03-10",
        },
      },
    });
  });

  it("revokes the OAuth App grant instead of only forgetting its local token", () => {
    const request = githubOAuthGrantRevocationRequest(
      { clientId: "Ov1.participant", clientSecret: "app-secret" },
      "gho_participant_token",
    );

    expect(request.url).toBe(
      "https://api.github.com/applications/Ov1.participant/grant",
    );
    expect(request.init.method).toBe("DELETE");
    expect(request.init.headers).toMatchObject({
      accept: "application/vnd.github+json",
      authorization: `Basic ${Buffer.from("Ov1.participant:app-secret").toString("base64")}`,
      "content-type": "application/json",
    });
    expect(request.init.body).toBe(
      JSON.stringify({ access_token: "gho_participant_token" }),
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
