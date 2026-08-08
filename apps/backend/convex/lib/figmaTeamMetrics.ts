import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

function greatest(values: Array<number | undefined>) {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.max(...present);
}

function least(values: number[]) {
  return values.length === 0 ? undefined : Math.min(...values);
}

export async function refreshFigmaTeamMetrics(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    now: number;
  },
) {
  const [connections, teamBindings, existing] = await Promise.all([
    ctx.db
      .query("figmaCredentialConnections")
      .withIndex("by_team_state", (index) => index.eq("teamId", args.teamId))
      .collect(),
    ctx.db
      .query("figmaFileBindings")
      .withIndex("by_team_state", (index) => index.eq("teamId", args.teamId))
      .collect(),
    ctx.db
      .query("figmaTeamMetrics")
      .withIndex("by_team", (index) => index.eq("teamId", args.teamId))
      .unique(),
  ]);
  if (
    connections.some((connection) => connection.eventId !== args.eventId) ||
    teamBindings.some((binding) => binding.eventId !== args.eventId) ||
    (existing && existing.eventId !== args.eventId)
  ) {
    throw new Error("Figma team metrics crossed an event boundary.");
  }
  const bindings = teamBindings.filter((binding) => binding.state !== "archived");
  const sources = await Promise.all(
    bindings.map(async (binding) => {
      const [metric, snapshot] = await Promise.all([
        ctx.db
          .query("figmaFileMetrics")
          .withIndex("by_binding", (index) => index.eq("figmaFileBindingId", binding._id))
          .unique(),
        ctx.db
          .query("figmaFileSnapshots")
          .withIndex("by_binding_time", (index) =>
            index.eq("figmaFileBindingId", binding._id),
          )
          .order("desc")
          .first(),
      ]);
      if (!metric || !snapshot) {
        throw new Error("An active Figma file has no complete metrics source.");
      }
      const preview = await ctx.db
        .query("figmaPreviewSets")
        .withIndex("by_snapshot", (index) => index.eq("snapshotId", snapshot._id))
        .unique();
      if (!preview) {
        throw new Error("An active Figma file has no preview projection.");
      }
      if (
        metric.eventId !== args.eventId ||
        metric.teamId !== args.teamId ||
        metric.figmaFileBindingId !== binding._id ||
        snapshot.eventId !== args.eventId ||
        snapshot.teamId !== args.teamId ||
        snapshot.figmaFileBindingId !== binding._id ||
        preview.eventId !== args.eventId ||
        preview.teamId !== args.teamId ||
        preview.figmaFileBindingId !== binding._id ||
        preview.snapshotId !== snapshot._id ||
        preview.providerVersionId !== snapshot.providerVersionId
      ) {
        throw new Error("A Figma team metric source crossed an ownership boundary.");
      }
      return { binding, metric, snapshot, preview };
    }),
  );
  const fileComplete = sources.map(({ binding, metric, snapshot, preview }) =>
    binding.state === "active" &&
    binding.syncState === "ready" &&
    !binding.contentDirty &&
    binding.metadataErrorCode === undefined &&
    binding.rateLimitRetryAt === undefined &&
    binding.metadataRateLimitRetryAt === undefined &&
    binding.webhookState !== "error" &&
    metric.completeness === "complete" &&
    snapshot.artifactId !== undefined &&
    preview.state === "ready",
  );
  const completeFileCount = fileComplete.filter(Boolean).length;
  const previewAttentionCount = sources.filter(({ preview }) =>
    preview.state === "partial" ||
    preview.state === "rate_limited" ||
    preview.state === "failed",
  ).length;
  const needsAttention = sources.some(({ binding, metric, snapshot, preview }) =>
    binding.state !== "active" ||
    binding.syncState === "error" ||
    binding.syncState === "rate_limited" ||
    binding.contentDirty ||
    binding.metadataErrorCode !== undefined ||
    binding.rateLimitRetryAt !== undefined ||
    binding.metadataRateLimitRetryAt !== undefined ||
    binding.webhookState === "error" ||
    metric.completeness !== "complete" ||
    snapshot.artifactId === undefined ||
    preview.state === "partial" ||
    preview.state === "rate_limited" ||
    preview.state === "failed",
  );
  const syncing = sources.some(({ binding, preview }) =>
    binding.syncState === "pending" ||
    binding.syncState === "running" ||
    preview.state === "pending" ||
    preview.state === "running",
  );
  const health: Doc<"figmaTeamMetrics">["health"] =
    bindings.length === 0
      ? "not_connected"
      : needsAttention
        ? "needs_attention"
        : syncing
          ? "syncing"
          : "ready";
  const completeness: Doc<"figmaTeamMetrics">["completeness"] =
    bindings.length === 0
      ? "unknown"
      : completeFileCount === bindings.length
        ? "complete"
        : "partial";
  const oldestMetadataCheckAt = least(bindings.map((binding) => binding.lastMetadataCheckAt));
  const lastCaptureAt = greatest(bindings.map((binding) => binding.lastFullCaptureAt));
  const lastActivityAt = greatest([
    ...connections.map((connection) => connection.lastVerifiedAt),
    ...bindings.flatMap((binding) => [
      binding.lastProviderEventAt,
      binding.lastProviderObservedAt,
      binding.lastFullCaptureAt,
    ]),
  ]);
  const next = {
    eventId: args.eventId,
    teamId: args.teamId,
    health,
    authorizationCount: connections.filter((connection) => connection.state === "active").length,
    fileCount: bindings.length,
    completeFileCount,
    incompleteFileCount: bindings.length - completeFileCount,
    dirtyCount: bindings.filter((binding) => binding.contentDirty).length,
    webhookActiveCount: bindings.filter((binding) => binding.webhookState === "active").length,
    webhookUnavailableCount: bindings.filter((binding) => binding.webhookState !== "active").length,
    rateLimitedCount: bindings.filter(
      (binding) =>
        binding.syncState === "rate_limited" ||
        binding.rateLimitRetryAt !== undefined ||
        binding.metadataRateLimitRetryAt !== undefined,
    ).length,
    previewReadyCount: sources.filter(({ preview }) => preview.state === "ready").length,
    previewPendingCount: sources.filter(
      ({ preview }) => preview.state === "pending" || preview.state === "running",
    ).length,
    previewAttentionCount,
    selectedPreviewCount: sources.reduce(
      (total, { preview }) => total + preview.selectedNodeCount,
      0,
    ),
    availablePreviewCount: sources.reduce(
      (total, { preview }) => total + preview.availableCount,
      0,
    ),
    pageCount: sources.reduce((total, { metric }) => total + metric.pageCount, 0),
    frameCount: sources.reduce((total, { metric }) => total + metric.frameCount, 0),
    componentCount: sources.reduce((total, { metric }) => total + metric.componentCount, 0),
    componentSetCount: sources.reduce(
      (total, { metric }) => total + metric.componentSetCount,
      0,
    ),
    styleCount: sources.reduce((total, { metric }) => total + metric.styleCount, 0),
    nodeCount: sources.reduce((total, { metric }) => total + metric.nodeCount, 0),
    prototypeInteractionCount: sources.reduce(
      (total, { metric }) => total + metric.prototypeInteractionCount,
      0,
    ),
    commentCount: sources.reduce((total, { metric }) => total + metric.commentCount, 0),
    unresolvedCommentCount: sources.reduce(
      (total, { metric }) => total + metric.unresolvedCommentCount,
      0,
    ),
    versionCount: sources.reduce((total, { metric }) => total + metric.versionCount, 0),
    completeness,
    ...(oldestMetadataCheckAt !== undefined ? { oldestMetadataCheckAt } : {}),
    ...(lastCaptureAt !== undefined ? { lastCaptureAt } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    updatedAt: args.now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, { ...next, version: existing.version + 1 });
    return { teamMetricId: existing._id, version: existing.version + 1, ...next };
  }
  const teamMetricId = await ctx.db.insert("figmaTeamMetrics", { ...next, version: 1 });
  return { teamMetricId, version: 1, ...next };
}
