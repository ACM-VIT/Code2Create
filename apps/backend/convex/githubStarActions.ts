"use node";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { ConvexError, v } from "convex/values";
import { RequestError } from "octokit";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";
import { readBoundedJsonResponse } from "./lib/boundedHttpBody";
import {
  GitHubOctokit,
  githubAppInstallationUrl,
  githubAppSlug,
  githubRepositoryIsStarred,
  githubUserAuthorizationConfiguration,
  githubUserGrantRevocationRequest,
  isGitHubRateLimit,
  safeGitHubId,
  timedGitHubFetch,
} from "./lib/githubClient";
import { decryptProviderSecret, encryptProviderSecret } from "./lib/providerSecrets";

const githubTokenUrl = "https://github.com/login/oauth/access_token";
const repositoryOwner = "sgl-project";
const repositoryName = "sglang";
const maximumAuthorizationLifetimeMs = 8 * 60 * 60 * 1_000;
const maximumProviderResponseBytes = 64 * 1_024;

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  token_type: z.string().min(1),
});

const tokenFailure = z.object({
  error: z.string().min(1).max(100),
  error_description: z.string().max(500).optional(),
});

const githubUser = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(100),
});

const githubInstallationPage = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z.array(z.object({
    id: z.number().int().positive(),
    app_slug: z.string().min(1),
    target_type: z.string().min(1),
    account: githubUser.nullable(),
    permissions: z.object({
      metadata: z.enum(["read", "write"]),
    }).passthrough(),
  })),
});

type SetupClaim =
  | {
      kind: "verify";
      intentId: Id<"githubStarSetupIntents">;
      redirectUri: string;
    }
  | { kind: "completed" };

type StarClaim =
  | { kind: "completed"; githubLogin: string; completedAt: number }
  | {
      kind: "star";
      authorizationId: Id<"githubStarAuthorizations">;
      accessTokenCiphertext: string;
    };

type CompleteConnectionResult =
  | { state: "connected"; githubLogin: string }
  | { state: "completed" };

function opaqueDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function participantSiteOrigin() {
  const configured = process.env.PARTICIPANT_SITE_URL?.trim();
  if (!configured) {
    throw new ConvexError({
      code: "PARTICIPANT_SITE_NOT_CONFIGURED",
      message: "The participant site is not configured for this environment.",
    });
  }
  const url = new URL(configured);
  const localHttp = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ConvexError({
      code: "PARTICIPANT_SITE_NOT_CONFIGURED",
      message: "The participant site URL is invalid for this environment.",
    });
  }
  return url.origin;
}

function callbackUri() {
  return `${participantSiteOrigin()}/onboarding/github/callback`;
}

function invalidCallback(): never {
  throw new ConvexError({
    code: "GITHUB_CALLBACK_INVALID",
    message: "The GitHub callback is incomplete or invalid. Connect GitHub again.",
  });
}

function installationIdFromCallback(value: string) {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 16) return invalidCallback();
  try {
    return String(safeGitHubId(value, "Installation ID"));
  } catch {
    return invalidCallback();
  }
}

async function requireParticipantInstallation(
  octokit: InstanceType<typeof GitHubOctokit>,
  installationId: string,
  user: z.infer<typeof githubUser>,
) {
  const expectedInstallationId = safeGitHubId(installationId, "Installation ID");
  const expectedAppSlug = githubAppSlug();
  let page = 1;
  let inspected = 0;
  while (page <= 100) {
    const response = await octokit.request("GET /user/installations", {
      per_page: 100,
      page,
    });
    const parsedPage = githubInstallationPage.safeParse(response.data);
    if (!parsedPage.success) {
      throw new ConvexError({
        code: "GITHUB_RESPONSE_INVALID",
        message: "GitHub returned an invalid App installation. Connect GitHub again.",
      });
    }
    const installation = parsedPage.data.installations.find(
      (candidate) => candidate.id === expectedInstallationId,
    );
    if (installation) {
      if (
        installation.app_slug !== expectedAppSlug ||
        installation.target_type !== "User" ||
        installation.account?.id !== user.id
      ) {
        throw new ConvexError({
          code: "GITHUB_INSTALLATION_ACCOUNT_MISMATCH",
          message:
            "Install the Code2Create GitHub App on the same personal account you authorized.",
        });
      }
      return;
    }
    inspected += parsedPage.data.installations.length;
    if (
      inspected >= parsedPage.data.total_count ||
      parsedPage.data.installations.length === 0
    ) {
      break;
    }
    page += 1;
  }
  throw new ConvexError({
    code: "GITHUB_INSTALLATION_REQUIRED",
    message: "Install the Code2Create GitHub App on your personal account, then try again.",
  });
}

