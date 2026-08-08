import { ConvexError, v, type Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { refreshGithubTeamMetrics } from "./lib/githubTeamMetrics";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { repositoryKind } from "./values";
import { integrationWorkpool } from "./workpools";

type ReadCtx = QueryCtx | MutationCtx;

const connectionTargetType = v.union(
  v.literal("User"),
  v.literal("Organization"),
  v.literal("Enterprise"),
);
const repositorySelection = v.union(v.literal("all"), v.literal("selected"));
const topicState = v.union(
  v.literal("present"),
  v.literal("missing"),
  v.literal("unknown"),
);
const metricCompleteness = v.union(
  v.literal("complete"),
  v.literal("partial"),
  v.literal("unknown"),
);
const languageBytes = v.array(v.object({ language: v.string(), bytes: v.number() }));

const currentView = v.union(
  v.null(),
  v.object({
    eventStatus: v.string(),
    teamId: v.id("teams"),
    teamStatus: v.string(),
    canManage: v.boolean(),
    githubConfigured: v.boolean(),
    policy: v.union(
      v.null(),
      v.object({
        id: v.id("integrationPolicyVersions"),
        policyVersion: v.string(),
        requiredGitHubTopic: v.string(),
        maxActiveRepositories: v.number(),
        githubFreezeAt: v.optional(v.number()),
      }),
    ),
    connections: v.array(
      v.object({
        id: v.id("githubInstallationConnections"),
        accountLogin: v.string(),
        targetType: connectionTargetType,
        repositorySelection,
        state: v.string(),
        version: v.number(),
        lastVerifiedAt: v.number(),
      }),
    ),
    repositories: v.array(
      v.object({
        id: v.id("githubRepositoryBindings"),
        installationConnectionId: v.id("githubInstallationConnections"),
        repositoryId: v.string(),
        owner: v.string(),
        name: v.string(),
        fullName: v.string(),
        url: v.string(),
        isPrivate: v.boolean(),
        isFork: v.boolean(),
        defaultBranch: v.string(),
        kind: repositoryKind,
        customKind: v.optional(v.string()),
        purpose: v.string(),
        trackedBranch: v.string(),
        rootPath: v.optional(v.string()),
        displayOrder: v.number(),
        requiredTopic: v.string(),
        topicState,
        state: v.string(),
        baselineSha: v.optional(v.string()),
        currentHeadSha: v.optional(v.string()),
        pendingHeadSha: v.optional(v.string()),
        lastWebhookAt: v.optional(v.number()),
        lastReconciledAt: v.optional(v.number()),
        syncState: v.string(),
        syncErrorCode: v.optional(v.string()),
        version: v.number(),
        metrics: v.object({
          pushCount: v.number(),
          commitCount: v.number(),
          additions: v.number(),
          deletions: v.number(),
          changedFiles: v.number(),
          languageBytes,
          completeness: metricCompleteness,
          compareTruncated: v.boolean(),
          lastProviderCommitAt: v.optional(v.number()),
          capturedAt: v.number(),
          version: v.number(),
        }),
      }),
    ),
    summary: v.union(
      v.null(),
      v.object({
        health: v.union(
          v.literal("not_connected"),
          v.literal("ready"),
          v.literal("syncing"),
          v.literal("needs_attention"),
        ),
        installationCount: v.number(),
        repositoryCount: v.number(),
        completeRepositoryCount: v.number(),
        topicPresentCount: v.number(),
        topicMissingCount: v.number(),
        topicUnknownCount: v.number(),
        kindCounts: v.array(v.object({ kind: repositoryKind, count: v.number() })),
        pushCount: v.number(),
        uniqueObservedCommitCount: v.number(),
        commitOverlapCount: v.number(),
        commitIdentityComplete: v.boolean(),
        additions: v.number(),
        deletions: v.number(),
        changedFiles: v.number(),
        languageBytes,
        completeness: metricCompleteness,
        incompleteRepositoryCount: v.number(),
        lastActivityAt: v.optional(v.number()),
        version: v.number(),
        updatedAt: v.number(),
      }),
    ),
  }),
);

async function currentTeamContext(ctx: ReadCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const membership = await requireMembership(ctx, event._id, person._id);
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", event._id)
        .eq("membershipId", membership._id)
        .eq("status", "active"),
    )
    .unique();
  if (!member) {
    throw new ConvexError({ code: "TEAM_REQUIRED", message: "Create or join a team first." });
  }
  const team = await ctx.db.get(member.teamId);
  if (!team) throw new Error("Team membership references a missing team.");
  return { event, person, subject, membership, member, team };
}

async function requirePublishedPolicy(ctx: ReadCtx, event: Doc<"events">) {
  const policyId = event.publishedIntegrationPolicyId;
  if (!policyId) {
    throw new ConvexError({
      code: "INTEGRATIONS_NOT_CONFIGURED",
      message: "The event has not published its integration policy yet.",
    });
  }
  const policy = await ctx.db.get(policyId);
  if (!policy || policy.eventId !== event._id || policy.status !== "published") {
    throw new ConvexError({
      code: "INTEGRATIONS_NOT_CONFIGURED",
      message: "The published integration policy is unavailable.",
    });
  }
  return policy;
}

function requireAdmittedTeam(team: Doc<"teams">) {
  const admitted = ["admitted", "confirmed", "checked_in", "active", "completed"].some(
    (status) => status === team.status,
  );
  if (!admitted) {
    throw new ConvexError({
      code: "TEAM_NOT_ADMITTED",
      message: "GitHub opens after the team is accepted.",
    });
  }
}

function requireGitHubWindow(
  event: Doc<"events">,
  team: Doc<"teams">,
  policy: Doc<"integrationPolicyVersions">,
  requireLiveEvent: boolean,
) {
  requireAdmittedTeam(team);
  if (requireLiveEvent && event.status !== "live") {
    throw new ConvexError({
      code: "BUILD_NOT_STARTED",
      message: "Repositories can be added after the official build start.",
    });
  }
  if (policy.githubFreezeAt !== undefined && Date.now() >= policy.githubFreezeAt) {
    throw new ConvexError({
      code: "GITHUB_FROZEN",
      message: "GitHub repository changes are frozen for this event.",
    });
  }
}

function normalizedRootPath(value: string | undefined) {
  const path = value?.trim();
  if (!path) return undefined;
  if (
    path.length > 240 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    path.split("/").some((segment) => segment === "." || segment === ".." || !segment)
  ) {
    throw new ConvexError({
      code: "ROOT_PATH_INVALID",
      message: "Use a relative repository folder without dot segments.",
    });
  }
  return path;
}

