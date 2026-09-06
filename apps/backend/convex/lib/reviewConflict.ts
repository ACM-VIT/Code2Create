import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** Current team membership is a conflict even when nobody has filed a conflict report. */
export async function hasReviewConflict(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  teamId: Id<"teams">,
) {
  const declared = await ctx.db
    .query("reviewerConflicts")
    .withIndex("by_reviewer_team_status", (q) =>
      q
        .eq("reviewerPersonId", personId)
        .eq("teamId", teamId)
        .eq("status", "active"),
    )
    .first();
  if (declared) return true;
  const membership = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_person", (q) =>
      q.eq("eventId", eventId).eq("personId", personId),
    )
    .unique();
  return (
    !!membership &&
    !!(await ctx.db
      .query("teamMembers")
      .withIndex("by_team_membership_status", (q) =>
        q
          .eq("teamId", teamId)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .first())
  );
}
