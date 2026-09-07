"use node";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { ConvexError, v, type Infer } from "convex/values";
import { RequestError } from "octokit";

import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import {
  GitHubOctokit,
  githubApp,
  githubConfiguration,
  githubIntegrationCallbackUri,
  isGitHubRateLimit,
  repositoryOctokit,
  safeGitHubId,
} from "./lib/githubClient";
import { githubInstallationContract } from "./lib/githubInstallationContract";
import { decryptProviderSecret, encryptProviderSecret } from "./lib/providerSecrets";
import { repositoryKind } from "./values";

type SetupClaim =
  | { kind: "verify"; intentId: Id<"githubSetupIntents">; requestedInstallationId?: string }
  | { kind: "completed"; connectionId: Id<"githubInstallationConnections"> };

type ConnectionContext = {
  accessTokenCiphertext: string;
  eventId: Id<"events">;
  teamId: Id<"teams">;
  installationId: string;
  integrationPolicyId: Id<"integrationPolicyVersions">;
  requiredGitHubTopic: string;
  maxActiveRepositories: number;
};

type AvailableRepository = {
  repositoryId: string;
  repositoryNodeId: string;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  isPrivate: boolean;
  isFork: boolean;
  defaultBranch: string;
  pushedAt?: number;
};

type AvailableRepositoryPage = {
  repositories: AvailableRepository[];
  totalCount: number;
  nextPage?: number;
};

const repositoryPageSize = 50;

function opaqueDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function targetType(value: string) {
  if (value === "User" || value === "Organization" || value === "Enterprise") return value;
  throw new ConvexError({
    code: "GITHUB_INSTALLATION_INVALID",
    message: "GitHub returned an unsupported installation account type.",
  });
}

function installationSelection(value: string) {
  if (value === "all" || value === "selected") return value;
  throw new ConvexError({
    code: "GITHUB_INSTALLATION_INVALID",
    message: "GitHub returned an unsupported repository selection.",
  });
}

function providerFailure(error: unknown) {
  if (error instanceof RequestError) {
    if (isGitHubRateLimit(error.status, error.response?.headers ?? {})) {
      return { state: "rate_limited" as const, code: "github_rate_limited" };
    }
    if (error.status === 401 || error.status === 403) {
      return { state: "error" as const, code: "github_access_denied" };
    }
    if (error.status === 404) {
      return { state: "error" as const, code: "github_not_found" };
    }
    if (error.status >= 500) {
      return { state: "error" as const, code: "github_unavailable" };
    }
    return { state: "error" as const, code: `github_http_${error.status}` };
  }
  return { state: "error" as const, code: "github_request_failed" };
}

function unixTime(value: string | null | undefined) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function providerCount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConvexError({
      code: "GITHUB_RESPONSE_INVALID",
      message: `GitHub returned an invalid ${label}.`,
    });
  }
  return value;
}

function normalizedLanguages(values: Record<string, number>) {
  return Object.entries(values)
    .map(([language, bytes]) => ({
      language,
      bytes: providerCount(bytes, "language byte count"),
    }))
    .sort((left, right) => right.bytes - left.bytes);
}

export const beginConnection = action({
  args: {
    eventSlug: v.string(),
    installationId: v.optional(v.string()),
    install: v.optional(v.boolean()),
  },
  returns: v.object({ installUrl: v.string() }),
  handler: async (ctx, args): Promise<{ installUrl: string }> => {
    const state = randomBytes(32).toString("base64url");
    const requestedInstallationId = args.installationId === undefined
      ? undefined : String(safeGitHubId(args.installationId, "Installation ID"));
    if (args.install && requestedInstallationId) {
      throw new ConvexError({ code: "SETUP_INVALID", message: "Choose either an existing installation or a new installation." });
    }
    const app = githubApp();
    await ctx.runMutation(internal.githubIntegrations.createSetupIntent, {
      eventSlug: args.eventSlug,
      stateDigest: opaqueDigest(state),
      ...(requestedInstallationId ? { requestedInstallationId } : {}),
    });
    const installUrl = args.install
      ? await app.getInstallationUrl({ state })
      : app.oauth.getWebFlowAuthorizationUrl({ state, redirectUrl: githubIntegrationCallbackUri() }).url;
    return { installUrl };
  },
});

const connectionResult = v.union(
  v.object({ kind: v.literal("connected"), connectionId: v.id("githubInstallationConnections") }),
  v.object({
    kind: v.literal("choose_installation"),
    installations: v.array(v.object({ installationId: v.string(), accountLogin: v.string() })),
  }),
);