function normalizedKindLabel(kind: Doc<"githubRepositoryBindings">["kind"], value: string | undefined) {
  if (kind === "other") {
    return normalizedText(value ?? "", "Custom repository kind", 2, 50);
  }
  if (value?.trim()) {
    throw new ConvexError({
      code: "CUSTOM_KIND_NOT_ALLOWED",
      message: "A custom repository kind is only used with Other.",
    });
  }
  return undefined;
}

function normalizedObservedCommitShas(args: {
  values: string[];
  commitCount: number;
  complete: boolean;
}) {
  if (!Number.isSafeInteger(args.commitCount) || args.commitCount < 0) {
    throw new Error("GitHub returned an invalid commit count.");
  }
  if (args.values.length > 100) {
    throw new Error("GitHub returned more commit identities than the bounded comparison permits.");
  }
  const normalized = args.values.map((value) => value.toLowerCase());
  if (
    normalized.some((value) => !/^[a-f0-9]{40,64}$/.test(value)) ||
    new Set(normalized).size !== normalized.length ||
    normalized.length > args.commitCount ||
    (args.complete && normalized.length !== args.commitCount)
  ) {
    throw new Error("GitHub returned an inconsistent commit identity set.");
  }
  return normalized;
}

function githubEnvironmentConfigured() {
  return Boolean(
    process.env.GITHUB_APP_ID?.trim() &&
      process.env.GITHUB_APP_PRIVATE_KEY?.trim() &&
      process.env.GITHUB_APP_CLIENT_ID?.trim() &&
      process.env.GITHUB_APP_CLIENT_SECRET?.trim() &&
      process.env.GITHUB_WEBHOOK_SECRET?.trim(),
  );
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: currentView,
  handler: async (ctx, args) => {
    const person = await findCurrentPerson(ctx);
    if (!person) return null;
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!membership) return null;
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (!member) return null;
    const [team, subject] = await Promise.all([
      ctx.db.get(member.teamId),
      ctx.db.get(membership.eventAccessSubjectId),
    ]);
    if (!team || !subject || subject.status !== "active") return null;
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.read",
      scopeType: "team",
      scopeId: team._id,
    });
    const [policy, connections, bindings, teamMetric, manageGrantIds] = await Promise.all([
      event.publishedIntegrationPolicyId
        ? ctx.db.get(event.publishedIntegrationPolicyId)
        : Promise.resolve(null),
      ctx.db
        .query("githubInstallationConnections")
        .withIndex("by_team_state", (index) => index.eq("teamId", team._id))
        .collect(),
      ctx.db
        .query("githubRepositoryBindings")
        .withIndex("by_team_state", (index) => index.eq("teamId", team._id))
        .collect(),
      ctx.db
        .query("githubTeamMetrics")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique(),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "integration.github.manage",
        scopeType: "team",
        scopeId: team._id,
      }),
    ]);
    const visibleBindings = bindings
      .filter((binding) => binding.state !== "archived")
      .sort((left, right) => left.displayOrder - right.displayOrder);
    const metrics = await Promise.all(
      visibleBindings.map((binding) =>
        ctx.db
          .query("githubRepositoryMetrics")
          .withIndex("by_binding", (index) => index.eq("repositoryBindingId", binding._id))
          .unique(),
      ),
    );
    if (metrics.some((metric) => metric === null)) {
      throw new Error("A GitHub repository has no metrics projection.");
    }
    const resolvedMetrics = metrics.filter((metric) => metric !== null);
    if (
      teamMetric &&
      (teamMetric.eventId !== event._id ||
        teamMetric.teamId !== team._id ||
        teamMetric.repositoryCount !== visibleBindings.length)
    ) {
      throw new Error("The GitHub team summary does not match its repository set.");
    }
    if ((connections.length > 0 || visibleBindings.length > 0) && !teamMetric) {
      throw new Error("A connected GitHub team has no metrics summary.");
    }
    return {
      eventStatus: event.status,
      teamId: team._id,
      teamStatus: team.status,
      canManage: manageGrantIds.length > 0,
      githubConfigured: githubEnvironmentConfigured(),
      policy:
        policy && policy.eventId === event._id && policy.status === "published"
          ? {
              id: policy._id,
              policyVersion: policy.policyVersion,
              requiredGitHubTopic: policy.requiredGitHubTopic,
              maxActiveRepositories: policy.maxActiveGitHubRepositoriesPerTeam,
              ...(policy.githubFreezeAt !== undefined
                ? { githubFreezeAt: policy.githubFreezeAt }
                : {}),
            }
          : null,
      connections: connections.map((connection) => ({
        id: connection._id,
        accountLogin: connection.accountLogin,
        targetType: connection.targetType,
        repositorySelection: connection.repositorySelection,
        state: connection.state,
        version: connection.version,
        lastVerifiedAt: connection.lastVerifiedAt,
      })),
      repositories: visibleBindings.map((binding, index) => {
        const metric = resolvedMetrics[index];
        if (!metric) throw new Error("A validated GitHub repository metric is missing.");
        return {
          id: binding._id,
          installationConnectionId: binding.installationConnectionId,
          repositoryId: binding.repositoryId,
          owner: binding.owner,
          name: binding.name,
          fullName: binding.fullName,
          url: binding.url,
          isPrivate: binding.isPrivate,
          isFork: binding.isFork,
          defaultBranch: binding.defaultBranch,
          kind: binding.kind,
          ...(binding.customKind !== undefined ? { customKind: binding.customKind } : {}),
          purpose: binding.purpose,
          trackedBranch: binding.trackedBranch,
          ...(binding.rootPath !== undefined ? { rootPath: binding.rootPath } : {}),
          displayOrder: binding.displayOrder,
          requiredTopic: binding.requiredTopic,
          topicState: binding.topicState,
          state: binding.state,
          ...(binding.baselineSha !== undefined ? { baselineSha: binding.baselineSha } : {}),
          ...(binding.currentHeadSha !== undefined
            ? { currentHeadSha: binding.currentHeadSha }
            : {}),
          ...(binding.pendingHeadSha !== undefined
            ? { pendingHeadSha: binding.pendingHeadSha }
            : {}),
          ...(binding.lastWebhookAt !== undefined
            ? { lastWebhookAt: binding.lastWebhookAt }
            : {}),
          ...(binding.lastReconciledAt !== undefined
            ? { lastReconciledAt: binding.lastReconciledAt }
            : {}),
          syncState: binding.syncState,
          ...(binding.syncErrorCode !== undefined
            ? { syncErrorCode: binding.syncErrorCode }
            : {}),
          version: binding.version,
          metrics: {
            pushCount: metric.pushCount,
            commitCount: metric.commitCount,
            additions: metric.additions,
            deletions: metric.deletions,
            changedFiles: metric.changedFiles,
            languageBytes: metric.languageBytes,
            completeness: metric.completeness,
            compareTruncated: metric.compareTruncated,
            ...(metric.lastProviderCommitAt !== undefined
              ? { lastProviderCommitAt: metric.lastProviderCommitAt }
              : {}),
            capturedAt: metric.capturedAt,
            version: metric.version,
          },
        };
      }),
      summary: teamMetric
        ? {
            health: teamMetric.health,
            installationCount: teamMetric.installationCount,
            repositoryCount: teamMetric.repositoryCount,
            completeRepositoryCount: teamMetric.completeRepositoryCount,
            topicPresentCount: teamMetric.topicPresentCount,
            topicMissingCount: teamMetric.topicMissingCount,
            topicUnknownCount: teamMetric.topicUnknownCount,
            kindCounts: teamMetric.kindCounts,
            pushCount: teamMetric.pushCount,
            uniqueObservedCommitCount: teamMetric.uniqueObservedCommitCount,
            commitOverlapCount: teamMetric.commitOverlapCount,
            commitIdentityComplete: teamMetric.commitIdentityComplete,
            additions: teamMetric.additions,
            deletions: teamMetric.deletions,
            changedFiles: teamMetric.changedFiles,
            languageBytes: teamMetric.languageBytes,
            completeness: teamMetric.completeness,
            incompleteRepositoryCount: teamMetric.incompleteRepositoryCount,
            ...(teamMetric.lastActivityAt !== undefined
              ? { lastActivityAt: teamMetric.lastActivityAt }
              : {}),
            version: teamMetric.version,
            updatedAt: teamMetric.updatedAt,
          }
        : null,
    };
  },
});

