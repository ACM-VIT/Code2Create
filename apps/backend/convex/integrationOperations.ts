import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import {
  githubTopicVerificationIsCurrent,
  loadPublishedIntegrationPolicy,
} from "./lib/integrationPolicy";
import { activeGrantScopes } from "./lib/synesthesia";
import { maximumReviewTeamsPerEvent } from "./lib/reviewLimits";
import {
  figmaPreviewState,
  githubRepositoryCoverage,
  githubRepositorySyncState,
  githubRepositoryTopicState,
  integrationProviderHealth,
  repositoryKind,
  teamStatus,
} from "./values";

const integrationTeam = v.object({
  teamId: v.id("teams"),
  teamName: v.string(),
  teamStatus,
  github: v.object({
    health: integrationProviderHealth,
    repositoryCount: v.number(),
    installationCount: v.number(),
    topicMissingCount: v.number(),
    incompleteCount: v.number(),
    lastActivityAt: v.optional(v.number()),
  }),
  figma: v.object({
    health: integrationProviderHealth,
    fileCount: v.number(),
    authorizationCount: v.number(),
    completeCount: v.number(),
    incompleteCount: v.number(),
    dirtyCount: v.number(),
    webhookUnavailableCount: v.number(),
    rateLimitedCount: v.number(),
    previewAttentionCount: v.number(),
    oldestMetadataCheckAt: v.optional(v.number()),
    lastCaptureAt: v.optional(v.number()),
    lastActivityAt: v.optional(v.number()),
  }),
});

const integrationSummary = v.object({
  totalTeamCount: v.number(),
  disconnectedCount: v.number(),
  attentionCount: v.number(),
});

type ProviderMetric = { health: Doc<"githubTeamMetrics">["health"] };

export function integrationSummaryCounts(
  teamIds: readonly string[],
  githubMetrics: ReadonlyMap<string, ProviderMetric>,
  figmaMetrics: ReadonlyMap<string, ProviderMetric>,
) {
  let disconnectedCount = 0;
  let attentionCount = 0;
  for (const teamId of teamIds) {
    const githubHealth = githubMetrics.get(teamId)?.health ?? "not_connected";
    const figmaHealth = figmaMetrics.get(teamId)?.health ?? "not_connected";
    if (githubHealth === "not_connected" && figmaHealth === "not_connected") {
      disconnectedCount += 1;
    } else if (githubHealth === "needs_attention" || figmaHealth === "needs_attention") {
      attentionCount += 1;
    }
  }
  return { totalTeamCount: teamIds.length, disconnectedCount, attentionCount };
}

async function readableTeamScope(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
) {
  const scopes = await activeGrantScopes(ctx, {
    eventId,
    eventAccessSubjectId,
    permissionKey: "integration.read",
    maximumScopeCount: maximumReviewTeamsPerEvent,
  });
  return {
    eventWide: scopes.eventWide,
    teamIds: [...scopes.scopeIds].flatMap((scopeId) => {
      const teamId = ctx.db.normalizeId("teams", scopeId);
      return teamId ? [teamId] : [];
    }),
  };
}

function integrationTeamView(
  team: Doc<"teams">,
  githubMetric: Doc<"githubTeamMetrics"> | null,
  figmaMetric: Doc<"figmaTeamMetrics"> | null,
) {
  return {
    teamId: team._id,
    teamName: team.name,
    teamStatus: team.status,
    github: {
      health: githubMetric?.health ?? ("not_connected" as const),
      repositoryCount: githubMetric?.repositoryCount ?? 0,
      installationCount: githubMetric?.installationCount ?? 0,
      topicMissingCount: githubMetric?.topicMissingCount ?? 0,
      incompleteCount: githubMetric?.incompleteRepositoryCount ?? 0,
      ...(githubMetric?.lastActivityAt !== undefined
        ? { lastActivityAt: githubMetric.lastActivityAt }
        : {}),
    },
    figma: {
      health: figmaMetric?.health ?? ("not_connected" as const),
      fileCount: figmaMetric?.fileCount ?? 0,
      authorizationCount: figmaMetric?.authorizationCount ?? 0,
      completeCount: figmaMetric?.completeFileCount ?? 0,
      incompleteCount: figmaMetric?.incompleteFileCount ?? 0,
      dirtyCount: figmaMetric?.dirtyCount ?? 0,
      webhookUnavailableCount: figmaMetric?.webhookUnavailableCount ?? 0,
      rateLimitedCount: figmaMetric?.rateLimitedCount ?? 0,
      previewAttentionCount: figmaMetric?.previewAttentionCount ?? 0,
      ...(figmaMetric?.oldestMetadataCheckAt !== undefined
        ? { oldestMetadataCheckAt: figmaMetric.oldestMetadataCheckAt }
        : {}),
      ...(figmaMetric?.lastCaptureAt !== undefined
        ? { lastCaptureAt: figmaMetric.lastCaptureAt }
        : {}),
      ...(figmaMetric?.lastActivityAt !== undefined
        ? { lastActivityAt: figmaMetric.lastActivityAt }
        : {}),
    },
  };
}

