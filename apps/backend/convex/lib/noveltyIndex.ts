import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

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