export const createSetupIntent = internalMutation({
  args: {
    eventSlug: v.string(),
    stateDigest: v.string(),
  },
  returns: v.object({ intentId: v.id("githubSetupIntents") }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const policy = await requirePublishedPolicy(ctx, event);
    requireGitHubWindow(event, team, policy, false);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.github.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const collision = await ctx.db
      .query("githubSetupIntents")
      .withIndex("by_state_digest", (index) => index.eq("stateDigest", args.stateDigest))
      .unique();
    if (collision) throw new Error("GitHub setup state collision.");
    const now = Date.now();
    const intentId = await ctx.db.insert("githubSetupIntents", {
      eventId: event._id,
      teamId: team._id,
      personId: person._id,
      stateDigest: args.stateDigest,
      returnPath: "/integrations",
      status: "pending",
      expiresAt: now + 10 * 60 * 1_000,
      createdAt: now,
    });
    return { intentId };
  },
});

const setupClaim = v.union(
  v.object({
    kind: v.literal("verify"),
    intentId: v.id("githubSetupIntents"),
  }),
  v.object({
    kind: v.literal("completed"),
    connectionId: v.id("githubInstallationConnections"),
  }),
);
type SetupClaim = Infer<typeof setupClaim>;

export const claimSetupIntent = internalMutation({
  args: {
    eventSlug: v.string(),
    stateDigest: v.string(),
    attemptId: v.string(),
  },
  returns: setupClaim,
  handler: async (ctx, args): Promise<SetupClaim> => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.github.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const intent = await ctx.db
      .query("githubSetupIntents")
      .withIndex("by_state_digest", (index) => index.eq("stateDigest", args.stateDigest))
      .unique();
    if (!intent || intent.eventId !== event._id || intent.teamId !== team._id || intent.personId !== person._id) {
      throw new ConvexError({ code: "SETUP_INVALID", message: "This GitHub setup link is invalid." });
    }
    if (intent.status === "completed" && intent.installationConnectionId) {
      return { kind: "completed", connectionId: intent.installationConnectionId };
    }
    const now = Date.now();
    if (intent.expiresAt <= now) {
      if (intent.status !== "expired") await ctx.db.patch(intent._id, { status: "expired" });
      throw new ConvexError({ code: "SETUP_EXPIRED", message: "Start the GitHub connection again." });
    }
    if (intent.status === "verifying" && (intent.claimExpiresAt ?? 0) > now) {
      throw new ConvexError({
        code: "SETUP_IN_PROGRESS",
        message: "This GitHub connection is already being verified.",
      });
    }
    if (intent.status === "failed") {
      throw new ConvexError({ code: "SETUP_FAILED", message: "Start the GitHub connection again." });
    }
    await ctx.db.patch(intent._id, {
      status: "verifying",
      attemptId: args.attemptId,
      claimExpiresAt: now + 2 * 60 * 1_000,
    });
    return { kind: "verify", intentId: intent._id };
  },
});