function providerFailure(error: unknown) {
  if (error instanceof ConvexError) return error;
  if (error instanceof RequestError) {
    if (isGitHubRateLimit(error.status, error.response?.headers ?? {}) || error.status >= 500) {
      return new ConvexError({
        code: "GITHUB_TEMPORARILY_UNAVAILABLE",
        message: "GitHub is temporarily unavailable. Try again in a moment.",
      });
    }
    if (error.status === 401) {
      return new ConvexError({
        code: "GITHUB_CONNECTION_EXPIRED",
        message: "Your GitHub connection expired. Connect GitHub again.",
      });
    }
    if (error.status === 403) {
      return new ConvexError({
        code: "GITHUB_STAR_PERMISSION_REQUIRED",
        message:
          "GitHub did not grant the installed Code2Create App access to star repositories. Disconnect GitHub, then connect it again.",
      });
    }
  }
  return new ConvexError({
    code: "GITHUB_REQUEST_FAILED",
    message: "GitHub could not complete this step. Try again.",
  });
}

async function revokeGitHubUserGrant(accessToken: string) {
  const request = githubUserGrantRevocationRequest(
    githubUserAuthorizationConfiguration(),
    accessToken,
  );
  const response = await timedGitHubFetch(request.url, request.init);
  if (response.status === 204 || response.status === 404) return;
  await response.body?.cancel();
  if (response.status === 429 || response.status >= 500) {
    throw new ConvexError({
      code: "GITHUB_TEMPORARILY_UNAVAILABLE",
      message: "GitHub is temporarily unavailable. Try again in a moment.",
    });
  }
  throw new ConvexError({
    code: "GITHUB_DISCONNECT_FAILED",
    message: "GitHub could not disconnect this account. Try again.",
  });
}

export const beginConnection = action({
  args: { eventSlug: v.string() },
  returns: v.object({ installationUrl: v.string() }),
  handler: async (ctx, args): Promise<{ installationUrl: string }> => {
    githubUserAuthorizationConfiguration();
    const appSlug = githubAppSlug();
    const state = randomBytes(32).toString("base64url");
    const redirectUri = callbackUri();
    const installationUrl = githubAppInstallationUrl({ appSlug, state });
    await ctx.runMutation(internal.githubStarGate.createSetupIntent, {
      eventSlug: args.eventSlug,
      stateDigest: opaqueDigest(state),
      redirectUri,
    });
    return { installationUrl };
  },
});

