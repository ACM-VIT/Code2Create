import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { revokeSourceGrants } from "./permissions";

export async function cancelPendingReview(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    roundId: Id<"reviewRounds">;
    teamId: Id<"teams">;
    actorPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  const sessions = await ctx.db
    .query("reviewSessions")
    .withIndex("by_round_team_status", (index) =>
      index.eq("roundId", args.roundId).eq("teamId", args.teamId),
    )
    .collect();
  const pending = sessions.filter((session) => session.status === "awaiting_presence",
  );
  if (pending.length > 1) throw new Error("A team has more than one pending review session.");
  if (sessions.some((session) => session.status === "active" || session.status === "scoring",
    )) {
    throw new ConvexError({
      code: "REVIEW_ALREADY_STARTED",
      message:
        "A started review must be completed or handled through the active-review exception path.",
    });
  }
  const session = pending[0];
  if (!session) return null;
  const [assignments, scorecards, tokens] = await Promise.all([
    ctx.db
      .query("reviewAssignments")
      .withIndex("by_session_person", (index) => index.eq("reviewSessionId", session._id),
      )
      .collect(),
    ctx.db
      .query("scorecards")
      .withIndex("by_session_status", (index) => index.eq("reviewSessionId", session._id),
      )
      .collect(),
    ctx.db
      .query("reviewTeamQrTokens")
      .withIndex("by_session_state", (index) => index.eq("reviewSessionId", session._id),
      )
      .collect(),
  ]);
  for (const assignment of assignments.filter((row) => row.status === "assigned",
  )) {
    await ctx.db.patch(assignment._id, { status: "removed", endedAt: args.now,
    });
    await revokeSourceGrants(ctx, {
      eventId: args.eventId,
      sourceType: "panel_assignment",
      sourceId: assignment._id,
      revokedByPersonId: args.actorPersonId,
      reason: args.reason,
    });
  }
  for (const scorecard of scorecards) {
    if (scorecard.status !== "draft") {
      throw new Error("A pending review contains a non-draft scorecard.");
    }
    await ctx.db.patch(scorecard._id, {
      status: "void",
      version: scorecard.version + 1,
      updatedAt: args.now,
    });
  }
  for (const token of tokens.filter((row) => row.state === "active")) {
    await ctx.db.patch(token._id, { state: "superseded" });
  }
  await ctx.db.patch(session._id, {
    status: "cancelled",
    cancelledAt: args.now,
    version: session.version + 1,
    updatedAt: args.now,
  });
  return session._id;
}