export const finishSetupIntent = internalMutation({
  args: {
    eventSlug: v.string(),
    intentId: v.id("githubSetupIntents"),
    attemptId: v.string(),
    installationId: v.string(),
    accountId: v.string(),
    accountLogin: v.string(),
    targetType: connectionTargetType,
    repositorySelection,
  },
  returns: v.object({
    connectionId: v.id("githubInstallationConnections"),
    accountLogin: v.string(),
  }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const policy = await requirePublishedPolicy(ctx, event);
    requireGitHubWindow(event, team, policy, false);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.github.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const intent = await ctx.db.get(args.intentId);
    if (
      !intent ||
      intent.eventId !== event._id ||
      intent.teamId !== team._id ||
      intent.personId !== person._id ||
      intent.status !== "verifying" ||
      intent.attemptId !== args.attemptId ||
      intent.expiresAt <= Date.now()
    ) {
      throw new ConvexError({ code: "SETUP_STALE", message: "Start the GitHub connection again." });
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("githubInstallationConnections")
      .withIndex("by_team_installation", (index) =>
        index.eq("teamId", team._id).eq("installationId", args.installationId),
      )
      .unique();
    let connectionId: Id<"githubInstallationConnections">;
    if (existing) {
      connectionId = existing._id;
      await ctx.db.patch(existing._id, {
        accountId: args.accountId,
        accountLogin: normalizedText(args.accountLogin, "GitHub account", 1, 120),
        targetType: args.targetType,
        repositorySelection: args.repositorySelection,
        state: "active",
        lastVerifiedAt: now,
        version: existing.version + 1,
      });
    } else {
      connectionId = await ctx.db.insert("githubInstallationConnections", {
        eventId: event._id,
        teamId: team._id,
        installationId: args.installationId,
        accountId: args.accountId,
        accountLogin: normalizedText(args.accountLogin, "GitHub account", 1, 120),
        targetType: args.targetType,
        repositorySelection: args.repositorySelection,
        state: "active",
        connectedByPersonId: person._id,
        connectedAt: now,
        lastVerifiedAt: now,
        version: 1,
      });
    }
    await ctx.db.patch(intent._id, {
      status: "completed",
      installationConnectionId: connectionId,
      completedAt: now,
      claimExpiresAt: undefined,
    });
    await refreshGithubTeamMetrics(ctx, {
      eventId: event._id,
      teamId: team._id,
      now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.github.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: existing ? "github.installation_reconnected" : "github.installation_connected",
      targetType: "github_installation_connection",
      targetId: connectionId,
      nextSummary: JSON.stringify({
        accountLogin: args.accountLogin,
        targetType: args.targetType,
        repositorySelection: args.repositorySelection,
      }),
      reason: "Connected a GitHub App installation to the team",
    });
    return { connectionId, accountLogin: args.accountLogin };
  },
});

export const failSetupIntent = internalMutation({
  args: {
    intentId: v.id("githubSetupIntents"),
    attemptId: v.string(),
    failureCode: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (intent?.status === "verifying" && intent.attemptId === args.attemptId) {
      await ctx.db.patch(intent._id, {
        status: "failed",
        failureCode: args.failureCode,
        completedAt: Date.now(),
        claimExpiresAt: undefined,
      });
    }
    return null;
  },
});

export const connectionContext = internalQuery({
  args: {
    eventSlug: v.string(),
    connectionId: v.id("githubInstallationConnections"),
    requireLiveEvent: v.boolean(),
  },
  returns: v.object({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    installationId: v.string(),
    integrationPolicyId: v.id("integrationPolicyVersions"),
    requiredGitHubTopic: v.string(),
    maxActiveRepositories: v.number(),
  }),
  handler: async (ctx, args) => {
    const { event, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const policy = await requirePublishedPolicy(ctx, event);
    requireGitHubWindow(event, team, policy, args.requireLiveEvent);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.github.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.teamId !== team._id || connection.state !== "active") {
      throw new ConvexError({
        code: "GITHUB_CONNECTION_UNAVAILABLE",
        message: "Reconnect this GitHub account before continuing.",
      });
    }
    return {
      eventId: event._id,
      teamId: team._id,
      installationId: connection.installationId,
      integrationPolicyId: policy._id,
      requiredGitHubTopic: policy.requiredGitHubTopic,
      maxActiveRepositories: policy.maxActiveGitHubRepositoriesPerTeam,
    };
  },
});

export const commitRepository = internalMutation({
  args: {
    eventSlug: v.string(),
    connectionId: v.id("githubInstallationConnections"),
    integrationPolicyId: v.id("integrationPolicyVersions"),
    repositoryId: v.string(),
    repositoryNodeId: v.string(),
    owner: v.string(),
    name: v.string(),
    fullName: v.string(),
    url: v.string(),
    isPrivate: v.boolean(),
    isFork: v.boolean(),
    defaultBranch: v.string(),
    providerCreatedAt: v.number(),
    kind: repositoryKind,
    customKind: v.optional(v.string()),
    purpose: v.string(),
    trackedBranch: v.string(),
    rootPath: v.optional(v.string()),
    topicState,
    headSha: v.string(),
    providerCommitAt: v.optional(v.number()),
    languageBytes,
    clientOperationId: v.string(),
  },
  returns: v.object({ bindingId: v.id("githubRepositoryBindings") }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const requestFingerprint = operationFingerprint([
      args.connectionId,
      args.integrationPolicyId,
      args.repositoryId,
      args.kind,
      args.customKind ?? null,
      args.purpose,
      args.trackedBranch,
      args.rootPath ?? null,
      args.headSha,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "github.repository.add",
      requestFingerprint,
    });
    if (priorOperation) {
      const bindingId = ctx.db.normalizeId("githubRepositoryBindings", priorOperation.targetId);
      if (!bindingId) throw new Error("The prior GitHub repository result is invalid.");
      return { bindingId };
    }
    const policy = await requirePublishedPolicy(ctx, event);
    if (policy._id !== args.integrationPolicyId) {
      throw new ConvexError({
        code: "INTEGRATION_POLICY_CHANGED",
        message: "The integration policy changed. Review it and try again.",
      });
    }
    requireGitHubWindow(event, team, policy, true);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.github.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.teamId !== team._id || connection.state !== "active") {
      throw new ConvexError({
        code: "GITHUB_CONNECTION_UNAVAILABLE",
        message: "Reconnect this GitHub account before adding a repository.",
      });
    }
    const currentBindings = await ctx.db
      .query("githubRepositoryBindings")
      .withIndex("by_team_state", (index) => index.eq("teamId", team._id))
      .collect();
    const activeBindings = currentBindings.filter((binding) => binding.state !== "archived");
    if (activeBindings.length >= policy.maxActiveGitHubRepositoriesPerTeam) {
      throw new ConvexError({
        code: "REPOSITORY_LIMIT",
        message: `This event allows ${policy.maxActiveGitHubRepositoriesPerTeam} active repositories per team.`,
      });
    }
    const eventBindings = await ctx.db
      .query("githubRepositoryBindings")
      .withIndex("by_event_repository", (index) =>
        index.eq("eventId", event._id).eq("repositoryId", args.repositoryId),
      )
      .collect();
    const occupied = eventBindings.find((binding) => binding.state !== "archived");
    if (occupied) {
      throw new ConvexError({
        code: occupied.teamId === team._id ? "REPOSITORY_ALREADY_ADDED" : "REPOSITORY_IN_USE",
        message:
          occupied.teamId === team._id
            ? "This repository is already part of the team."
            : "This repository is already connected to another team in this event.",
      });
    }
    const customKind = normalizedKindLabel(args.kind, args.customKind);
    const rootPath = normalizedRootPath(args.rootPath);
    const purpose = normalizedText(args.purpose, "Repository purpose", 3, 180);
    const trackedBranch = normalizedText(args.trackedBranch, "Tracked branch", 1, 255);
    const now = Date.now();
    const nextDisplayOrder =
      activeBindings.reduce((highest, binding) => Math.max(highest, binding.displayOrder), 0) + 1;
    const bindingId = await ctx.db.insert("githubRepositoryBindings", {
      eventId: event._id,
      teamId: team._id,
      installationConnectionId: connection._id,
      repositoryId: args.repositoryId,
      repositoryNodeId: args.repositoryNodeId,
      owner: normalizedText(args.owner, "Repository owner", 1, 120),
      name: normalizedText(args.name, "Repository name", 1, 120),
      fullName: normalizedText(args.fullName, "Repository name", 3, 240),
      url: args.url,
      isPrivate: args.isPrivate,
      isFork: args.isFork,
      defaultBranch: normalizedText(args.defaultBranch, "Default branch", 1, 255),
      kind: args.kind,
      ...(customKind !== undefined ? { customKind } : {}),
      purpose,
      trackedBranch,
      ...(rootPath !== undefined ? { rootPath } : {}),
      displayOrder: nextDisplayOrder,
      requiredTopic: policy.requiredGitHubTopic,
      topicState: args.topicState,
      state: "active",
      baselineSha: args.headSha,
      currentHeadSha: args.headSha,
      lastReconciledAt: now,
      syncRevision: 1,
      syncedRevision: 1,
      syncState: "ready",
      version: 1,
      providerCreatedAt: args.providerCreatedAt,
      connectedAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("githubRepositoryMetrics", {
      eventId: event._id,
      teamId: team._id,
      repositoryBindingId: bindingId,
      baselineSha: args.headSha,
      currentHeadSha: args.headSha,
      pushCount: 0,
      commitCount: 0,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      observedCommitShas: [],
      commitIdentityComplete: true,
      languageBytes: args.languageBytes,
      completeness: "complete",
      compareTruncated: false,
      ...(args.providerCommitAt !== undefined
        ? { lastProviderCommitAt: args.providerCommitAt }
        : {}),
      capturedAt: now,
      version: 1,
    });
    await ctx.db.insert("githubRepositorySnapshots", {
      eventId: event._id,
      teamId: team._id,
      repositoryBindingId: bindingId,
      reason: "baseline",
      headSha: args.headSha,
      topicState: args.topicState,
      commitCount: 0,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      observedCommitShas: [],
      commitIdentityComplete: true,
      languageBytes: args.languageBytes,
      completeness: "complete",
      compareTruncated: false,
      ...(args.providerCommitAt !== undefined ? { providerCommitAt: args.providerCommitAt } : {}),
      capturedAt: now,
    });
    await refreshGithubTeamMetrics(ctx, {
      eventId: event._id,
      teamId: team._id,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "github.repository.add",
      requestFingerprint,
      targetType: "github_repository_binding",
      targetId: bindingId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.github.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "github.repository_added",
      targetType: "github_repository_binding",
      targetId: bindingId,
      nextSummary: JSON.stringify({
        repositoryId: args.repositoryId,
        fullName: args.fullName,
        kind: args.kind,
        trackedBranch,
        rootPath: rootPath ?? null,
        baselineSha: args.headSha,
        topicState: args.topicState,
      }),
      reason: "Added a team repository at its event baseline",
    });
    return { bindingId };
  },
});

export const refreshRepository = mutation({
  args: {
    eventSlug: v.string(),
    bindingId: v.id("githubRepositoryBindings"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ bindingId: v.id("githubRepositoryBindings"), syncRevision: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const requestFingerprint = operationFingerprint([
      args.bindingId,
      args.expectedVersion,
      args.reason,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "github.repository.refresh",
      requestFingerprint,
    });
    if (priorOperation) {
      const binding = await ctx.db.get(args.bindingId);
      if (!binding) throw new Error("The prior repository refresh no longer resolves.");
      return { bindingId: binding._id, syncRevision: binding.syncRevision };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.github.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const binding = await ctx.db.get(args.bindingId);
    if (!binding || binding.teamId !== team._id || binding.state !== "active") {
      throw new ConvexError({ code: "REPOSITORY_UNAVAILABLE", message: "This repository is unavailable." });
    }
    if (binding.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "REPOSITORY_CHANGED",
        message: "The repository changed in another session. Review it and try again.",
      });
    }
    const reason = normalizedText(args.reason, "Refresh reason", 3, 180);
    const now = Date.now();
    const syncRevision = binding.syncRevision + 1;
    await ctx.db.patch(binding._id, {
      syncRevision,
      syncState: "pending",
      syncErrorCode: undefined,
      version: binding.version + 1,
      updatedAt: now,
    });
    await refreshGithubTeamMetrics(ctx, {
      eventId: event._id,
      teamId: team._id,
      now,
    });
    await integrationWorkpool.enqueueAction(
      ctx,
      internal.githubActions.reconcileRepository,
      { bindingId: binding._id },
      { retry: false },
    );
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "github.repository.refresh",
      requestFingerprint,
      targetType: "github_repository_binding",
      targetId: binding._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.github.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "github.repository_refresh_requested",
      targetType: "github_repository_binding",
      targetId: binding._id,
      previousSummary: JSON.stringify({
        syncRevision: binding.syncRevision,
        syncState: binding.syncState,
      }),
      nextSummary: JSON.stringify({ syncRevision, syncState: "pending" }),
      reason,
    });
    return { bindingId: binding._id, syncRevision };
  },
});