export const completeConnection = action({
  args: {
    eventSlug: v.string(),
    state: v.string(),
    code: v.string(),
    installationId: v.string(),
  },
  returns: v.union(
    v.object({ state: v.literal("connected"), githubLogin: v.string() }),
    v.object({ state: v.literal("completed") }),
  ),
  handler: async (ctx, args): Promise<CompleteConnectionResult> => {
    if (
      args.state.length < 32 ||
      args.state.length > 256 ||
      args.code.length < 8 ||
      args.code.length > 512
    ) {
      return invalidCallback();
    }
    const installationId = installationIdFromCallback(args.installationId);
    const attemptId = randomUUID();
    const claim: SetupClaim = await ctx.runMutation(
      internal.githubStarGate.claimSetupIntent,
      { eventSlug: args.eventSlug, stateDigest: opaqueDigest(args.state), attemptId },
    );
    if (claim.kind === "completed") return { state: "completed" as const };

    try {
      const configuration = githubUserAuthorizationConfiguration();
      const body = new URLSearchParams({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        code: args.code,
        redirect_uri: claim.redirectUri,
      });
      const response = await timedGitHubFetch(githubTokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
      const responseBody = await readBoundedJsonResponse(
        response,
        maximumProviderResponseBytes,
      );
      const failure = tokenFailure.safeParse(responseBody);
      if (!response.ok || failure.success) {
        throw new ConvexError({
          code: "GITHUB_AUTHORIZATION_REJECTED",
          message: failure.success && failure.data.error_description
            ? failure.data.error_description
            : "GitHub rejected this connection. Connect GitHub again.",
        });
      }
      const parsedToken = tokenResponse.safeParse(responseBody);
      if (!parsedToken.success) {
        throw new ConvexError({
          code: "GITHUB_RESPONSE_INVALID",
          message: "GitHub returned an invalid authorization. Connect GitHub again.",
        });
      }
      const octokit = new GitHubOctokit({ auth: parsedToken.data.access_token });
      const userResponse = await octokit.rest.users.getAuthenticated();
      const parsedUser = githubUser.safeParse(userResponse.data);
      if (!parsedUser.success) {
        throw new ConvexError({
          code: "GITHUB_RESPONSE_INVALID",
          message: "GitHub returned an invalid account. Connect GitHub again.",
        });
      }
      await requireParticipantInstallation(
        octokit,
        installationId,
        parsedUser.data,
      );
      const alreadyStarred = await githubRepositoryIsStarred(
        (route, options) => octokit.request(route, options),
        repositoryOwner,
        repositoryName,
      );
      const now = Date.now();
      const providerLifetime = parsedToken.data.expires_in === undefined
        ? maximumAuthorizationLifetimeMs
        : parsedToken.data.expires_in * 1_000;
      const authorizationExpiresAt = now + Math.min(
        providerLifetime,
        maximumAuthorizationLifetimeMs,
      );
      const result:
        | { kind: "connected"; githubLogin: string }
        | { kind: "completed"; githubLogin: string; completedAt: number } = await ctx.runMutation(
        internal.githubStarGate.finishSetupIntent,
        {
          eventSlug: args.eventSlug,
          intentId: claim.intentId,
          attemptId,
          githubUserId: String(parsedUser.data.id),
          githubLogin: parsedUser.data.login,
          authorization: alreadyStarred
            ? { kind: "already_starred" }
            : {
                kind: "connected",
                accessTokenCiphertext: encryptProviderSecret(parsedToken.data.access_token),
                authorizationExpiresAt,
              },
        },
      );
      if (result.kind === "completed") return { state: "completed" as const };
      return { state: "connected" as const, githubLogin: result.githubLogin };
    } catch (error) {
      await ctx.runMutation(internal.githubStarGate.failSetupIntent, {
        intentId: claim.intentId,
        attemptId,
        failureCode: error instanceof ConvexError ? "authorization_rejected" : "provider_failed",
      });
      throw providerFailure(error);
    }
  },
});

export const disconnect = action({
  args: { eventSlug: v.string() },
  returns: v.object({ disconnected: v.boolean() }),
  handler: async (ctx, args): Promise<{ disconnected: boolean }> => {
    const claim = await ctx.runMutation(internal.githubStarGate.prepareDisconnect, {
      eventSlug: args.eventSlug,
    });
    if (claim.kind === "revoke") {
      await revokeGitHubUserGrant(decryptProviderSecret(claim.accessTokenCiphertext));
    }
    return await ctx.runMutation(
      internal.githubStarGate.finishDisconnect,
      claim.kind === "revoke"
        ? { eventSlug: args.eventSlug, authorizationId: claim.authorizationId }
        : { eventSlug: args.eventSlug },
    );
  },
});

export const star = action({
  args: { eventSlug: v.string() },
  returns: v.object({ githubLogin: v.string(), completedAt: v.number() }),
  handler: async (ctx, args): Promise<{ githubLogin: string; completedAt: number }> => {
    const attemptId = randomUUID();
    const claim: StarClaim = await ctx.runMutation(internal.githubStarGate.claimStar, {
      eventSlug: args.eventSlug,
      attemptId,
    });
    if (claim.kind === "completed") {
      return { githubLogin: claim.githubLogin, completedAt: claim.completedAt };
    }
    try {
      const octokit = new GitHubOctokit({
        auth: decryptProviderSecret(claim.accessTokenCiphertext),
      });
      await octokit.request("PUT /user/starred/{owner}/{repo}", {
        owner: repositoryOwner,
        repo: repositoryName,
      });
      return await ctx.runMutation(internal.githubStarGate.finishStar, {
        eventSlug: args.eventSlug,
        authorizationId: claim.authorizationId,
        attemptId,
      });
    } catch (error) {
      const invalidAuthorization = error instanceof RequestError && error.status === 401;
      await ctx.runMutation(internal.githubStarGate.failStar, {
        authorizationId: claim.authorizationId,
        attemptId,
        invalidateAuthorization: invalidAuthorization,
      });
      throw providerFailure(error);
    }
  },
});
