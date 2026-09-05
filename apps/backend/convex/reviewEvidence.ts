import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds } from "./lib/permissions";
import { compareFigmaCheckpointFacts } from "./lib/figmaCheckpointComparison";

type ReadCtx = QueryCtx | MutationCtx;

export async function fixedEvidenceContext(
  ctx: ReadCtx,
  args: { eventSlug: string; reviewSessionId: Id<"reviewSessions"> },
) {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const session = await ctx.db.get(args.reviewSessionId);
  if (!session || session.eventId !== event._id) {
    throw new ConvexError({
      code: "REVIEW_EVIDENCE_UNAVAILABLE",
      message: "This review evidence is unavailable.",
    });
  }
  const assignment = await ctx.db
    .query("reviewAssignments")
    .withIndex("by_session_person", (index) =>
      index.eq("reviewSessionId", session._id).eq("reviewerPersonId", person._id),
    )
    .unique();
  if (!assignment || assignment.status !== "assigned") {
    throw new ConvexError({
      code: "REVIEW_ASSIGNMENT_REQUIRED",
      message: "Only a reviewer assigned to this review can inspect its fixed evidence.",
    });
  }
  const checkpoint = await ctx.db.get(session.evidenceCheckpointSetId);
  if (
    !checkpoint ||
    checkpoint.eventId !== event._id ||
    checkpoint.roundId !== session.roundId ||
    checkpoint.teamId !== session.teamId ||
    checkpoint.projectVersionId !== session.projectVersionId
  ) {
    throw new Error("The review references an invalid evidence checkpoint set.",
    );
  }
  const [reviewGrantIds, checkpointGrantIds] = await Promise.all([
    matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.evidence.read",
      scopeType: "review",
      scopeId: session._id,
    }),
    matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.evidence.read",
      scopeType: "evidence_checkpoint",
      scopeId: checkpoint._id,
    }),
  ]);
  if (reviewGrantIds.length === 0 && checkpointGrantIds.length === 0) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "This account does not have permission for that fixed evidence set.",
    });
  }
  return {
    event,
    person,
    session,
    checkpoint,
    grantIds: reviewGrantIds.length > 0 ? reviewGrantIds : checkpointGrantIds,
    permissionScope:
      reviewGrantIds.length > 0
        ? { scopeType: "review" as const, scopeId: session._id }
        : { scopeType: "evidence_checkpoint" as const, scopeId: checkpoint._id,
          },
  };
}

async function pinnedFigmaContext(
  ctx: ReadCtx,
  args: {
    eventSlug: string;
    reviewSessionId: Id<"reviewSessions">;
    bindingId: Id<"figmaFileBindings">;
  },
) {
  const context = await fixedEvidenceContext(ctx, args);
  const { event, session, checkpoint } = context;
  const entry = checkpoint.figmaEntries.find((item) => item.bindingId === args.bindingId,
  );
  if (!entry?.snapshotId) {
    throw new ConvexError({
      code: "FIGMA_CHECKPOINT_UNAVAILABLE",
      message: "This Figma file was not captured in the review checkpoint.",
    });
  }
  const [binding, snapshot] = await Promise.all([
    ctx.db.get(entry.bindingId),
    ctx.db.get(entry.snapshotId),
  ]);
  if (
    !binding ||
    !snapshot ||
    binding.eventId !== event._id ||
    binding.teamId !== session.teamId ||
    snapshot.eventId !== event._id ||
    snapshot.teamId !== session.teamId ||
    snapshot.figmaFileBindingId !== binding._id
  ) {
    throw new Error("The pinned Figma evidence context is invalid.");
  }
  return { ...context, binding, snapshot };
}

export const githubAccessContext = internalQuery({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("githubRepositoryBindings"),
  },
  returns: v.object({
    installationId: v.string(),
    repositoryId: v.string(),
    owner: v.string(),
    name: v.string(),
    headSha: v.string(),
    rootPath: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const { event, session, checkpoint } = await fixedEvidenceContext(ctx, args,
    );
    const entry = checkpoint.githubEntries.find((item) => item.bindingId === args.bindingId,
    );
    if (!entry?.snapshotId) {
      throw new ConvexError({
        code: "GITHUB_CHECKPOINT_UNAVAILABLE",
        message: "This repository was not captured in the review checkpoint.",
      });
    }
    const [binding, snapshot] = await Promise.all([
      ctx.db.get(entry.bindingId),
      ctx.db.get(entry.snapshotId),
    ]);
    if (
      !binding ||
      !snapshot ||
      binding.eventId !== event._id ||
      binding.teamId !== session.teamId ||
      snapshot.eventId !== event._id ||
      snapshot.teamId !== session.teamId ||
      snapshot.repositoryBindingId !== binding._id
    ) {
      throw new Error("The pinned GitHub evidence context is invalid.");
    }
    const connection = await ctx.db.get(binding.installationConnectionId);
    if (!connection || connection.eventId !== event._id || connection.teamId !== session.teamId) {
      throw new Error("The pinned GitHub repository connection is invalid.");
    }
    if (connection.state !== "active") {
      throw new ConvexError({
        code: "GITHUB_ACCESS_REVOKED",
        message: "The repository checkpoint metadata remains fixed, but GitHub access was revoked.",
      });
    }
    return {
      installationId: connection.installationId,
      repositoryId: binding.repositoryId,
      owner: binding.owner,
      name: binding.name,
      headSha: snapshot.headSha,
      ...(entry.rootPath !== undefined ? { rootPath: entry.rootPath } : {}),
    };
  },
});