type RepositoryOrderEntry = {
  bindingId: Id<"githubRepositoryBindings">;
  expectedVersion: number;
};

export async function reorderTeamRepositories(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    orderedRepositories: RepositoryOrderEntry[];
    now: number;
  },
) {
  if (args.orderedRepositories.length === 0) {
    throw new ConvexError({
      code: "REPOSITORY_ORDER_EMPTY",
      message: "Add a repository before changing the repository order.",
    });
  }
  const requestedIds = new Set(args.orderedRepositories.map((entry) => entry.bindingId));
  if (requestedIds.size !== args.orderedRepositories.length) {
    throw new ConvexError({
      code: "REPOSITORY_ORDER_INVALID",
      message: "Each repository must appear exactly once in the new order.",
    });
  }
  const teamBindings = await ctx.db
    .query("githubRepositoryBindings")
    .withIndex("by_team_state", (index) => index.eq("teamId", args.teamId))
    .collect();
  const currentBindings = teamBindings.filter((binding) => binding.state !== "archived");
  if (
    currentBindings.length !== args.orderedRepositories.length ||
    currentBindings.some(
      (binding) => binding.eventId !== args.eventId || !requestedIds.has(binding._id),
    )
  ) {
    throw new ConvexError({
      code: "REPOSITORY_SET_CHANGED",
      message: "The team repository set changed in another session. Review it and try again.",
    });
  }
  const bindingsById = new Map(currentBindings.map((binding) => [binding._id, binding]));
  for (const entry of args.orderedRepositories) {
    if (!Number.isSafeInteger(entry.expectedVersion) || entry.expectedVersion < 1) {
      throw new ConvexError({
        code: "REPOSITORY_ORDER_INVALID",
        message: "The repository order contains an invalid version.",
      });
    }
    const binding = bindingsById.get(entry.bindingId);
    if (!binding || binding.version !== entry.expectedVersion) {
      throw new ConvexError({
        code: "REPOSITORY_CHANGED",
        message: "A repository changed in another session. Review the list and try again.",
      });
    }
  }
  const previousOrder = currentBindings
    .toSorted((left, right) => left.displayOrder - right.displayOrder)
    .map((binding) => binding._id);
  const updatedBindingIds: Id<"githubRepositoryBindings">[] = [];
  for (const [index, entry] of args.orderedRepositories.entries()) {
    const binding = bindingsById.get(entry.bindingId);
    if (!binding) throw new Error("A validated GitHub repository binding is missing.");
    const displayOrder = index + 1;
    if (binding.displayOrder === displayOrder) continue;
    await ctx.db.patch(binding._id, {
      displayOrder,
      version: binding.version + 1,
      updatedAt: args.now,
    });
    updatedBindingIds.push(binding._id);
  }
  return {
    previousOrder,
    nextOrder: args.orderedRepositories.map((entry) => entry.bindingId),
    updatedBindingIds,
  };
}