export const completeConnection = action({
  args: {
    eventSlug: v.string(),
    state: v.string(),
    code: v.string(),
    installationId: v.optional(v.string()),
  },
  returns: connectionResult,
  handler: async (ctx, args): Promise<Infer<typeof connectionResult>> => {
    if (
      args.state.length < 32 ||
      args.state.length > 256 ||
      args.code.length < 8 ||
      args.code.length > 512
    ) {
      throw new ConvexError({
        code: "SETUP_INVALID",
        message: "The GitHub callback is incomplete or invalid.",
      });
    }
    const attemptId = randomUUID();
    const claim: SetupClaim = await ctx.runMutation(internal.githubIntegrations.claimSetupIntent, {
      eventSlug: args.eventSlug,
      stateDigest: opaqueDigest(args.state),
      attemptId,
    });
    if (claim.kind === "completed") return { kind: "connected", connectionId: claim.connectionId };

    try {
      const configuration = githubConfiguration();
      const app = githubApp(configuration);
      if (claim.requestedInstallationId && args.installationId && claim.requestedInstallationId !== args.installationId) {
        throw new ConvexError({ code: "GITHUB_INSTALLER_MISMATCH", message: "GitHub returned a different installation. Start the connection again." });
      }
      const token = await app.oauth.createToken({ code: args.code });
      const userOctokit = new GitHubOctokit({ auth: token.authentication.token });
      const githubUser = await userOctokit.rest.users.getAuthenticated();
      const selectedInstallationId = claim.requestedInstallationId ?? args.installationId;
      if (!selectedInstallationId) {
        const installations: { installationId: string; accountLogin: string }[] = [];
        // Bound provider work without silently dropping accounts from the picker.
        for (let page = 1; page <= 10; page += 1) {
          const response = await userOctokit.rest.apps.listInstallationsForAuthenticatedUser({ per_page: 100, page });
          for (const installation of response.data.installations) {
            if (String(installation.app_id) !== configuration.appId || installation.suspended_at || !installation.account) continue;
            const account = installation.account;
            if (installation.target_type === "User" && account.id !== githubUser.data.id) continue;
            installations.push({ installationId: String(installation.id), accountLogin: "login" in account ? account.login : account.slug });
          }
          if (page * 100 >= response.data.total_count) break;
          if (page === 10) {
            throw new ConvexError({ code: "GITHUB_TOO_MANY_INSTALLATIONS", message: "This account has too many installations to list. Use an account with access to the project's installation." });
          }
        }
        await ctx.runMutation(internal.githubIntegrations.finishSetupDiscovery, { intentId: claim.intentId, attemptId });
        return { kind: "choose_installation", installations };
      }
      const installationId = safeGitHubId(selectedInstallationId, "Installation ID");
      await userOctokit.rest.apps.listInstallationReposForAuthenticatedUser({
        installation_id: installationId,
        per_page: 1,
        page: 1,
      });
      const verifiedInstallation = await app.octokit.rest.apps.getInstallation({
        installation_id: installationId,
      });
      if (verifiedInstallation.data.suspended_at) {
        throw new ConvexError({ code: "GITHUB_INSTALLATION_SUSPENDED", message: "This GitHub App installation is suspended. Ask its owner to restore access." });
      }
      if (String(verifiedInstallation.data.app_id) !== configuration.appId) {
        throw new ConvexError({
          code: "GITHUB_INSTALLER_MISMATCH",
          message: "The selected installation does not belong to this GitHub App.",
        });
      }
      const contract = githubInstallationContract({
        permissions: verifiedInstallation.data.permissions,
        events: verifiedInstallation.data.events,
      });
      if (contract.missingPermissions.length > 0) {
        throw new ConvexError({
          code: "GITHUB_INSTALLATION_UNDERSCOPED",
          message: `The GitHub App installation is missing required read access: ${contract.missingPermissions.join(", ")}. Approve the updated app permissions, then connect again.`,
        });
      }
      if (contract.missingEvents.length > 0) {
        throw new ConvexError({
          code: "GITHUB_APP_MISCONFIGURED",
          message: `The Code2Create GitHub App is missing required webhook subscriptions: ${contract.missingEvents.join(", ")}. Ask an organizer to update the app, then connect again.`,
        });
      }
      const account = verifiedInstallation.data.account;
      if (!account) {
        throw new ConvexError({
          code: "GITHUB_INSTALLER_MISMATCH",
          message: "The GitHub installation account could not be resolved.",
        });
      }
      const accountLogin = "login" in account ? account.login : account.slug;
      if (verifiedInstallation.data.target_type === "User" && account.id !== githubUser.data.id) {
        throw new ConvexError({ code: "GITHUB_ACCOUNT_MISMATCH", message: "Connect your own personal GitHub account, not another person's installation. You can also connect an organization you have access to." });
      }
      const result: {
        connectionId: Id<"githubInstallationConnections">;
        accountLogin: string;
      } = await ctx.runMutation(internal.githubIntegrations.finishSetupIntent, {
        eventSlug: args.eventSlug,
        intentId: claim.intentId,
        attemptId,
        installationId: String(verifiedInstallation.data.id),
        accountId: String(account.id),
        accountLogin,
        targetType: targetType(verifiedInstallation.data.target_type),
        repositorySelection: installationSelection(verifiedInstallation.data.repository_selection),
        accessTokenCiphertext: encryptProviderSecret(token.authentication.token),
        authorizationExpiresAt: Math.min(
          Date.now() + 8 * 60 * 60 * 1000,
          "expiresAt" in token.authentication && typeof token.authentication.expiresAt === "string"
            ? Date.parse(token.authentication.expiresAt)
            : Number.POSITIVE_INFINITY,
        ),
      });
      return { kind: "connected", connectionId: result.connectionId };
    } catch (error) {
      await ctx.runMutation(internal.githubIntegrations.failSetupIntent, {
        intentId: claim.intentId,
        attemptId,
        failureCode:
          error instanceof ConvexError ? "verification_rejected" : providerFailure(error).code,
      });
      if (error instanceof ConvexError) throw error;
      throw new ConvexError({
        code: "GITHUB_VERIFICATION_FAILED",
        message: "GitHub could not verify this installation. Start the connection again.",
      });
    }
  },
});

