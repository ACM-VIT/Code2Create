import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  activeAdmissionIdeaComparisonScope,
  noveltyIdeaComparisonScope,
  noveltyInputFingerprint,
  type NoveltyIdeaLifecycle,
} from "./novelty";

export function isActiveAdmissionIdeaState(state: Doc<"applications">["state"]) {
  return state === "submitted" || state === "under_review";
}

async function activeSubmittedIdeaFingerprint(
  ctx: MutationCtx,
  args: { eventId: Id<"events">; teamId: Id<"teams"> },
) {
  const application = await ctx.db
    .query("applications")
    .withIndex("by_team", (index) => index.eq("teamId", args.teamId))
    .unique();
  if (
    !application ||
    application.eventId !== args.eventId ||
    !isActiveAdmissionIdeaState(application.state)
  ) {
    return null;
  }
  const project = await ctx.db.get(application.submittedProjectVersionId);
  if (
    !project ||
    project.eventId !== args.eventId ||
    project.teamId !== args.teamId
  ) {
    throw new Error("The active application's submitted project is invalid.");
  }
  return noveltyInputFingerprint(project.initialIdea);
}

export async function comparisonScopeForTeamIdea(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    lifecycle: NoveltyIdeaLifecycle;
    inputFingerprint: string;
  },
) {
  if (args.lifecycle !== "submitted") {
    return noveltyIdeaComparisonScope(args.eventId, args.lifecycle);
  }
  const submittedFingerprint = await activeSubmittedIdeaFingerprint(ctx, args);
  return submittedFingerprint === args.inputFingerprint
    ? activeAdmissionIdeaComparisonScope(args.eventId)
    : noveltyIdeaComparisonScope(args.eventId, args.lifecycle);
}

export async function synchronizeTeamAdmissionIdeaComparison(
  ctx: MutationCtx,
  args: { eventId: Id<"events">; teamId: Id<"teams"> },
) {
  const ideas = await ctx.db
    .query("noveltyTeamIdeas")
    .withIndex("by_team", (index) => index.eq("teamId", args.teamId))
    .collect();
  const activeFingerprint = await activeSubmittedIdeaFingerprint(ctx, args);
  const activeIdea = ideas
    .filter(
      (idea) => idea.lifecycle === "submitted" && idea.inputFingerprint === activeFingerprint,
    )
    .toSorted(
      (left, right) =>
        right.sourceUpdatedAt - left.sourceUpdatedAt ||
        right._creationTime - left._creationTime,
    )[0];
  for (const idea of ideas) {
    if (idea.eventId !== args.eventId) {
      throw new Error("A team idea belongs to a different event than its team.");
    }
    const comparisonScope =
      idea._id === activeIdea?._id
        ? activeAdmissionIdeaComparisonScope(args.eventId)
        : noveltyIdeaComparisonScope(args.eventId, idea.lifecycle);
    if (idea.comparisonScope !== comparisonScope) {
      await ctx.db.patch(idea._id, { comparisonScope, updatedAt: Date.now() });
    }
  }
}

export async function invalidateTeamNoveltyIndex(
  ctx: MutationCtx,
  args: {
    teamId: Id<"teams">;
    sourceUpdatedAt: number;
  },
) {
  const [ideas, runningRequests] = await Promise.all([
    ctx.db
      .query("noveltyTeamIdeas")
      .withIndex("by_team", (index) => index.eq("teamId", args.teamId))
      .collect(),
    ctx.db
      .query("noveltyPreviewRequests")
      .withIndex("by_team_state_requested", (index) =>
        index.eq("teamId", args.teamId).eq("state", "running"),
      )
      .collect(),
  ]);
  await Promise.all([
    ...ideas
      .filter((idea) => idea.sourceUpdatedAt <= args.sourceUpdatedAt)
      .map((idea) => ctx.db.delete(idea._id)),
    ...runningRequests.map((request) =>
      ctx.db.patch(request._id, {
        state: "stale" as const,
        completedAt: args.sourceUpdatedAt,
        failureCategory: "idea_changed",
      }),
    ),
  ]);
}
