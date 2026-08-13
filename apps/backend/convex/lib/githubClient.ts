"use node";

import { ConvexError } from "convex/values";
import { App, Octokit } from "octokit";

const githubApiVersion = "2026-03-10";
const githubRequestTimeoutMs = 30_000;

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

export function githubConfiguration(): GitHubConfiguration {
  return {
    appId: requiredEnvironment("GITHUB_APP_ID"),
    privateKey: requiredEnvironment("GITHUB_APP_PRIVATE_KEY"),
    clientId: requiredEnvironment("GITHUB_APP_CLIENT_ID"),
    clientSecret: requiredEnvironment("GITHUB_APP_CLIENT_SECRET"),
  };
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