export const reorderRepositories = mutation({
  args: {
    eventSlug: v.string(),
    orderedRepositories: v.array(
      v.object({
        bindingId: v.id("githubRepositoryBindings"),
        expectedVersion: v.number(),
      }),
    ),
    clientOperationId: v.string(),
  },
  returns: v.object({
    teamId: v.id("teams"),
    orderedRepositoryIds: v.array(v.id("githubRepositoryBindings")),
  }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const requestFingerprint = operationFingerprint(
      args.orderedRepositories.flatMap((entry) => [entry.bindingId, entry.expectedVersion]),
    );
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "github.repositories.reorder",
      requestFingerprint,
    });
    if (priorOperation) {
      return {
        teamId: team._id,
        orderedRepositoryIds: args.orderedRepositories.map((entry) => entry.bindingId),
      };
    }
    const policy = await requirePublishedPolicy(ctx, event);
    requireGitHubWindow(event, team, policy, false);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.github.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const now = Date.now();
    const result = await reorderTeamRepositories(ctx, {
      eventId: event._id,
      teamId: team._id,
      orderedRepositories: args.orderedRepositories,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "github.repositories.reorder",
      requestFingerprint,
      targetType: "team",
      targetId: team._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.github.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "github.repositories_reordered",
      targetType: "team",
      targetId: team._id,
      previousSummary: JSON.stringify({ repositoryBindingIds: result.previousOrder }),
      nextSummary: JSON.stringify({ repositoryBindingIds: result.nextOrder }),
      reason: "Team reordered its repository list",
    });
    return {
      teamId: team._id,
      orderedRepositoryIds: result.nextOrder,
    };
  },
});

export const archiveRepository = mutation({
  args: {
    eventSlug: v.string(),
    bindingId: v.id("githubRepositoryBindings"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ bindingId: v.id("githubRepositoryBindings") }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const requestFingerprint = operationFingerprint([
      args.bindingId,
      args.expectedVersion,
      args.reason,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "github.repository.archive",
      requestFingerprint,
    });
    if (priorOperation) return { bindingId: args.bindingId };
    const policy = await requirePublishedPolicy(ctx, event);
    requireGitHubWindow(event, team, policy, false);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.github.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const binding = await ctx.db.get(args.bindingId);
    if (!binding || binding.teamId !== team._id || binding.state === "archived") {
      throw new ConvexError({ code: "REPOSITORY_UNAVAILABLE", message: "This repository is unavailable." });
    }
    if (binding.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "REPOSITORY_CHANGED",
        message: "The repository changed in another session. Review it and try again.",
      });
    }
    const reason = normalizedText(args.reason, "Archive reason", 3, 180);
    const now = Date.now();
    await ctx.db.patch(binding._id, {
      state: "archived",
      syncState: "ready",
      syncLeaseId: undefined,
      syncLeaseExpiresAt: undefined,
      version: binding.version + 1,
      updatedAt: now,
    });
    await refreshGithubTeamMetrics(ctx, {
      eventId: event._id,
      teamId: team._id,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "github.repository.archive",
      requestFingerprint,
      targetType: "github_repository_binding",
      targetId: binding._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.github.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "github.repository_archived",
      targetType: "github_repository_binding",
      targetId: binding._id,
      previousSummary: JSON.stringify({ state: binding.state, version: binding.version }),
      nextSummary: JSON.stringify({ state: "archived", version: binding.version + 1 }),
      reason,
    });
    return { bindingId: binding._id };
  },
});

export const beginRepositorySync = internalMutation({
  args: {
    bindingId: v.id("githubRepositoryBindings"),
    leaseId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      bindingId: v.id("githubRepositoryBindings"),
      installationId: v.string(),
      repositoryId: v.string(),
      owner: v.string(),
      name: v.string(),
      trackedBranch: v.string(),
      rootPath: v.optional(v.string()),
      baselineSha: v.string(),
      requiredTopic: v.string(),
      syncRevision: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (!binding || binding.state !== "active" || !binding.baselineSha) return null;
    if (binding.syncedRevision >= binding.syncRevision) return null;
    const now = Date.now();
    if (
      binding.syncState === "running" &&
      binding.syncLeaseId &&
      (binding.syncLeaseExpiresAt ?? 0) > now
    ) {
      return null;
    }
    const connection = await ctx.db.get(binding.installationConnectionId);
    if (!connection || connection.state !== "active") {
      await ctx.db.patch(binding._id, {
        state: "inaccessible",
        syncState: "error",
        syncErrorCode: "installation_unavailable",
        syncLeaseId: undefined,
        syncLeaseExpiresAt: undefined,
        version: binding.version + 1,
        updatedAt: now,
      });
      await refreshGithubTeamMetrics(ctx, {
        eventId: binding.eventId,
        teamId: binding.teamId,
        now,
      });
      return null;
    }
    await ctx.db.patch(binding._id, {
      syncState: "running",
      syncLeaseId: args.leaseId,
      syncLeaseExpiresAt: now + 2 * 60 * 1_000,
      syncErrorCode: undefined,
    });
    await refreshGithubTeamMetrics(ctx, {
      eventId: binding.eventId,
      teamId: binding.teamId,
      now,
    });
    return {
      bindingId: binding._id,
      installationId: connection.installationId,
      repositoryId: binding.repositoryId,
      owner: binding.owner,
      name: binding.name,
      trackedBranch: binding.trackedBranch,
      ...(binding.rootPath !== undefined ? { rootPath: binding.rootPath } : {}),
      baselineSha: binding.baselineSha,
      requiredTopic: binding.requiredTopic,
      syncRevision: binding.syncRevision,
    };
  },
});