async function requireFigmaArtifactAccess(
  ctx: ReadCtx,
  args: {
    eventSlug: string;
    reviewSessionId: Id<"reviewSessions">;
    bindingId: Id<"figmaFileBindings">;
  },
) {
  const context = await pinnedFigmaContext(ctx, args);
  const { event, session, binding, snapshot } = context;
  if (!snapshot.artifactId) {
    throw new ConvexError({
      code: "FIGMA_ARTIFACT_UNAVAILABLE",
      message: "This Figma checkpoint has metadata but no full-file artifact.",
    });
  }
  const artifact = await ctx.db.get(snapshot.artifactId);
  if (
    !artifact ||
    artifact.state !== "available" ||
    artifact.provider !== "figma" ||
    artifact.eventId !== event._id ||
    artifact.teamId !== session.teamId ||
    artifact.figmaFileBindingId !== binding._id ||
    artifact.providerVersionId !== snapshot.providerVersionId
  ) {
    throw new Error("The pinned Figma artifact manifest is invalid.");
  }
  return { ...context, artifact };
}

export const figmaAccessContext = internalQuery({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
  },
  returns: v.object({
    artifactId: v.id("integrationArtifacts"),
    snapshotId: v.id("figmaFileSnapshots"),
    objectKey: v.string(),
    storageRegion: v.string(),
    storageBucket: v.string(),
    storedBytes: v.number(),
    uncompressedBytes: v.number(),
    sha256: v.string(),
    capturedAt: v.number(),
    providerVersionId: v.string(),
  }),
  handler: async (ctx, args) => {
    const { artifact, snapshot } = await requireFigmaArtifactAccess(ctx, args);
    return {
      artifactId: artifact._id,
      snapshotId: snapshot._id,
      objectKey: artifact.objectKey,
      storageRegion: artifact.storageRegion,
      storageBucket: artifact.storageBucket,
      storedBytes: artifact.storedBytes,
      uncompressedBytes: artifact.uncompressedBytes,
      sha256: artifact.sha256,
      capturedAt: snapshot.capturedAt,
      providerVersionId: snapshot.providerVersionId,
    };
  },
});

export const recordFigmaArtifactAccess = internalMutation({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
    artifactId: v.id("integrationArtifacts"),
    snapshotId: v.id("figmaFileSnapshots"),
    expectedObjectKey: v.string(),
    expectedStorageRegion: v.string(),
    expectedStorageBucket: v.string(),
    expectedStoredBytes: v.number(),
    expectedUncompressedBytes: v.number(),
    expectedSha256: v.string(),
    expectedCapturedAt: v.number(),
    expectedProviderVersionId: v.string(),
    signedUrlExpiresAt: v.number(),
  },
  returns: v.object({ serverNow: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, session, binding, snapshot, artifact, grantIds, permissionScope,
    } =
      await requireFigmaArtifactAccess(ctx, args);
    if (
      artifact._id !== args.artifactId ||
      snapshot._id !== args.snapshotId ||
      artifact.objectKey !== args.expectedObjectKey ||
      artifact.storageRegion !== args.expectedStorageRegion ||
      artifact.storageBucket !== args.expectedStorageBucket ||
      artifact.storedBytes !== args.expectedStoredBytes ||
      artifact.uncompressedBytes !== args.expectedUncompressedBytes ||
      artifact.sha256 !== args.expectedSha256 ||
      snapshot.capturedAt !== args.expectedCapturedAt ||
      snapshot.providerVersionId !== args.expectedProviderVersionId
    ) {
      throw new ConvexError({
        code: "FIGMA_ARTIFACT_CHANGED",
        message: "The fixed Figma checkpoint changed while the download was prepared. Try again.",
      });
    }
    const serverNow = Date.now();
    if (
      !Number.isSafeInteger(args.signedUrlExpiresAt) ||
      args.signedUrlExpiresAt <= serverNow ||
      args.signedUrlExpiresAt > serverNow + 60_000
    ) {
      throw new ConvexError({
        code: "FIGMA_ARTIFACT_LINK_EXPIRED",
        message: "The Figma checkpoint link expired while it was prepared. Try again.",
      });
    }
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.evidence.read",
      grantIds,
      scopeType: permissionScope.scopeType,
      scopeId: permissionScope.scopeId,
      action: "review.figma_artifact_download_opened",
      targetType: "integration_artifact",
      targetId: artifact._id,
      nextSummary: JSON.stringify({
        reviewSessionId: session._id,
        bindingId: binding._id,
        snapshotId: snapshot._id,
        sha256: artifact.sha256,
        signedUrlExpiresAt: args.signedUrlExpiresAt,
      }),
      reason: "Opened the fixed Figma checkpoint for an assigned review",
    });
    return { serverNow };
  },
});

