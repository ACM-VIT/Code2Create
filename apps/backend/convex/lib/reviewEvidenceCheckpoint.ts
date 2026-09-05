import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  githubTopicVerificationIsCurrent,
  loadPublishedIntegrationPolicy,
} from "./integrationPolicy";
import { operationFingerprint } from "./operations";

export type EvidenceCompleteness = "complete" | "partial" | "missing";

async function latestGithubSnapshot(
  ctx: MutationCtx,
  bindingId: Id<"githubRepositoryBindings">,
) {
  return ctx.db
    .query("githubRepositorySnapshots")
    .withIndex("by_binding_time", (index) =>
      index.eq("repositoryBindingId", bindingId),
    )
    .order("desc")
    .first();
}

async function latestFigmaSnapshot(
  ctx: MutationCtx,
  bindingId: Id<"figmaFileBindings">,
) {
  return ctx.db
    .query("figmaFileSnapshots")
    .withIndex("by_binding_time", (index) =>
      index.eq("figmaFileBindingId", bindingId),
    )
    .order("desc")
    .first();
}

export async function buildEvidenceCheckpoint(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    round: Doc<"reviewRounds">;
    team: Doc<"teams">;
    actorPersonId: Id<"people">;
    createdAt: number;
  },
) {
  const projectVersionId = args.team.lockedProjectVersionId;
  if (!projectVersionId)
    throw new Error("Validated review team has no project version.");
  const event = await ctx.db.get(args.eventId);
  if (!event) throw new Error("The review event no longer resolves.");
  const { normalized: integrationPolicy } =
    await loadPublishedIntegrationPolicy(ctx, event);
  const [
    githubBindings,
    figmaBindings,
    previousCheckpoint,
    teamCheckpointSubmission,
  ] = await Promise.all([
    ctx.db
      .query("githubRepositoryBindings")
      .withIndex("by_team_state", (index) => index.eq("teamId", args.team._id))
      .collect(),
    ctx.db
      .query("figmaFileBindings")
      .withIndex("by_team_state", (index) => index.eq("teamId", args.team._id))
      .collect(),
    ctx.db
      .query("reviewEvidenceCheckpointSets")
      .withIndex("by_team_round_sequence_created", (index) =>
        index
          .eq("teamId", args.team._id)
          .lt("roundSequence", args.round.sequence),
      )
      .order("desc")
      .first(),
    ctx.db
      .query("teamCheckpointSubmissions")
      .withIndex("by_team_submitted", (index) =>
        index.eq("teamId", args.team._id).lte("submittedAt", args.createdAt),
      )
      .order("desc")
      .first(),
  ]);
  if (previousCheckpoint && previousCheckpoint.eventId !== args.eventId) {
    throw new Error("A previous evidence checkpoint belongs to another event.");
  }
  const activeGithub = githubBindings
    .filter((binding) => binding.state !== "archived")
    .sort((left, right) => left.displayOrder - right.displayOrder);
  const activeFigma = figmaBindings
    .filter((binding) => binding.state !== "archived")
    .sort((left, right) => left.connectedAt - right.connectedAt);
  const githubEntries = await Promise.all(
    activeGithub.map(async (binding) => {
      const requiredTopicIsCurrent = githubTopicVerificationIsCurrent(
        binding,
        integrationPolicy.requiredGitHubTopic,
      );
      const snapshot = requiredTopicIsCurrent
        ? await latestGithubSnapshot(ctx, binding._id)
        : null;
      return {
        bindingId: binding._id,
        ...(snapshot ? { snapshotId: snapshot._id } : {}),
        repositoryName: binding.fullName,
        repositoryUrl: binding.url,
        kind: binding.kind,
        purpose: binding.purpose,
        trackedBranch: binding.trackedBranch,
        ...(binding.rootPath !== undefined
          ? { rootPath: binding.rootPath }
          : {}),
        requiredTopic: integrationPolicy.requiredGitHubTopic,
        stateAtCapture: binding.state,
      };
    }),
  );
  const figmaEntries = await Promise.all(
    activeFigma.map(async (binding) => {
      const snapshot = await latestFigmaSnapshot(ctx, binding._id);
      const preview = snapshot
        ? await ctx.db
            .query("figmaPreviewSets")
            .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshot._id))
            .unique()
        : null;
      const facts = preview
        ? await ctx.db
            .query("figmaNodeFacts")
            .withIndex("by_preview_page_order", (q) =>
              q.eq("previewSetId", preview._id),
            )
            .take(preview.selectedNodeCount + 1)
        : [];
      if (preview && facts.length !== preview.selectedNodeCount)
        throw new Error(
          "Figma preview inventory does not match its capture plan.",
        );
      return {
        ...(preview
          ? {
              preview: {
                state: preview.state,
                discoveredNodes: preview.discoveredNodeCount,
                selectedNodes: preview.selectedNodeCount,
                truncated: preview.truncated,
                renders: facts.flatMap((fact) =>
                  fact.render.state === "available"
                    ? [{ factId: fact._id, sha256: fact.render.sha256 }]
                    : [],
                ),
              },
            }
          : {}),
        bindingId: binding._id,
        ...(snapshot ? { snapshotId: snapshot._id } : {}),
        fileName: binding.name,
        fileUrl: binding.url,
        role: binding.role,
        editorType: binding.editorType,
        stateAtCapture: binding.state,
      };
    }),
  );
  const expectedResourceCount = githubEntries.length + figmaEntries.length;
  const capturedResourceCount =
    githubEntries.filter((entry) => entry.snapshotId !== undefined).length +
    figmaEntries.filter((entry) => entry.snapshotId !== undefined).length;
  const completeness: EvidenceCompleteness =
    expectedResourceCount === 0 ||
    capturedResourceCount === expectedResourceCount
      ? "complete"
      : capturedResourceCount === 0
        ? "missing"
        : "partial";
  const checksum = operationFingerprint([
    projectVersionId,
    teamCheckpointSubmission?._id ?? "no_team_checkpoint",
    previousCheckpoint?._id ?? "first_checkpoint",
    JSON.stringify(githubEntries),
    JSON.stringify(figmaEntries),
  ]);
  return {
    eventId: args.eventId,
    roundId: args.round._id,
    roundSequence: args.round.sequence,
    teamId: args.team._id,
    projectVersionId,
    ...(teamCheckpointSubmission
      ? { teamCheckpointSubmissionId: teamCheckpointSubmission._id }
      : {}),
    ...(previousCheckpoint
      ? { previousCheckpointSetId: previousCheckpoint._id }
      : {}),
    githubEntries,
    figmaEntries,
    expectedResourceCount,
    capturedResourceCount,
    completeness,
    checksum,
    createdByPersonId: args.actorPersonId,
    createdAt: args.createdAt,
  };
}

export async function createEvidenceCheckpoint(
  ctx: MutationCtx,
  args: Parameters<typeof buildEvidenceCheckpoint>[1],
) {
  const fields = await buildEvidenceCheckpoint(ctx, args);
  const checkpointId = await ctx.db.insert(
    "reviewEvidenceCheckpointSets",
    fields,
  );
  return {
    checkpointId,
    projectVersionId: fields.projectVersionId,
    completeness: fields.completeness,
    snapshot: fields,
  };
}