export const finishRepositorySync = internalMutation({
  args: {
    bindingId: v.id("githubRepositoryBindings"),
    leaseId: v.string(),
    syncRevision: v.number(),
    repositoryId: v.string(),
    owner: v.string(),
    name: v.string(),
    fullName: v.string(),
    url: v.string(),
    isPrivate: v.boolean(),
    isFork: v.boolean(),
    defaultBranch: v.string(),
    topicState,
    headSha: v.string(),
    providerCommitAt: v.optional(v.number()),
    commitCount: v.number(),
    additions: v.number(),
    deletions: v.number(),
    changedFiles: v.number(),
    observedCommitShas: v.array(v.string()),
    commitIdentityComplete: v.boolean(),
    languageBytes,
    completeness: metricCompleteness,
    compareTruncated: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (
      !binding ||
      binding.state !== "active" ||
      binding.syncState !== "running" ||
      binding.syncLeaseId !== args.leaseId ||
      binding.repositoryId !== args.repositoryId
    ) {
      return null;
    }
    const now = Date.now();
    const metric = await ctx.db
      .query("githubRepositoryMetrics")
      .withIndex("by_binding", (index) => index.eq("repositoryBindingId", binding._id))
      .unique();
    if (!metric) throw new Error("GitHub repository metrics are missing.");
    for (const value of [args.additions, args.deletions, args.changedFiles]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("GitHub returned an invalid repository metric.");
      }
    }
    const observedCommitShas = normalizedObservedCommitShas({
      values: args.observedCommitShas,
      commitCount: args.commitCount,
      complete: args.commitIdentityComplete,
    });
    const syncedRevision = Math.max(binding.syncedRevision, args.syncRevision);
    const dirty = binding.syncRevision > syncedRevision;
    await ctx.db.patch(binding._id, {
      owner: args.owner,
      name: args.name,
      fullName: args.fullName,
      url: args.url,
      isPrivate: args.isPrivate,
      isFork: args.isFork,
      defaultBranch: args.defaultBranch,
      topicState: args.topicState,
      currentHeadSha: args.headSha,
      pendingHeadSha: undefined,
      lastReconciledAt: now,
      syncedRevision,
      syncState: dirty ? "pending" : "ready",
      syncLeaseId: undefined,
      syncLeaseExpiresAt: undefined,
      syncErrorCode: undefined,
      version: binding.version + 1,
      updatedAt: now,
    });
    await ctx.db.patch(metric._id, {
      currentHeadSha: args.headSha,
      commitCount: args.commitCount,
      additions: args.additions,
      deletions: args.deletions,
      changedFiles: args.changedFiles,
      observedCommitShas,
      commitIdentityComplete: args.commitIdentityComplete,
      languageBytes: args.languageBytes,
      completeness: args.completeness,
      compareTruncated: args.compareTruncated,
      ...(args.providerCommitAt !== undefined
        ? { lastProviderCommitAt: args.providerCommitAt }
        : {}),
      capturedAt: now,
      version: metric.version + 1,
    });
    const previousSnapshot = await ctx.db
      .query("githubRepositorySnapshots")
      .withIndex("by_binding_time", (index) =>
        index.eq("repositoryBindingId", binding._id),
      )
      .order("desc")
      .first();
    await ctx.db.insert("githubRepositorySnapshots", {
      eventId: binding.eventId,
      teamId: binding.teamId,
      repositoryBindingId: binding._id,
      ...(previousSnapshot ? { previousSnapshotId: previousSnapshot._id } : {}),
      reason: "reconcile",
      headSha: args.headSha,
      topicState: args.topicState,
      commitCount: args.commitCount,
      additions: args.additions,
      deletions: args.deletions,
      changedFiles: args.changedFiles,
      observedCommitShas,
      commitIdentityComplete: args.commitIdentityComplete,
      languageBytes: args.languageBytes,
      completeness: args.completeness,
      compareTruncated: args.compareTruncated,
      ...(args.providerCommitAt !== undefined ? { providerCommitAt: args.providerCommitAt } : {}),
      capturedAt: now,
    });
    await refreshGithubTeamMetrics(ctx, {
      eventId: binding.eventId,
      teamId: binding.teamId,
      now,
    });
    if (dirty) {
      await integrationWorkpool.enqueueAction(
        ctx,
        internal.githubActions.reconcileRepository,
        { bindingId: binding._id },
        { retry: false },
      );
    }
    return null;
  },
});

export const failRepositorySync = internalMutation({
  args: {
    bindingId: v.id("githubRepositoryBindings"),
    leaseId: v.string(),
    state: v.union(v.literal("rate_limited"), v.literal("error")),
    errorCode: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (binding?.syncLeaseId === args.leaseId && binding.syncState === "running") {
      const now = Date.now();
      await ctx.db.patch(binding._id, {
        syncState: args.state,
        syncErrorCode: args.errorCode,
        syncLeaseId: undefined,
        syncLeaseExpiresAt: undefined,
        version: binding.version + 1,
        updatedAt: now,
      });
      await refreshGithubTeamMetrics(ctx, {
        eventId: binding.eventId,
        teamId: binding.teamId,
        now,
      });
    }
    return null;
  },
});

const webhookEvent = v.union(
  v.object({
    kind: v.literal("push"),
    installationId: v.string(),
    repositoryId: v.string(),
    ref: v.string(),
    beforeSha: v.string(),
    afterSha: v.string(),
    created: v.boolean(),
    deleted: v.boolean(),
    forced: v.boolean(),
    pushedCommitCount: v.number(),
    providerAt: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("installation"),
    installationId: v.string(),
    action: v.string(),
  }),
  v.object({
    kind: v.literal("installation_repositories"),
    installationId: v.string(),
    action: v.string(),
    addedRepositoryIds: v.array(v.string()),
    removedRepositoryIds: v.array(v.string()),
  }),
  v.object({ kind: v.literal("ping") }),
);