export const figmaPreviewListContext = internalQuery({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
  },
  returns: v.union(
    v.null(),
    v.object({
      previewSetId: v.id("figmaPreviewSets"),
      providerVersionId: v.string(),
      state: v.union(
        v.literal("pending"),
        v.literal("running"),
        v.literal("ready"),
        v.literal("partial"),
        v.literal("rate_limited"),
        v.literal("failed"),
      ),
      discoveredNodeCount: v.number(),
      selectedNodeCount: v.number(),
      availableCount: v.number(),
      failedCount: v.number(),
      truncated: v.boolean(),
      capturedAt: v.number(),
      facts: v.array(
        v.object({
          id: v.id("figmaNodeFacts"),
          pageId: v.string(),
          pageName: v.string(),
          pageOrder: v.number(),
          nodeId: v.string(),
          nodeName: v.string(),
          nodeType: v.string(),
          nodeOrder: v.number(),
          descendantCount: v.number(),
          changeState: v.union(
            v.literal("new"),
            v.literal("changed"),
            v.literal("unchanged"),
            v.literal("unknown"),
          ),
          renderState: v.union(v.literal("pending"), v.literal("available"), v.literal("failed"),
          ),
          width: v.optional(v.number()),
          height: v.optional(v.number()),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const { event, session, binding, snapshot } = await pinnedFigmaContext(ctx, args,
    );
    const previewSet = await ctx.db
      .query("figmaPreviewSets")
      .withIndex("by_snapshot", (index) => index.eq("snapshotId", snapshot._id))
      .unique();
    if (!previewSet) return null;
    if (
      previewSet.eventId !== event._id ||
      previewSet.teamId !== session.teamId ||
      previewSet.figmaFileBindingId !== binding._id ||
      previewSet.providerVersionId !== snapshot.providerVersionId
    ) {
      throw new Error("The pinned Figma preview set is invalid.");
    }
    const facts = await ctx.db
      .query("figmaNodeFacts")
      .withIndex("by_preview_page_order", (index) => index.eq("previewSetId", previewSet._id),
      )
      .collect();
    if (
      facts.length !== previewSet.selectedNodeCount ||
      facts.some(
        (fact) =>
          fact.eventId !== event._id ||
          fact.teamId !== session.teamId ||
          fact.figmaFileBindingId !== binding._id ||
          fact.snapshotId !== snapshot._id ||
          fact.providerVersionId !== snapshot.providerVersionId,
      )
    ) {
      throw new Error("The pinned Figma preview facts are invalid.");
    }
    return {
      previewSetId: previewSet._id,
      providerVersionId: previewSet.providerVersionId,
      state: previewSet.state,
      discoveredNodeCount: previewSet.discoveredNodeCount,
      selectedNodeCount: previewSet.selectedNodeCount,
      availableCount: previewSet.availableCount,
      failedCount: previewSet.failedCount,
      truncated: previewSet.truncated,
      capturedAt: snapshot.capturedAt,
      facts: facts.map((fact) => ({
        id: fact._id,
        pageId: fact.pageId,
        pageName: fact.pageName,
        pageOrder: fact.pageOrder,
        nodeId: fact.nodeId,
        nodeName: fact.nodeName,
        nodeType: fact.nodeType,
        nodeOrder: fact.nodeOrder,
        descendantCount: fact.descendantCount,
        changeState: fact.changeState,
        renderState: fact.render.state,
        ...(fact.render.state === "available"
          ? { width: fact.render.width, height: fact.render.height }
          : {}),
      })),
    };
  },
});

export const figmaActivityContext = internalQuery({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
  },
  returns: v.union(
    v.null(),
    v.object({
      providerVersionId: v.string(),
      capturedAt: v.number(),
      versionCount: v.number(),
      capturedVersionCount: v.number(),
      versionsComplete: v.boolean(),
      commentCount: v.number(),
      capturedCommentCount: v.number(),
      commentsComplete: v.boolean(),
      replyCount: v.number(),
      resolvedThreadCount: v.number(),
      unresolvedThreadCount: v.number(),
      versions: v.array(
        v.object({
          versionId: v.string(),
          label: v.string(),
          description: v.string(),
          descriptionTruncated: v.boolean(),
          userHandle: v.string(),
          providerCreatedAt: v.number(),
        }),
      ),
      comments: v.array(
        v.object({
          commentId: v.string(),
          parentCommentId: v.optional(v.string()),
          userHandle: v.string(),
          message: v.string(),
          messageTruncated: v.boolean(),
          providerCreatedAt: v.number(),
          resolvedAt: v.optional(v.number()),
          orderId: v.optional(v.number()),
          reactionCount: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const { event, session, binding, snapshot } = await pinnedFigmaContext(ctx, args,
    );
    const [activity, versions, comments] = await Promise.all([
      ctx.db
        .query("figmaSnapshotActivity")
        .withIndex("by_snapshot", (index) => index.eq("snapshotId", snapshot._id),
        )
        .unique(),
      ctx.db
        .query("figmaVersionFacts")
        .withIndex("by_snapshot_order", (index) => index.eq("snapshotId", snapshot._id),
        )
        .collect(),
      ctx.db
        .query("figmaCommentFacts")
        .withIndex("by_snapshot_order", (index) => index.eq("snapshotId", snapshot._id),
        )
        .collect(),
    ]);
    if (!activity) return null;
    const invalidOwnership = [activity, ...versions, ...comments].some(
      (record) =>
        record.eventId !== event._id ||
        record.teamId !== session.teamId ||
        record.figmaFileBindingId !== binding._id ||
        record.snapshotId !== snapshot._id ||
        record.providerVersionId !== snapshot.providerVersionId,
    );
    if (
      invalidOwnership ||
      activity.versionCount !== snapshot.versionCount ||
      activity.commentCount !== snapshot.commentCount ||
      activity.capturedVersionCount !== versions.length ||
      activity.capturedCommentCount !== comments.length ||
      activity.replyCount + activity.resolvedThreadCount + activity.unresolvedThreadCount !==
        activity.commentCount ||
      versions.some((version, index) => version.displayOrder !== index) ||
      comments.some((comment, index) => comment.displayOrder !== index)
    ) {
      throw new Error("The pinned Figma activity snapshot is invalid.");
    }
    return {
      providerVersionId: snapshot.providerVersionId,
      capturedAt: snapshot.capturedAt,
      versionCount: activity.versionCount,
      capturedVersionCount: activity.capturedVersionCount,
      versionsComplete: activity.versionsComplete,
      commentCount: activity.commentCount,
      capturedCommentCount: activity.capturedCommentCount,
      commentsComplete: activity.commentsComplete,
      replyCount: activity.replyCount,
      resolvedThreadCount: activity.resolvedThreadCount,
      unresolvedThreadCount: activity.unresolvedThreadCount,
      versions: versions.map((version) => ({
        versionId: version.versionId,
        label: version.label,
        description: version.description,
        descriptionTruncated: version.descriptionTruncated,
        userHandle: version.userHandle,
        providerCreatedAt: version.providerCreatedAt,
      })),
      comments: comments.map((comment) => ({
        commentId: comment.commentId,
        ...(comment.parentCommentId !== undefined
          ? { parentCommentId: comment.parentCommentId }
          : {}),
        userHandle: comment.userHandle,
        message: comment.message,
        messageTruncated: comment.messageTruncated,
        providerCreatedAt: comment.providerCreatedAt,
        ...(comment.resolvedAt !== undefined ? { resolvedAt: comment.resolvedAt } : {}),
        ...(comment.orderId !== undefined ? { orderId: comment.orderId } : {}),
        reactionCount: comment.reactionCount,
      })),
    };
  },
});

const previewState = v.union(v.literal("pending"), v.literal("available"), v.literal("failed"),
);

export const figmaComparisonListContext = internalQuery({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
  },
  returns: v.union(
    v.null(),
    v.object({
      current: v.object({
        checkpointSetId: v.id("reviewEvidenceCheckpointSets"),
        snapshotId: v.id("figmaFileSnapshots"),
        providerVersionId: v.string(),
        capturedAt: v.number(),
        truncated: v.boolean(),
      }),
      previous: v.object({
        checkpointSetId: v.id("reviewEvidenceCheckpointSets"),
        snapshotId: v.optional(v.id("figmaFileSnapshots")),
        providerVersionId: v.optional(v.string()),
        capturedAt: v.number(),
        truncated: v.boolean(),
      }),
      counts: v.object({
        added: v.number(),
        removed: v.number(),
        changed: v.number(),
        unchanged: v.number(),
        uncertain: v.number(),
      }),
      rows: v.array(
        v.object({
          nodeId: v.string(),
          nodeName: v.string(),
          nodeType: v.string(),
          pageName: v.string(),
          state: v.union(
            v.literal("added"),
            v.literal("removed"),
            v.literal("changed"),
            v.literal("unchanged"),
            v.literal("uncertain"),
          ),
          currentFactId: v.optional(v.id("figmaNodeFacts")),
          currentRenderState: v.optional(previewState),
          previousFactId: v.optional(v.id("figmaNodeFacts")),
          previousRenderState: v.optional(previewState),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const { event, session, checkpoint, binding, snapshot } = await pinnedFigmaContext(ctx, args);
    if (!checkpoint.previousCheckpointSetId) return null;
    const previousCheckpoint = await ctx.db.get(checkpoint.previousCheckpointSetId,
    );
    if (
      !previousCheckpoint ||
      previousCheckpoint.eventId !== event._id ||
      previousCheckpoint.teamId !== session.teamId ||
      previousCheckpoint.roundSequence >= checkpoint.roundSequence ||
      previousCheckpoint.createdAt > checkpoint.createdAt
    ) {
      throw new Error("The previous review evidence checkpoint is invalid.");
    }
    const previousEntry = previousCheckpoint.figmaEntries.find(
      (entry) => entry.bindingId === binding._id,
    );
    const previousSnapshot = previousEntry?.snapshotId
      ? await ctx.db.get(previousEntry.snapshotId)
      : null;
    if (
      previousSnapshot &&
      (previousSnapshot.eventId !== event._id ||
        previousSnapshot.teamId !== session.teamId ||
        previousSnapshot.figmaFileBindingId !== binding._id ||
        previousSnapshot.capturedAt > snapshot.capturedAt)
    ) {
      throw new Error("The previous pinned Figma snapshot is invalid.");
    }
    const [currentSet, previousSet, currentFacts, previousFacts] = await Promise.all([
      ctx.db
        .query("figmaPreviewSets")
        .withIndex("by_snapshot", (index) => index.eq("snapshotId", snapshot._id),
          )
        .unique(),
      previousSnapshot
        ? ctx.db
            .query("figmaPreviewSets")
            .withIndex("by_snapshot", (index) => index.eq("snapshotId", previousSnapshot._id),
              )
            .unique()
        : Promise.resolve(null),
      ctx.db
        .query("figmaNodeFacts")
        .withIndex("by_snapshot_page_order", (index) => index.eq("snapshotId", snapshot._id),
          )
        .collect(),
      previousSnapshot
        ? ctx.db
            .query("figmaNodeFacts")
            .withIndex("by_snapshot_page_order", (index) =>
              index.eq("snapshotId", previousSnapshot._id),
            )
            .collect()
        : Promise.resolve([]),
    ]);
    if (!currentSet) return null;
    const currentSetValid =
      currentSet.eventId === event._id &&
      currentSet.teamId === session.teamId &&
      currentSet.figmaFileBindingId === binding._id &&
      currentSet.providerVersionId === snapshot.providerVersionId;
    const previousSetValid =
      previousSet === null ||
      (previousSnapshot !== null &&
        previousSet.eventId === event._id &&
        previousSet.teamId === session.teamId &&
        previousSet.figmaFileBindingId === binding._id &&
        previousSet.providerVersionId === previousSnapshot.providerVersionId);
    const currentFactsValid =
      currentFacts.length === currentSet.selectedNodeCount &&
      currentFacts.every(
        (fact) =>
          fact.eventId === event._id &&
          fact.teamId === session.teamId &&
          fact.figmaFileBindingId === binding._id &&
          fact.snapshotId === snapshot._id &&
          fact.previewSetId === currentSet._id &&
          fact.providerVersionId === snapshot.providerVersionId,
      );
    const previousFactsValid =
      previousSet === null ||
      (previousSnapshot !== null &&
        previousFacts.length === previousSet.selectedNodeCount &&
        previousFacts.every(
          (fact) =>
            fact.eventId === event._id &&
            fact.teamId === session.teamId &&
            fact.figmaFileBindingId === binding._id &&
            fact.snapshotId === previousSnapshot._id &&
            fact.previewSetId === previousSet._id &&
            fact.providerVersionId === previousSnapshot.providerVersionId,
        ));
    if (!currentSetValid || !previousSetValid || !currentFactsValid || !previousFactsValid) {
      throw new Error("The Figma checkpoint comparison is invalid.");
    }
    const previousComparableFacts = previousSet ? previousFacts : [];
    const comparison = compareFigmaCheckpointFacts({
      current: currentFacts.map((fact) => ({
        factId: fact._id,
        nodeId: fact.nodeId,
        nodeName: fact.nodeName,
        nodeType: fact.nodeType,
        pageName: fact.pageName,
        semanticHash: fact.semanticHash,
        renderState: fact.render.state,
      })),
      previous: previousComparableFacts.map((fact) => ({
        factId: fact._id,
        nodeId: fact.nodeId,
        nodeName: fact.nodeName,
        nodeType: fact.nodeType,
        pageName: fact.pageName,
        semanticHash: fact.semanticHash,
        renderState: fact.render.state,
      })),
      currentTruncated: currentSet.truncated,
      previousTruncated:
        previousEntry !== undefined &&
        (previousSnapshot === null || previousSet === null || previousSet.truncated),
    });
    return {
      current: {
        checkpointSetId: checkpoint._id,
        snapshotId: snapshot._id,
        providerVersionId: snapshot.providerVersionId,
        capturedAt: snapshot.capturedAt,
        truncated: currentSet.truncated,
      },
      previous: {
        checkpointSetId: previousCheckpoint._id,
        ...(previousSnapshot
          ? {
              snapshotId: previousSnapshot._id,
              providerVersionId: previousSnapshot.providerVersionId,
            }
          : {}),
        capturedAt: previousSnapshot?.capturedAt ?? previousCheckpoint.createdAt,
        truncated:
          previousEntry !== undefined &&
          (previousSnapshot === null || previousSet === null || previousSet.truncated),
      },
      counts: comparison.counts,
      rows: comparison.rows,
    };
  },
});

function availablePreview(
  fact: Doc<"figmaNodeFacts"> | null,
  args: {
    expectedFactId: Id<"figmaNodeFacts">;
    eventId: Id<"events">;
    teamId: Id<"teams">;
    bindingId: Id<"figmaFileBindings">;
    snapshotId: Id<"figmaFileSnapshots">;
    previewSetId: Id<"figmaPreviewSets">;
    providerVersionId: string;
    capturedAt: number;
  },
) {
  if (
    !fact ||
    fact._id !== args.expectedFactId ||
    fact.eventId !== args.eventId ||
    fact.teamId !== args.teamId ||
    fact.figmaFileBindingId !== args.bindingId ||
    fact.snapshotId !== args.snapshotId ||
    fact.previewSetId !== args.previewSetId ||
    fact.providerVersionId !== args.providerVersionId ||
    fact.render.state !== "available"
  ) {
    throw new ConvexError({
      code: "FIGMA_PREVIEW_UNAVAILABLE",
      message: "That rendered frame is unavailable in the fixed evidence.",
    });
  }
  return {
    factId: fact._id,
    snapshotId: fact.snapshotId,
    previewSetId: fact.previewSetId,
    objectKey: fact.render.objectKey,
    storageRegion: fact.render.storageRegion,
    storageBucket: fact.render.storageBucket,
    byteCount: fact.render.byteCount,
    sha256: fact.render.sha256,
    width: fact.render.width,
    height: fact.render.height,
    nodeName: fact.nodeName,
    capturedAt: args.capturedAt,
    providerVersionId: args.providerVersionId,
  };
}

const privateFigmaPreviewContext = v.object({
  factId: v.id("figmaNodeFacts"),
  snapshotId: v.id("figmaFileSnapshots"),
  previewSetId: v.id("figmaPreviewSets"),
  objectKey: v.string(),
  storageRegion: v.string(),
  storageBucket: v.string(),
  byteCount: v.number(),
  sha256: v.string(),
  width: v.number(),
  height: v.number(),
  nodeName: v.string(),
  capturedAt: v.number(),
  providerVersionId: v.string(),
});

function samePrivateFigmaPreview(
  left: ReturnType<typeof availablePreview>,
  right: ReturnType<typeof availablePreview>,
) {
  return (
    left.factId === right.factId &&
    left.snapshotId === right.snapshotId &&
    left.previewSetId === right.previewSetId &&
    left.objectKey === right.objectKey &&
    left.storageRegion === right.storageRegion &&
    left.storageBucket === right.storageBucket &&
    left.byteCount === right.byteCount &&
    left.sha256 === right.sha256 &&
    left.width === right.width &&
    left.height === right.height &&
    left.nodeName === right.nodeName &&
    left.capturedAt === right.capturedAt &&
    left.providerVersionId === right.providerVersionId
  );
}

export const figmaComparisonPreviewAccessContext = internalQuery({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
    currentFactId: v.optional(v.id("figmaNodeFacts")),
    previousFactId: v.optional(v.id("figmaNodeFacts")),
  },
  returns: v.object({
    current: v.optional(privateFigmaPreviewContext),
    previous: v.optional(privateFigmaPreviewContext),
  }),
  handler: async (ctx, args) => {
    if (!args.currentFactId && !args.previousFactId) {
      throw new ConvexError({
        code: "FIGMA_COMPARISON_INVALID",
        message: "Choose a rendered frame from the fixed comparison.",
      });
    }
    const { event, session, checkpoint, binding, snapshot } = await pinnedFigmaContext(ctx, args);
    if (!checkpoint.previousCheckpointSetId) {
      throw new ConvexError({
        code: "FIGMA_COMPARISON_UNAVAILABLE",
        message: "This review has no earlier judging checkpoint to compare.",
      });
    }
    const previousCheckpoint = await ctx.db.get(checkpoint.previousCheckpointSetId,
    );
    if (
      !previousCheckpoint ||
      previousCheckpoint.eventId !== event._id ||
      previousCheckpoint.teamId !== session.teamId ||
      previousCheckpoint.roundSequence >= checkpoint.roundSequence ||
      previousCheckpoint.createdAt > checkpoint.createdAt
    ) {
      throw new Error("The previous review evidence checkpoint is invalid.");
    }
    const previousEntry = previousCheckpoint.figmaEntries.find(
      (entry) => entry.bindingId === binding._id,
    );
    const previousSnapshot = previousEntry?.snapshotId
      ? await ctx.db.get(previousEntry.snapshotId)
      : null;
    if (
      previousSnapshot &&
      (previousSnapshot.eventId !== event._id ||
        previousSnapshot.teamId !== session.teamId ||
        previousSnapshot.figmaFileBindingId !== binding._id ||
        previousSnapshot.capturedAt > snapshot.capturedAt)
    ) {
      throw new Error("The previous pinned Figma snapshot is invalid.");
    }
    if (args.previousFactId && !previousSnapshot) {
      throw new ConvexError({
        code: "FIGMA_COMPARISON_UNAVAILABLE",
        message: "The earlier judging checkpoint has no rendered frame for this file.",
      });
    }
    const [currentSet, previousSet, currentFact, previousFact] = await Promise.all([
      ctx.db
        .query("figmaPreviewSets")
        .withIndex("by_snapshot", (index) => index.eq("snapshotId", snapshot._id),
          )
        .unique(),
      previousSnapshot
        ? ctx.db
            .query("figmaPreviewSets")
            .withIndex("by_snapshot", (index) => index.eq("snapshotId", previousSnapshot._id),
              )
            .unique()
        : Promise.resolve(null),
      args.currentFactId ? ctx.db.get(args.currentFactId) : Promise.resolve(null),
      args.previousFactId ? ctx.db.get(args.previousFactId) : Promise.resolve(null),
    ]);
    if (!currentSet || (args.previousFactId && !previousSet)) {
      throw new ConvexError({
        code: "FIGMA_COMPARISON_UNAVAILABLE",
        message: "The fixed comparison does not have rendered checkpoint sets.",
      });
    }
    if (
      currentSet.eventId !== event._id ||
      currentSet.teamId !== session.teamId ||
      currentSet.figmaFileBindingId !== binding._id ||
      currentSet.providerVersionId !== snapshot.providerVersionId ||
      (previousSet !== null &&
        (previousSnapshot === null ||
          previousSet.eventId !== event._id ||
          previousSet.teamId !== session.teamId ||
          previousSet.figmaFileBindingId !== binding._id ||
          previousSet.providerVersionId !== previousSnapshot.providerVersionId))
    ) {
      throw new Error("The fixed Figma comparison sets are invalid.");
    }
    if (currentFact && previousFact && currentFact.nodeId !== previousFact.nodeId) {
      throw new ConvexError({
        code: "FIGMA_COMPARISON_INVALID",
        message: "Choose both sides of the same fixed frame comparison.",
      });
    }
    let previousPreview;
    if (args.previousFactId) {
      const previous = requirePrevious(previousSnapshot, previousSet);
      previousPreview = availablePreview(previousFact, {
        expectedFactId: args.previousFactId,
        eventId: event._id,
        teamId: session.teamId,
        bindingId: binding._id,
        snapshotId: previous.snapshot._id,
        previewSetId: previous.previewSet._id,
        providerVersionId: previous.snapshot.providerVersionId,
        capturedAt: previous.snapshot.capturedAt,
      });
    }
    return {
      ...(args.currentFactId
        ? {
            current: availablePreview(currentFact, {
              expectedFactId: args.currentFactId,
              eventId: event._id,
              teamId: session.teamId,
              bindingId: binding._id,
              snapshotId: snapshot._id,
              previewSetId: currentSet._id,
              providerVersionId: snapshot.providerVersionId,
              capturedAt: snapshot.capturedAt,
            }),
          }
        : {}),
      ...(previousPreview ? { previous: previousPreview } : {}),
    };
  },
});

export const recordFigmaComparisonPreviewAccess = internalMutation({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
    currentFactId: v.optional(v.id("figmaNodeFacts")),
    previousFactId: v.optional(v.id("figmaNodeFacts")),
    expectedCurrent: v.optional(privateFigmaPreviewContext),
    expectedPrevious: v.optional(privateFigmaPreviewContext),
    signedUrlExpiresAt: v.number(),
  },
  returns: v.object({ serverNow: v.number() }),
  handler: async (ctx, args) => {
    if (
      (args.currentFactId === undefined) !== (args.expectedCurrent === undefined) ||
      (args.previousFactId === undefined) !== (args.expectedPrevious === undefined) ||
      (!args.currentFactId && !args.previousFactId)
    ) {
      throw new ConvexError({
        code: "FIGMA_COMPARISON_INVALID",
        message: "Choose a rendered frame from the fixed comparison.",
      });
    }
    const context = await pinnedFigmaContext(ctx, args);
    const { event, person, session, checkpoint, binding, snapshot, grantIds, permissionScope,
    } =
      context;
    if (!checkpoint.previousCheckpointSetId) {
      throw new ConvexError({
        code: "FIGMA_COMPARISON_UNAVAILABLE",
        message: "This review has no earlier judging checkpoint to compare.",
      });
    }
    const previousCheckpoint = await ctx.db.get(checkpoint.previousCheckpointSetId,
    );
    if (
      !previousCheckpoint ||
      previousCheckpoint.eventId !== event._id ||
      previousCheckpoint.teamId !== session.teamId ||
      previousCheckpoint.roundSequence >= checkpoint.roundSequence ||
      previousCheckpoint.createdAt > checkpoint.createdAt
    ) {
      throw new Error("The previous review evidence checkpoint is invalid.");
    }
    const previousEntry = previousCheckpoint.figmaEntries.find(
      (entry) => entry.bindingId === binding._id,
    );
    const previousSnapshot = previousEntry?.snapshotId
      ? await ctx.db.get(previousEntry.snapshotId)
      : null;
    if (
      previousSnapshot &&
      (previousSnapshot.eventId !== event._id ||
        previousSnapshot.teamId !== session.teamId ||
        previousSnapshot.figmaFileBindingId !== binding._id ||
        previousSnapshot.capturedAt > snapshot.capturedAt)
    ) {
      throw new Error("The previous pinned Figma snapshot is invalid.");
    }
    if (args.previousFactId && !previousSnapshot) {
      throw new ConvexError({
        code: "FIGMA_COMPARISON_UNAVAILABLE",
        message: "The earlier judging checkpoint has no rendered frame for this file.",
      });
    }
    const [currentSet, previousSet, currentFact, previousFact] = await Promise.all([
      ctx.db
        .query("figmaPreviewSets")
        .withIndex("by_snapshot", (index) => index.eq("snapshotId", snapshot._id),
          )
        .unique(),
      previousSnapshot
        ? ctx.db
            .query("figmaPreviewSets")
            .withIndex("by_snapshot", (index) => index.eq("snapshotId", previousSnapshot._id),
              )
            .unique()
        : Promise.resolve(null),
      args.currentFactId ? ctx.db.get(args.currentFactId) : Promise.resolve(null),
      args.previousFactId ? ctx.db.get(args.previousFactId) : Promise.resolve(null),
    ]);
    if (!currentSet || (args.previousFactId && !previousSet)) {
      throw new ConvexError({
        code: "FIGMA_COMPARISON_UNAVAILABLE",
        message: "The fixed comparison does not have rendered checkpoint sets.",
      });
    }
    if (
      currentSet.eventId !== event._id ||
      currentSet.teamId !== session.teamId ||
      currentSet.figmaFileBindingId !== binding._id ||
      currentSet.providerVersionId !== snapshot.providerVersionId ||
      (previousSet !== null &&
        (previousSnapshot === null ||
          previousSet.eventId !== event._id ||
          previousSet.teamId !== session.teamId ||
          previousSet.figmaFileBindingId !== binding._id ||
          previousSet.providerVersionId !== previousSnapshot.providerVersionId))
    ) {
      throw new Error("The fixed Figma comparison sets are invalid.");
    }
    if (currentFact && previousFact && currentFact.nodeId !== previousFact.nodeId) {
      throw new ConvexError({
        code: "FIGMA_COMPARISON_INVALID",
        message: "Choose both sides of the same fixed frame comparison.",
      });
    }
    const currentPreview = args.currentFactId
      ? availablePreview(currentFact, {
          expectedFactId: args.currentFactId,
          eventId: event._id,
          teamId: session.teamId,
          bindingId: binding._id,
          snapshotId: snapshot._id,
          previewSetId: currentSet._id,
          providerVersionId: snapshot.providerVersionId,
          capturedAt: snapshot.capturedAt,
        })
      : undefined;
    let previousPreview: ReturnType<typeof availablePreview> | undefined;
    if (args.previousFactId) {
      const previous = requirePrevious(previousSnapshot, previousSet);
      previousPreview = availablePreview(previousFact, {
        expectedFactId: args.previousFactId,
        eventId: event._id,
        teamId: session.teamId,
        bindingId: binding._id,
        snapshotId: previous.snapshot._id,
        previewSetId: previous.previewSet._id,
        providerVersionId: previous.snapshot.providerVersionId,
        capturedAt: previous.snapshot.capturedAt,
      });
    }
    if (
      (args.expectedCurrent !== undefined &&
        (!currentPreview || !samePrivateFigmaPreview(currentPreview, args.expectedCurrent))) ||
      (args.expectedPrevious !== undefined &&
        (!previousPreview || !samePrivateFigmaPreview(previousPreview, args.expectedPrevious)))
    ) {
      throw new ConvexError({
        code: "FIGMA_PREVIEW_CHANGED",
        message: "The fixed Figma comparison changed while its links were prepared. Try again.",
      });
    }
    const serverNow = Date.now();
    if (
      !Number.isSafeInteger(args.signedUrlExpiresAt) ||
      args.signedUrlExpiresAt <= serverNow ||
      args.signedUrlExpiresAt > serverNow + 60_000
    ) {
      throw new ConvexError({
        code: "FIGMA_PREVIEW_LINK_EXPIRED",
        message: "The Figma comparison links expired while they were prepared. Try again.",
      });
    }
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.evidence.read",
      grantIds,
      scopeType: permissionScope.scopeType,
      scopeId: permissionScope.scopeId,
      action: "review.figma_comparison_preview_opened",
      targetType: "review_session",
      targetId: session._id,
      nextSummary: JSON.stringify({
        bindingId: binding._id,
        currentFactId: currentPreview?.factId,
        currentSha256: currentPreview?.sha256,
        previousFactId: previousPreview?.factId,
        previousSha256: previousPreview?.sha256,
        signedUrlExpiresAt: args.signedUrlExpiresAt,
      }),
      reason: "Opened rendered frames from a fixed review comparison",
    });
    return { serverNow };
  },
});

function requirePrevious(
  snapshot: Doc<"figmaFileSnapshots"> | null,
  previewSet: Doc<"figmaPreviewSets"> | null,
) {
  if (!snapshot || !previewSet) {
    throw new Error("The validated previous Figma comparison is unavailable.");
  }
  return { snapshot, previewSet };
}

async function requireFigmaPreviewAccess(
  ctx: ReadCtx,
  args: {
    eventSlug: string;
    reviewSessionId: Id<"reviewSessions">;
    bindingId: Id<"figmaFileBindings">;
    factId: Id<"figmaNodeFacts">;
  },
) {
  const context = await pinnedFigmaContext(ctx, args);
  const { event, session, binding, snapshot } = context;
  const [previewSet, fact] = await Promise.all([
    ctx.db
      .query("figmaPreviewSets")
      .withIndex("by_snapshot", (index) => index.eq("snapshotId", snapshot._id))
      .unique(),
    ctx.db.get(args.factId),
  ]);
  if (
    !previewSet ||
    previewSet.eventId !== event._id ||
    previewSet.teamId !== session.teamId ||
    previewSet.figmaFileBindingId !== binding._id ||
    previewSet.providerVersionId !== snapshot.providerVersionId
  ) {
    throw new ConvexError({
      code: "FIGMA_PREVIEW_UNAVAILABLE",
      message: "This rendered frame is unavailable in the pinned checkpoint.",
    });
  }
  const preview = availablePreview(fact, {
    expectedFactId: args.factId,
    eventId: event._id,
    teamId: session.teamId,
    bindingId: binding._id,
    snapshotId: snapshot._id,
    previewSetId: previewSet._id,
    providerVersionId: snapshot.providerVersionId,
    capturedAt: snapshot.capturedAt,
  });
  return { ...context, preview };
}

export const figmaPreviewAccessContext = internalQuery({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
    factId: v.id("figmaNodeFacts"),
  },
  returns: privateFigmaPreviewContext,
  handler: async (ctx, args) => {
    const { preview } = await requireFigmaPreviewAccess(ctx, args);
    return preview;
  },
});

export const recordFigmaPreviewAccess = internalMutation({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
    factId: v.id("figmaNodeFacts"),
    expected: privateFigmaPreviewContext,
    signedUrlExpiresAt: v.number(),
  },
  returns: v.object({ serverNow: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, session, binding, preview, grantIds, permissionScope,
    } =
      await requireFigmaPreviewAccess(ctx, args);
    if (!samePrivateFigmaPreview(preview, args.expected)) {
      throw new ConvexError({
        code: "FIGMA_PREVIEW_CHANGED",
        message: "The fixed Figma frame changed while its link was prepared. Try again.",
      });
    }
    const serverNow = Date.now();
    if (
      !Number.isSafeInteger(args.signedUrlExpiresAt) ||
      args.signedUrlExpiresAt <= serverNow ||
      args.signedUrlExpiresAt > serverNow + 60_000
    ) {
      throw new ConvexError({
        code: "FIGMA_PREVIEW_LINK_EXPIRED",
        message: "The Figma frame link expired while it was prepared. Try again.",
      });
    }
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.evidence.read",
      grantIds,
      scopeType: permissionScope.scopeType,
      scopeId: permissionScope.scopeId,
      action: "review.figma_preview_opened",
      targetType: "figma_node_fact",
      targetId: preview.factId,
      nextSummary: JSON.stringify({
        reviewSessionId: session._id,
        bindingId: binding._id,
        snapshotId: preview.snapshotId,
        sha256: preview.sha256,
        signedUrlExpiresAt: args.signedUrlExpiresAt,
      }),
      reason: "Opened a rendered frame from fixed review evidence",
    });
    return { serverNow };
  },
});