const teamDetail = v.object({
  canReadFigmaArtifacts: v.boolean(),
  githubRepositories: v.array(
    v.object({
      bindingId: v.id("githubRepositoryBindings"),
      fullName: v.string(),
      url: v.string(),
      kind: repositoryKind,
      customKind: v.optional(v.string()),
      purpose: v.string(),
      trackedBranch: v.string(),
      rootPath: v.optional(v.string()),
      topicState: githubRepositoryTopicState,
      state: v.string(),
      syncState: githubRepositorySyncState,
      syncErrorCode: v.optional(v.string()),
      baselineSha: v.optional(v.string()),
      currentHeadSha: v.optional(v.string()),
      lastWebhookAt: v.optional(v.number()),
      lastReconciledAt: v.optional(v.number()),
      pushCount: v.number(),
      commitCount: v.number(),
      additions: v.number(),
      deletions: v.number(),
      changedFiles: v.number(),
      completeness: githubRepositoryCoverage,
      compareTruncated: v.boolean(),
    }),
  ),
  figmaFiles: v.array(
    v.object({
      bindingId: v.id("figmaFileBindings"),
      name: v.string(),
      url: v.string(),
      role: v.string(),
      lastProviderEventAt: v.optional(v.number()),
      lastMetadataCheckAt: v.number(),
      nextMetadataCheckAt: v.optional(v.number()),
      lastFullCaptureAt: v.number(),
      contentDirty: v.boolean(),
      rateLimitRetryAt: v.optional(v.number()),
      metadataRateLimitRetryAt: v.optional(v.number()),
      metadataErrorCode: v.optional(v.string()),
      hasFullArtifact: v.boolean(),
      artifactCapturedAt: v.optional(v.number()),
      preview: v.object({
        state: figmaPreviewState,
        selectedNodeCount: v.number(),
        availableCount: v.number(),
        failedCount: v.number(),
        truncated: v.boolean(),
      }),
    }),
  ),
  reviewLinks: v.array(
    v.object({
      id: v.id("teamReviewLinks"),
      kind: v.union(v.literal("github"), v.literal("figma")),
      url: v.string(),
      label: v.string(),
    }),
  ),
});

export const teams = query({
  args: {
    eventSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(integrationTeam),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const scope = await readableTeamScope(ctx, event._id, subject._id);
    const eventTeams = ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id));
    const readableTeams = scope.eventWide
      ? eventTeams
      : scope.teamIds.length === 0
        ? eventTeams.filter((filter) => filter.neq(filter.field("eventId"), event._id))
        : eventTeams.filter((filter) =>
            filter.or(...scope.teamIds.map((teamId) => filter.eq(filter.field("_id"), teamId))),
          );
    const page = await readableTeams.paginate(args.paginationOpts);
    const visible = [];
    for (const team of page.page) {
      const [githubMetric, figmaMetric] = await Promise.all([
        ctx.db
          .query("githubTeamMetrics")
          .withIndex("by_team", (index) => index.eq("teamId", team._id))
          .unique(),
        ctx.db
          .query("figmaTeamMetrics")
          .withIndex("by_team", (index) => index.eq("teamId", team._id))
          .unique(),
      ]);
      if (
        githubMetric &&
        (githubMetric.eventId !== event._id || githubMetric.teamId !== team._id)
      ) {
        throw new Error("GitHub team metrics do not match the operations row.");
      }
      if (figmaMetric && (figmaMetric.eventId !== event._id || figmaMetric.teamId !== team._id)) {
        throw new Error("Figma team metrics do not match the operations row.");
      }
      visible.push(integrationTeamView(team, githubMetric, figmaMetric));
    }
    return { ...page, page: visible };
  },
});

