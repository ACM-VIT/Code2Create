import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { maximumReviewerAssignmentsPerEvent } from "./reviewLimits";

/** Counts actual completed reviews, including earlier rounds of this event. Pages do not count. */
export async function reviewerParticipation(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
) {
  const assignments = await ctx.db
    .query("reviewAssignments")
    .withIndex("by_event_person_status", (q) =>
      q
        .eq("eventId", eventId)
        .eq("reviewerPersonId", personId)
        .eq("status", "assigned"),
    )
    .take(maximumReviewerAssignmentsPerEvent + 1);
  if (assignments.length > maximumReviewerAssignmentsPerEvent)
    throw new Error("A reviewer exceeds the event assignment limit.");
  let completedReviews = 0;
  let lastReviewedAt: number | undefined;
  let hasLiveReview = false;
  let hasActiveReview = false;
  for (const assignment of assignments) {
    const session = await ctx.db.get(assignment.reviewSessionId);
    if (!session || session.eventId !== eventId)
      throw new Error("Reviewer assignment has an invalid review session.");
    if (["awaiting_presence", "active", "scoring"].includes(session.status))
      hasLiveReview = true;
    if (["active", "scoring"].includes(session.status)) hasActiveReview = true;
    if (session.status === "completed") {
      if (session.completedAt === undefined)
        throw new Error("A completed review has no completion time.");
      completedReviews++;
      lastReviewedAt = Math.max(lastReviewedAt ?? 0, session.completedAt);
    }
  }
  return {
    completedReviews,
    ...(lastReviewedAt === undefined ? {} : { lastReviewedAt }),
    hasLiveReview,
    hasActiveReview,
  };
}
