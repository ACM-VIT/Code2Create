import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { maximumReviewerAssignmentsPerEvent, maximumReviewRoundsPerEvent } from "./reviewLimits";

/** A panel seat reserves its round's hours even between reviews. Touching windows do not overlap. */
export async function reviewerHasOverlappingPanel(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  window: Pick<Doc<"reviewRounds">, "startsAt" | "endsAt">,
) {
  const memberships = await ctx.db
    .query("reviewPanelMembers")
    .withIndex("by_event_person_status", (q) =>
      q.eq("eventId", eventId).eq("personId", personId).eq("status", "active"),
    )
    .take(maximumReviewRoundsPerEvent + 1);
  if (memberships.length > maximumReviewRoundsPerEvent)
    throw new Error("A reviewer exceeds the event panel membership limit.");
  for (const membership of memberships) {
    const round = await ctx.db.get(membership.roundId);
    if (!round || round.eventId !== eventId)
      throw new Error("Reviewer panel membership has an invalid round.");
    if (
      (round.status === "published" || round.status === "open") &&
      round.startsAt < window.endsAt &&
      window.startsAt < round.endsAt
    )
      return true;
  }
  return false;
}

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
