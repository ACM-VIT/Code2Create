import { repositoryKinds } from "@code2create/domain";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

function greatest(values: number[]) {
  return values.length === 0 ? undefined : Math.max(...values);
}

export async function refreshGithubTeamMetrics(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    now: number;
  },
) {
  const [connections, teamBindings, existing] = await Promise.all([
    ctx.db
      .query("githubInstallationConnections")
      .withIndex("by_team_state", (index) => index.eq("teamId", args.teamId))
      .collect(),
    ctx.db
      .query("githubRepositoryBindings")
      .withIndex("by_team_state", (index) => index.eq("teamId", args.teamId))
      .collect(),
    ctx.db
      .query("githubTeamMetrics")
      .withIndex("by_team", (index) => index.eq("teamId", args.teamId))
      .unique(),
  ]);
  if (
    connections.some((connection) => connection.eventId !== args.eventId) ||
    teamBindings.some((binding) => binding.eventId !== args.eventId) ||
    (existing && existing.eventId !== args.eventId)
  ) {
    throw new Error("GitHub team metrics crossed an event boundary.");
  }
  const bindings = teamBindings.filter((binding) => binding.state !== "archived");
  const metrics = await Promise.all(
    bindings.map((binding) =>
      ctx.db
        .query("githubRepositoryMetrics")
        .withIndex("by_binding", (index) => index.eq("repositoryBindingId", binding._id))
        .unique(),
    ),
  );
  if (metrics.some((metric) => metric === null)) {
    throw new Error("An active GitHub repository has no metrics projection.");
  }
  const resolvedMetrics = metrics.filter((metric) => metric !== null);
  const uniqueCommitShas = new Set<string>();
  let observedCommitOccurrences = 0;
  const languageTotals = new Map<string, number>();
  for (const metric of resolvedMetrics) {
    observedCommitOccurrences += metric.observedCommitShas.length;
    for (const sha of metric.observedCommitShas) uniqueCommitShas.add(sha);
    for (const language of metric.languageBytes) {
      languageTotals.set(
        language.language,
        (languageTotals.get(language.language) ?? 0) + language.bytes,
      );
    }
  }
  const completeRepositoryCount = bindings.filter((binding, index) => {
    const metric = resolvedMetrics[index];
    if (!metric) throw new Error("A validated GitHub repository metric is missing.");
    return (
      binding.state === "active" &&
      binding.syncState === "ready" &&
      binding.topicState === "present" &&
      metric.completeness === "complete" &&
      metric.commitIdentityComplete
    );
  }).length;
  const commitIdentityComplete = resolvedMetrics.every(
    (metric) => metric.commitIdentityComplete,
  );
  const needsAttention = bindings.some((binding, index) => {
    const metric = resolvedMetrics[index];
    if (!metric) throw new Error("A validated GitHub repository metric is missing.");
    return (
      binding.state !== "active" ||
      binding.syncState === "error" ||
      binding.syncState === "rate_limited" ||
      binding.topicState !== "present" ||
      metric.completeness !== "complete" ||
      !metric.commitIdentityComplete
    );
  });
  const syncing = bindings.some(
    (binding) => binding.syncState === "pending" || binding.syncState === "running",
  );
  const health: Doc<"githubTeamMetrics">["health"] =
    bindings.length === 0
      ? "not_connected"
      : needsAttention
        ? "needs_attention"
        : syncing
          ? "syncing"
          : "ready";
  const completeness: Doc<"githubTeamMetrics">["completeness"] =
    bindings.length === 0
      ? "unknown"
      : completeRepositoryCount === bindings.length
        ? "complete"
        : "partial";
  const lastActivityAt = greatest([
    ...connections.map((connection) => connection.lastVerifiedAt),
    ...bindings.map(
      (binding) =>
        binding.lastWebhookAt ??
        binding.lastProviderPushedAt ??
        binding.lastReconciledAt ??
        binding.connectedAt,
    ),
  ]);
  const next = {
    eventId: args.eventId,
    teamId: args.teamId,
    health,
    installationCount: connections.filter((connection) => connection.state === "active").length,
    repositoryCount: bindings.length,
    completeRepositoryCount,
    topicPresentCount: bindings.filter((binding) => binding.topicState === "present").length,
    topicMissingCount: bindings.filter((binding) => binding.topicState === "missing").length,
    topicUnknownCount: bindings.filter((binding) => binding.topicState === "unknown").length,
    kindCounts: repositoryKinds.flatMap((kind) => {
      const count = bindings.filter((binding) => binding.kind === kind).length;
      return count === 0 ? [] : [{ kind, count }];
    }),
    pushCount: resolvedMetrics.reduce((total, metric) => total + metric.pushCount, 0),
    uniqueObservedCommitCount: uniqueCommitShas.size,
    commitOverlapCount: observedCommitOccurrences - uniqueCommitShas.size,
    commitIdentityComplete,
    additions: resolvedMetrics.reduce((total, metric) => total + metric.additions, 0),
    deletions: resolvedMetrics.reduce((total, metric) => total + metric.deletions, 0),
    changedFiles: resolvedMetrics.reduce((total, metric) => total + metric.changedFiles, 0),
    languageBytes: [...languageTotals.entries()]
      .map(([language, bytes]) => ({ language, bytes }))
      .toSorted((left, right) => right.bytes - left.bytes || left.language.localeCompare(right.language)),
    completeness,
    incompleteRepositoryCount: bindings.length - completeRepositoryCount,
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    updatedAt: args.now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, { ...next, version: existing.version + 1 });
    return { teamMetricId: existing._id, version: existing.version + 1, ...next };
  }
  const teamMetricId = await ctx.db.insert("githubTeamMetrics", { ...next, version: 1 });
  return { teamMetricId, version: 1, ...next };
}