export const summary = query({
  args: { eventSlug: v.string() },
  returns: integrationSummary,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const scope = await readableTeamScope(ctx, event._id, subject._id);
    const eventTeams = await ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
      .collect();
    const visibleTeams = scope.eventWide
      ? eventTeams
      : eventTeams.filter((team) => scope.teamIds.some((teamId) => teamId === team._id));
    const [githubMetrics, figmaMetrics] = await Promise.all([
      ctx.db
        .query("githubTeamMetrics")
        .withIndex("by_event_updated", (index) => index.eq("eventId", event._id))
        .collect(),
      ctx.db
        .query("figmaTeamMetrics")
        .withIndex("by_event_updated", (index) => index.eq("eventId", event._id))
        .collect(),
    ]);
    return integrationSummaryCounts(
      visibleTeams.map((team) => team._id),
      new Map(githubMetrics.map((metric) => [metric.teamId, metric])),
      new Map(figmaMetrics.map((metric) => [metric.teamId, metric])),
    );
  },
});

export const details = query({
  args: { eventSlug: v.string(), teamId: v.id("teams") },
  returns: teamDetail,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const team = await ctx.db.get(args.teamId);
    if (!team || team.eventId !== event._id) {
      throw new ConvexError({ code: "TEAM_UNAVAILABLE", message: "This team is unavailable." });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.read",
      scopeType: "team",
      scopeId: team._id,
    });
    const [integrationPolicy, githubBindings, figmaBindings, artifactGrantIds] = await Promise.all([
      loadPublishedIntegrationPolicy(ctx, event),
      ctx.db
        .query("githubRepositoryBindings")
        .withIndex("by_team_state", (index) => index.eq("teamId", team._id))
        .collect(),
      ctx.db
        .query("figmaFileBindings")
        .withIndex("by_team_state", (index) => index.eq("teamId", team._id))
        .collect(),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "integration.artifact.read",
        scopeType: "team",
        scopeId: team._id,
      }),
    ]);
    const activeGithubBindings = githubBindings
      .filter((binding) => binding.state !== "archived")
      .toSorted((left, right) => left.displayOrder - right.displayOrder);
    const githubRepositories = await Promise.all(
      activeGithubBindings.map(async (binding) => {
        if (binding.eventId !== event._id || binding.teamId !== team._id) {
          throw new Error("A GitHub operations detail crossed an ownership boundary.");
        }
        const metric = await ctx.db
          .query("githubRepositoryMetrics")
          .withIndex("by_binding", (index) => index.eq("repositoryBindingId", binding._id))
          .unique();
        if (
          !metric ||
          metric.eventId !== event._id ||
          metric.teamId !== team._id ||
          metric.repositoryBindingId !== binding._id
        ) {
          throw new Error("A GitHub operations detail has no valid metrics projection.");
        }
        return {
          bindingId: binding._id,
          fullName: binding.fullName,
          url: binding.url,
          kind: binding.kind,
          ...(binding.customKind !== undefined ? { customKind: binding.customKind } : {}),
          purpose: binding.purpose,
          trackedBranch: binding.trackedBranch,
          ...(binding.rootPath !== undefined ? { rootPath: binding.rootPath } : {}),
          topicState: githubTopicVerificationIsCurrent(
            binding,
            integrationPolicy.normalized.requiredGitHubTopic,
          )
            ? binding.topicState
            : ("unknown" as const),
          state: binding.state,
          syncState: binding.syncState,
          ...(binding.syncErrorCode !== undefined ? { syncErrorCode: binding.syncErrorCode } : {}),
          ...(binding.baselineSha !== undefined ? { baselineSha: binding.baselineSha } : {}),
          ...(binding.currentHeadSha !== undefined
            ? { currentHeadSha: binding.currentHeadSha }
            : {}),
          ...(binding.lastWebhookAt !== undefined ? { lastWebhookAt: binding.lastWebhookAt } : {}),
          ...(binding.lastReconciledAt !== undefined
            ? { lastReconciledAt: binding.lastReconciledAt }
            : {}),
          pushCount: metric.pushCount,
          commitCount: metric.commitCount,
          additions: metric.additions,
          deletions: metric.deletions,
          changedFiles: metric.changedFiles,
          completeness: metric.completeness,
          compareTruncated: metric.compareTruncated,
        };
      }),
    );
    const activeFigmaBindings = figmaBindings.filter((binding) => binding.state !== "archived");
    const figmaFiles = await Promise.all(
      activeFigmaBindings.map(async (binding) => {
        if (binding.eventId !== event._id || binding.teamId !== team._id) {
          throw new Error("A Figma operations detail crossed an ownership boundary.");
        }
        const snapshot = await ctx.db
          .query("figmaFileSnapshots")
          .withIndex("by_binding_time", (index) => index.eq("figmaFileBindingId", binding._id))
          .order("desc")
          .first();
        if (
          !snapshot ||
          snapshot.eventId !== event._id ||
          snapshot.teamId !== team._id ||
          snapshot.figmaFileBindingId !== binding._id
        ) {
          throw new Error("A Figma operations detail has no valid snapshot.");
        }
        const preview = await ctx.db
          .query("figmaPreviewSets")
          .withIndex("by_snapshot", (index) => index.eq("snapshotId", snapshot._id))
          .unique();
        if (
          !preview ||
          preview.eventId !== event._id ||
          preview.teamId !== team._id ||
          preview.figmaFileBindingId !== binding._id ||
          preview.providerVersionId !== snapshot.providerVersionId
        ) {
          throw new Error("A Figma operations detail has no valid preview projection.");
        }
        return {
          bindingId: binding._id,
          name: binding.name,
          url: binding.url,
          role: binding.role,
          ...(binding.lastProviderEventAt !== undefined
            ? { lastProviderEventAt: binding.lastProviderEventAt }
            : {}),
          lastMetadataCheckAt: binding.lastMetadataCheckAt,
          ...(binding.nextMetadataCheckAt !== undefined
            ? { nextMetadataCheckAt: binding.nextMetadataCheckAt }
            : {}),
          lastFullCaptureAt: binding.lastFullCaptureAt,
          contentDirty: binding.contentDirty,
          ...(binding.rateLimitRetryAt !== undefined
            ? { rateLimitRetryAt: binding.rateLimitRetryAt }
            : {}),
          ...(binding.metadataRateLimitRetryAt !== undefined
            ? { metadataRateLimitRetryAt: binding.metadataRateLimitRetryAt }
            : {}),
          ...(binding.metadataErrorCode !== undefined
            ? { metadataErrorCode: binding.metadataErrorCode }
            : {}),
          hasFullArtifact: snapshot.artifactId !== undefined,
          ...(snapshot.artifactId !== undefined ? { artifactCapturedAt: snapshot.capturedAt } : {}),
          preview: {
            state: preview.state,
            selectedNodeCount: preview.selectedNodeCount,
            availableCount: preview.availableCount,
            failedCount: preview.failedCount,
            truncated: preview.truncated,
          },
        };
      }),
    );
    const reviewLinkDocs = await ctx.db
      .query("teamReviewLinks")
      .withIndex("by_team_state", (index) => index.eq("teamId", team._id).eq("state", "active"))
      .collect();
    return {
      canReadFigmaArtifacts: artifactGrantIds.length > 0,
      githubRepositories,
      figmaFiles,
      reviewLinks: reviewLinkDocs
        .filter((link) => link.eventId === event._id)
        .toSorted((left, right) => left.createdAt - right.createdAt)
        .map((link) => ({
          id: link._id,
          kind: link.kind,
          url: link.url,
          label: link.label,
        })),
    };
  },
});
