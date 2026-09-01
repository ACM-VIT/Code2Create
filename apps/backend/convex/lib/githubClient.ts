"use node";

import { ConvexError } from "convex/values";
import { App, Octokit, RequestError } from "octokit";

const githubApiVersion = "2026-03-10";
const githubRequestTimeoutMs = 30_000;
const githubUserAuthorizeUrl = "https://github.com/login/oauth/authorize";

export function githubStarAuthorizationUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}) {
  const authorizationUrl = new URL(githubUserAuthorizeUrl);
  authorizationUrl.searchParams.set("client_id", args.clientId);
  authorizationUrl.searchParams.set("redirect_uri", args.redirectUri);
  authorizationUrl.searchParams.set("state", args.state);
  authorizationUrl.searchParams.set("code_challenge", args.codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("scope", "public_repo");
  authorizationUrl.searchParams.set("prompt", "select_account");
  return authorizationUrl.toString();
}

export function githubUserStarRequest(accessToken: string, owner: string, repo: string) {
  if (!accessToken || !owner || !repo) {
    throw new Error("The GitHub star request is incomplete.");
  }
  return {
    url: `https://api.github.com/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    init: {
      method: "PUT",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "content-length": "0",
        "x-github-api-version": githubApiVersion,
      },
    } satisfies RequestInit,
  };
}

export function isGitHubRateLimit(
  status: number,
  headers: Readonly<Record<string, string | number | undefined>>,
) {
  const remaining = headers["x-ratelimit-remaining"];
  return (
    status === 429 ||
    (status === 403 &&
      (remaining === "0" || remaining === 0 || headers["retry-after"] !== undefined))
  );
}

export async function timedGitHubFetch(
  input: string | URL | Request,
  init?: RequestInit,
  timeoutMs = githubRequestTimeoutMs,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("The GitHub request timeout must be a positive integer.");
  }
  const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return fetch(input, {
    ...init,
    signal: callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal,
  });
}

export const GitHubOctokit = Octokit.defaults({
  headers: {
    accept: "application/vnd.github+json",
    "x-github-api-version": githubApiVersion,
  },
  request: { fetch: timedGitHubFetch },
});

export type GitHubConfiguration = {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
};

export type GitHubStarOAuthConfiguration = {
  clientId: string;
  clientSecret: string;
};

export function githubOAuthGrantRevocationRequest(
  configuration: GitHubStarOAuthConfiguration,
  accessToken: string,
) {
  const clientId = configuration.clientId.trim();
  const clientSecret = configuration.clientSecret.trim();
  if (!clientId || !clientSecret || !accessToken) {
    throw new Error("GitHub user grant revocation requires complete credentials.");
  }
  return {
    url: `https://api.github.com/applications/${encodeURIComponent(clientId)}/grant`,
    init: {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/json",
        "x-github-api-version": githubApiVersion,
      },
      body: JSON.stringify({ access_token: accessToken }),
    } satisfies RequestInit,
  };
}

type GitHubStarLookup = (
  route: "GET /user/starred/{owner}/{repo}",
  options: { owner: string; repo: string },
) => Promise<unknown>;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConvexError({
      code: "GITHUB_NOT_CONFIGURED",
      message: "The GitHub App is not configured for this environment.",
    });
  }
  return value;
}

function requiredStarOAuthEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConvexError({
      code: "GITHUB_NOT_CONFIGURED",
      message: "The GitHub star OAuth App is not configured for this environment.",
    });
  }
  return value;
}

export function githubConfiguration(): GitHubConfiguration {
  return {
    appId: requiredEnvironment("GITHUB_APP_ID"),
    privateKey: requiredEnvironment("GITHUB_APP_PRIVATE_KEY"),
    clientId: requiredEnvironment("GITHUB_APP_CLIENT_ID"),
    clientSecret: requiredEnvironment("GITHUB_APP_CLIENT_SECRET"),
  };
}

export function githubStarOAuthConfiguration(): GitHubStarOAuthConfiguration {
  return {
    clientId: requiredStarOAuthEnvironment("GITHUB_CLIENT_ID"),
    clientSecret: requiredStarOAuthEnvironment("GITHUB_CLIENT_SECRET"),
  };
}

export async function githubRepositoryIsStarred(
  request: GitHubStarLookup,
  owner: string,
  repo: string,
) {
  try {
    await request("GET /user/starred/{owner}/{repo}", { owner, repo });
    return true;
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) return false;
    throw error;
  }
}

export function githubApp(configuration = githubConfiguration()) {
  return new App({
    appId: configuration.appId,
    privateKey: configuration.privateKey,
    oauth: {
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
      allowSignup: false,
    },
    Octokit: GitHubOctokit,
  });
}

export function safeGitHubId(value: string, label: string) {
  if (!/^\d+$/.test(value)) {
    throw new ConvexError({ code: "GITHUB_ID_INVALID", message: `${label} is invalid.` });
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw new ConvexError({ code: "GITHUB_ID_INVALID", message: `${label} is invalid.` });
  }
  return numeric;
}

export async function installationOctokit(installationId: string) {
  return githubApp().getInstallationOctokit(safeGitHubId(installationId, "Installation ID"));
}

export async function repositoryOctokit(installationId: string, repositoryId: string) {
  const app = githubApp();
  const token = await app.octokit.rest.apps.createInstallationAccessToken({
    installation_id: safeGitHubId(installationId, "Installation ID"),
    repository_ids: [safeGitHubId(repositoryId, "Repository ID")],
    permissions: { contents: "read", metadata: "read" },
  });
  return new GitHubOctokit({ auth: token.data.token });
}