export const acceptWebhook = internalMutation({
  args: {
    deliveryId: v.string(),
    eventName: v.string(),
    payloadHash: v.string(),
    event: webhookEvent,
  },
  returns: v.object({ duplicate: v.boolean(), affectedBindings: v.number() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("githubWebhookDeliveries")
      .withIndex("by_delivery", (index) => index.eq("deliveryId", args.deliveryId))
      .unique();
    if (existing) {
      if (existing.payloadHash !== args.payloadHash || existing.eventName !== args.eventName) {
        throw new ConvexError({
          code: "DELIVERY_COLLISION",
          message: "A GitHub delivery ID was reused with different content.",
        });
      }
      return { duplicate: true, affectedBindings: 0 };
    }
    const now = Date.now();
    if (args.event.kind === "ping") {
      await ctx.db.insert("githubWebhookDeliveries", {
        deliveryId: args.deliveryId,
        eventName: args.eventName,
        payloadHash: args.payloadHash,
        state: "accepted",
        reasonCode: "ping",
        receivedAt: now,
      });
      return { duplicate: false, affectedBindings: 0 };
    }
    const installationId = args.event.installationId;
    const connections = await ctx.db
      .query("githubInstallationConnections")
      .withIndex("by_installation_state", (index) =>
        index.eq("installationId", installationId).eq("state", "active"),
      )
      .collect();
    let affectedBindings = 0;
    const affectedTeams = new Map<Id<"teams">, Id<"events">>();
    if (args.event.kind === "installation") {
      if (args.event.action === "deleted" || args.event.action === "suspend") {
        const nextConnectionState = args.event.action === "deleted" ? "revoked" : "suspended";
        for (const connection of connections) {
          await ctx.db.patch(connection._id, {
            state: nextConnectionState,
            version: connection.version + 1,
            lastVerifiedAt: now,
          });
          affectedTeams.set(connection.teamId, connection.eventId);
          const bindings = await ctx.db
            .query("githubRepositoryBindings")
            .withIndex("by_connection_state", (index) =>
              index.eq("installationConnectionId", connection._id).eq("state", "active"),
            )
            .collect();
          for (const binding of bindings) {
            await ctx.db.patch(binding._id, {
              state: args.event.action === "deleted" ? "revoked" : "inaccessible",
              syncState: "error",
              syncErrorCode: `installation_${args.event.action}`,
              version: binding.version + 1,
              updatedAt: now,
            });
            affectedTeams.set(binding.teamId, binding.eventId);
            affectedBindings += 1;
          }
        }
      } else if (args.event.action === "unsuspend") {
        const suspendedConnections = await ctx.db
          .query("githubInstallationConnections")
          .withIndex("by_installation_state", (index) =>
            index.eq("installationId", installationId).eq("state", "suspended"),
          )
          .collect();
        for (const connection of suspendedConnections) {
          await ctx.db.patch(connection._id, {
            state: "active",
            version: connection.version + 1,
            lastVerifiedAt: now,
          });
          affectedTeams.set(connection.teamId, connection.eventId);
          const bindings = await ctx.db
            .query("githubRepositoryBindings")
            .withIndex("by_connection_state", (index) =>
              index
                .eq("installationConnectionId", connection._id)
                .eq("state", "inaccessible"),
            )
            .collect();
          for (const binding of bindings) {
            await ctx.db.patch(binding._id, {
              state: "active",
              syncRevision: binding.syncRevision + 1,
              syncState: "pending",
              syncErrorCode: undefined,
              version: binding.version + 1,
              updatedAt: now,
            });
            await integrationWorkpool.enqueueAction(
              ctx,
              internal.githubActions.reconcileRepository,
              { bindingId: binding._id },
              { retry: false },
            );
            affectedTeams.set(binding.teamId, binding.eventId);
            affectedBindings += 1;
          }
        }
      }
    } else if (args.event.kind === "installation_repositories") {
      const removedIds = new Set(args.event.removedRepositoryIds);
      const addedIds = new Set(args.event.addedRepositoryIds);
      for (const connection of connections) {
        const bindings = await ctx.db
          .query("githubRepositoryBindings")
          .withIndex("by_connection_state", (index) =>
            index.eq("installationConnectionId", connection._id),
          )
          .collect();
        for (const binding of bindings) {
          if (removedIds.has(binding.repositoryId) && binding.state === "active") {
            await ctx.db.patch(binding._id, {
              state: "inaccessible",
              syncState: "error",
              syncErrorCode: "repository_access_removed",
              version: binding.version + 1,
              updatedAt: now,
            });
            affectedTeams.set(binding.teamId, binding.eventId);
            affectedBindings += 1;
          } else if (addedIds.has(binding.repositoryId) && binding.state === "inaccessible") {
            await ctx.db.patch(binding._id, {
              state: "active",
              syncRevision: binding.syncRevision + 1,
              syncState: "pending",
              syncErrorCode: undefined,
              version: binding.version + 1,
              updatedAt: now,
            });
            await integrationWorkpool.enqueueAction(
              ctx,
              internal.githubActions.reconcileRepository,
              { bindingId: binding._id },
              { retry: false },
            );
            affectedTeams.set(binding.teamId, binding.eventId);
            affectedBindings += 1;
          }
        }
      }
    } else {
      for (const connection of connections) {
        const bindings = await ctx.db
          .query("githubRepositoryBindings")
          .withIndex("by_connection_state", (index) =>
            index.eq("installationConnectionId", connection._id).eq("state", "active"),
          )
          .collect();
        for (const binding of bindings) {
          if (
            binding.repositoryId !== args.event.repositoryId ||
            args.event.ref !== `refs/heads/${binding.trackedBranch}`
          ) {
            continue;
          }
          await ctx.db.insert("githubPushEvents", {
            eventId: binding.eventId,
            teamId: binding.teamId,
            repositoryBindingId: binding._id,
            deliveryId: args.deliveryId,
            ref: args.event.ref,
            beforeSha: args.event.beforeSha,
            afterSha: args.event.afterSha,
            created: args.event.created,
            deleted: args.event.deleted,
            forced: args.event.forced,
            pushedCommitCount: args.event.pushedCommitCount,
            ...(args.event.providerAt !== undefined
              ? { providerAt: args.event.providerAt }
              : {}),
            receivedAt: now,
          });
          const metric = await ctx.db
            .query("githubRepositoryMetrics")
            .withIndex("by_binding", (index) =>
              index.eq("repositoryBindingId", binding._id),
            )
            .unique();
          if (!metric) throw new Error("GitHub repository metrics are missing.");
          const syncRevision = binding.syncRevision + 1;
          await ctx.db.patch(binding._id, {
            ...(!args.event.deleted ? { pendingHeadSha: args.event.afterSha } : {}),
            lastWebhookAt: now,
            ...(args.event.providerAt !== undefined &&
            args.event.providerAt > (binding.lastProviderPushedAt ?? 0)
              ? { lastProviderPushedAt: args.event.providerAt }
              : {}),
            syncRevision,
            syncState: binding.syncState === "running" ? "running" : "pending",
            syncErrorCode: undefined,
            version: binding.version + 1,
            updatedAt: now,
          });
          await ctx.db.patch(metric._id, {
            pushCount: metric.pushCount + 1,
            capturedAt: now,
            version: metric.version + 1,
          });
          await integrationWorkpool.enqueueAction(
            ctx,
            internal.githubActions.reconcileRepository,
            { bindingId: binding._id },
            { retry: false },
          );
          affectedTeams.set(binding.teamId, binding.eventId);
          affectedBindings += 1;
        }
      }
    }
    for (const [teamId, eventId] of affectedTeams) {
      await refreshGithubTeamMetrics(ctx, { eventId, teamId, now });
    }
    await ctx.db.insert("githubWebhookDeliveries", {
      deliveryId: args.deliveryId,
      eventName: args.eventName,
      installationId,
      ...(args.event.kind === "push" ? { repositoryId: args.event.repositoryId } : {}),
      payloadHash: args.payloadHash,
      state: affectedBindings > 0 ? "accepted" : "ignored",
      reasonCode: affectedBindings > 0 ? "bindings_updated" : "no_matching_binding",
      receivedAt: now,
    });
    return { duplicate: false, affectedBindings };
  },
});
