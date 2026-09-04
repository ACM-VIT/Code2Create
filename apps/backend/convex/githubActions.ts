"use node";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { ConvexError, v } from "convex/values";
import { RequestError } from "octokit";

import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import {
  GitHubOctokit,
  githubApp,
  githubConfiguration,
  installationOctokit,
  isGitHubRateLimit,
  repositoryOctokit,
  safeGitHubId,
} from "./lib/githubClient";
import { githubInstallationContract } from "./lib/githubInstallationContract";
import { repositoryKind } from "./values";

type SetupClaim =
  | { kind: "verify"; intentId: Id<"githubSetupIntents"> }
  | { kind: "completed"; connectionId: Id<"githubInstallationConnections"> };

type ConnectionContext = {
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

type RepositorySyncContext = {
  bindingId: Id<"githubRepositoryBindings">;
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
  trackedBranch: string;
  rootPath?: string;
  baselineSha: string;
  requiredTopic: string;
  syncRevision: number;
};

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
  args: { eventSlug: v.string() },
  returns: v.object({ installUrl: v.string() }),
  handler: async (ctx, args): Promise<{ installUrl: string }> => {
    const state = randomBytes(32).toString("base64url");
    await ctx.runMutation(internal.githubIntegrations.createSetupIntent, {
      eventSlug: args.eventSlug,
      stateDigest: opaqueDigest(state),
    });
    const installUrl = await githubApp().getInstallationUrl({ state });
    return { installUrl };
  },
});

export const completeConnection = action({
  args: {
    eventSlug: v.string(),
    state: v.string(),
    code: v.string(),
    installationId: v.string(),
  },
  returns: v.object({ connectionId: v.id("githubInstallationConnections") }),
  handler: async (ctx, args): Promise<{ connectionId: Id<"githubInstallationConnections"> }> => {
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
    if (claim.kind === "completed") return { connectionId: claim.connectionId };

    try {
      const configuration = githubConfiguration();
      const app = githubApp(configuration);
      const installationId = safeGitHubId(args.installationId, "Installation ID");
      const token = await app.oauth.createToken({ code: args.code });
      const userOctokit = new GitHubOctokit({ auth: token.authentication.token });
      await userOctokit.rest.apps.listInstallationReposForAuthenticatedUser({
        installation_id: installationId,
        per_page: 1,
        page: 1,
      });
      const verifiedInstallation = await app.octokit.rest.apps.getInstallation({
        installation_id: installationId,
      });
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
      });
      return { connectionId: result.connectionId };
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
        requireLiveEvent: false,
        serverNow: Date.now(),
      },
    );
    const octokit = await installationOctokit(connection.installationId);
    const response = await octokit.rest.apps.listReposAccessibleToInstallation({
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
        requireLiveEvent: true,
        serverNow: Date.now(),
      },
    );
    const octokit = await repositoryOctokit(connection.installationId, args.repositoryId);
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

export const reconcileRepository = internalAction({
  args: { bindingId: v.id("githubRepositoryBindings") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const leaseId = randomUUID();
    const sync: RepositorySyncContext | null = await ctx.runMutation(
      internal.githubIntegrations.beginRepositorySync,
      {
        bindingId: args.bindingId,
        leaseId,
      },
    );
    if (!sync) return null;
    try {
      const octokit = await repositoryOctokit(sync.installationId, sync.repositoryId);
      const [repository, topics, languages, branch] = await Promise.all([
        octokit.rest.repos.get({ owner: sync.owner, repo: sync.name }),
        octokit.rest.repos.getAllTopics({ owner: sync.owner, repo: sync.name }),
        octokit.rest.repos.listLanguages({ owner: sync.owner, repo: sync.name }),
        octokit.rest.repos.getBranch({
          owner: sync.owner,
          repo: sync.name,
          branch: sync.trackedBranch,
        }),
      ]);
      if (String(repository.data.id) !== sync.repositoryId) {
        throw new ConvexError({
          code: "REPOSITORY_ID_MISMATCH",
          message: "GitHub returned a different repository for this binding.",
        });
      }
      const headSha = branch.data.commit.sha;
      if (sync.rootPath) {
        await octokit.rest.repos.getContent({
          owner: repository.data.owner.login,
          repo: repository.data.name,
          path: sync.rootPath,
          ref: headSha,
        });
      }
      let commitCount = 0;
      let additions = 0;
      let deletions = 0;
      let changedFiles = 0;
      let compareTruncated = false;
      let observedCommitShas: string[] = [];
      let commitIdentityComplete = true;
      let completeness: "complete" | "partial" | "unknown" = "complete";
      if (headSha !== sync.baselineSha) {
        const comparison = await octokit.rest.repos.compareCommitsWithBasehead({
          owner: repository.data.owner.login,
          repo: repository.data.name,
          basehead: `${sync.baselineSha}...${headSha}`,
          per_page: 100,
          page: 1,
        });
        commitCount = providerCount(comparison.data.total_commits, "commit count");
        const files = comparison.data.files ?? [];
        const relevantFiles = sync.rootPath
          ? files.filter(
              (file) =>
                file.filename === sync.rootPath || file.filename.startsWith(`${sync.rootPath}/`),
            )
          : files;
        additions = relevantFiles.reduce(
          (total, file) => total + providerCount(file.additions, "addition count"),
          0,
        );
        deletions = relevantFiles.reduce(
          (total, file) => total + providerCount(file.deletions, "deletion count"),
          0,
        );
        changedFiles = relevantFiles.length;
        compareTruncated = files.length >= 300;
        const returnedCommitShas = comparison.data.commits.map((commit) => commit.sha);
        observedCommitShas = sync.rootPath ? [] : returnedCommitShas;
        commitIdentityComplete =
          commitCount === 0 || (!sync.rootPath && returnedCommitShas.length === commitCount);
        if (compareTruncated || sync.rootPath || !commitIdentityComplete) {
          completeness = "partial";
        }
      }
      const providerCommitAt = unixTime(
        branch.data.commit.commit.committer?.date ?? branch.data.commit.commit.author?.date,
      );
      await ctx.runMutation(internal.githubIntegrations.finishRepositorySync, {
        bindingId: sync.bindingId,
        leaseId,
        syncRevision: sync.syncRevision,
        repositoryId: String(repository.data.id),
        owner: repository.data.owner.login,
        name: repository.data.name,
        fullName: repository.data.full_name,
        url: repository.data.html_url,
        isPrivate: repository.data.private,
        isFork: repository.data.fork,
        defaultBranch: repository.data.default_branch,
        topicState: topics.data.names.includes(sync.requiredTopic) ? "present" : "missing",
        headSha,
        ...(providerCommitAt !== undefined ? { providerCommitAt } : {}),
        commitCount,
        additions,
        deletions,
        changedFiles,
        observedCommitShas,
        commitIdentityComplete,
        languageBytes: normalizedLanguages(languages.data),
        completeness,
        compareTruncated,
      });
    } catch (error) {
      const failure = providerFailure(error);
      await ctx.runMutation(internal.githubIntegrations.failRepositorySync, {
        bindingId: sync.bindingId,
        leaseId,
        state: failure.state,
        errorCode: failure.code,
      });
    }
    return null;
  },
});

export type GitHubConnectionId = Id<"githubInstallationConnections">;