export const listAvailableRepositories = action({
  args: {
    eventSlug: v.string(),
    connectionId: v.id("githubInstallationConnections"),
    page: v.number(),
  },
  returns: v.object({
    repositories: v.array(
      v.object({
        repositoryId: v.string(),
        repositoryNodeId: v.string(),
        owner: v.string(),
        name: v.string(),
        fullName: v.string(),
        url: v.string(),
        isPrivate: v.boolean(),
        isFork: v.boolean(),
        defaultBranch: v.string(),
        pushedAt: v.optional(v.number()),
      }),
    ),
    totalCount: v.number(),
    nextPage: v.optional(v.number()),
  }),
  handler: async (ctx, args): Promise<AvailableRepositoryPage> => {
    if (!Number.isSafeInteger(args.page) || args.page < 1) {
      throw new ConvexError({
        code: "GITHUB_PAGE_INVALID",
        message: "The requested GitHub repository page is invalid.",
      });
    }
    const connection: ConnectionContext = await ctx.runQuery(
      internal.githubIntegrations.connectionContext,
      {
        eventSlug: args.eventSlug,
        connectionId: args.connectionId,
        serverNow: Date.now(),
      },
    );
    const octokit = new GitHubOctokit({ auth: decryptProviderSecret(connection.accessTokenCiphertext) });
    const response = await octokit.rest.apps.listInstallationReposForAuthenticatedUser({
      installation_id: safeGitHubId(connection.installationId, "Installation ID"),
      per_page: repositoryPageSize,
      page: args.page,
    });
    const totalCount = providerCount(response.data.total_count, "repository count");
    const repositories = response.data.repositories
      .map((repository): AvailableRepository => {
        const pushedAt = unixTime(repository.pushed_at);
        return {
          repositoryId: String(repository.id),
          repositoryNodeId: repository.node_id,
          owner: repository.owner.login,
          name: repository.name,
          fullName: repository.full_name,
          url: repository.html_url,
          isPrivate: repository.private,
          isFork: repository.fork,
          defaultBranch: repository.default_branch,
          ...(pushedAt !== undefined ? { pushedAt } : {}),
        };
      })
      .sort((left, right) => left.fullName.localeCompare(right.fullName));
    return {
      repositories,
      totalCount,
      ...(args.page < Math.ceil(totalCount / repositoryPageSize)
        ? { nextPage: args.page + 1 }
        : {}),
    };
  },
});

