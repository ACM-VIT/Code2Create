import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalQuery } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds } from "./lib/permissions";

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