export const addRepository = action({
  args: {
    eventSlug: v.string(),
    connectionId: v.id("githubInstallationConnections"),
    repositoryId: v.string(),
    owner: v.string(),
    name: v.string(),
    kind: repositoryKind,
    customKind: v.optional(v.string()),
    purpose: v.string(),
    trackedBranch: v.string(),
    rootPath: v.optional(v.string()),
    clientOperationId: v.string(),
  },
  returns: v.object({ bindingId: v.id("githubRepositoryBindings") }),
  handler: async (ctx, args): Promise<{ bindingId: Id<"githubRepositoryBindings"> }> => {
    const prior = await ctx.runQuery(internal.githubIntegrations.repositoryAddReceipt, {
      eventSlug: args.eventSlug,
      connectionId: args.connectionId,
      repositoryId: args.repositoryId,
      kind: args.kind,
      ...(args.customKind !== undefined ? { customKind: args.customKind } : {}),
      purpose: args.purpose,
      trackedBranch: args.trackedBranch,
      ...(args.rootPath !== undefined ? { rootPath: args.rootPath } : {}),
      clientOperationId: args.clientOperationId,
    });
    if (prior) return prior;
    const connection: ConnectionContext = await ctx.runQuery(
      internal.githubIntegrations.connectionContext,
      {
        eventSlug: args.eventSlug,
        connectionId: args.connectionId,
        serverNow: Date.now(),
      },
    );
    const octokit = new GitHubOctokit({ auth: decryptProviderSecret(connection.accessTokenCiphertext) });
    // A user may have access through several installations. The chosen installation
    // must also cover this exact repository before it can become a team binding.
    const selectedInstallation = await repositoryOctokit(connection.installationId, args.repositoryId);
    await selectedInstallation.rest.repos.get({ owner: args.owner, repo: args.name });
    const [repository, topics, languages, branch] = await Promise.all([
      octokit.rest.repos.get({ owner: args.owner, repo: args.name }),
      octokit.rest.repos.getAllTopics({ owner: args.owner, repo: args.name }),
      octokit.rest.repos.listLanguages({ owner: args.owner, repo: args.name }),
      octokit.rest.repos.getBranch({
        owner: args.owner,
        repo: args.name,
        branch: args.trackedBranch,
      }),
    ]);
    if (String(repository.data.id) !== args.repositoryId) {
      throw new ConvexError({
        code: "REPOSITORY_CHANGED",
        message: "The selected GitHub repository no longer matches this request.",
      });
    }
    if (args.rootPath?.trim()) {
      await octokit.rest.repos.getContent({
        owner: repository.data.owner.login,
        repo: repository.data.name,
        path: args.rootPath.trim(),
        ref: branch.data.commit.sha,
      });
    }
    const providerCreatedAt = unixTime(repository.data.created_at);
    if (providerCreatedAt === undefined) {
      throw new ConvexError({
        code: "GITHUB_RESPONSE_INVALID",
        message: "GitHub did not return a valid repository creation time.",
      });
    }
    const providerCommitAt = unixTime(
      branch.data.commit.commit.committer?.date ?? branch.data.commit.commit.author?.date,
    );
    const result: { bindingId: Id<"githubRepositoryBindings"> } = await ctx.runMutation(
      internal.githubIntegrations.commitRepository,
      {
        eventSlug: args.eventSlug,
        connectionId: args.connectionId,
        integrationPolicyId: connection.integrationPolicyId,
        repositoryId: String(repository.data.id),
        repositoryNodeId: repository.data.node_id,
        owner: repository.data.owner.login,
        name: repository.data.name,
        fullName: repository.data.full_name,
        url: repository.data.html_url,
        isPrivate: repository.data.private,
        isFork: repository.data.fork,
        defaultBranch: repository.data.default_branch,
        providerCreatedAt,
        kind: args.kind,
        ...(args.customKind !== undefined ? { customKind: args.customKind } : {}),
        purpose: args.purpose,
        trackedBranch: args.trackedBranch,
        ...(args.rootPath !== undefined ? { rootPath: args.rootPath } : {}),
        topicState: topics.data.names.includes(connection.requiredGitHubTopic)
          ? "present"
          : "missing",
        headSha: branch.data.commit.sha,
        ...(providerCommitAt !== undefined ? { providerCommitAt } : {}),
        languageBytes: normalizedLanguages(languages.data),
        clientOperationId: args.clientOperationId,
      },
    );
    return result;
  },
});

export type GitHubConnectionId = Id<"githubInstallationConnections">;
