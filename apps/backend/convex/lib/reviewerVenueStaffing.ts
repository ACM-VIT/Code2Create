import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { reviewerParticipation } from "./reviewerParticipation";
import { resolveVenueDeparture, venuePresence } from "./reviewerVenue";

/** The same transaction that records a departure removes eligibility and queues staffing work. */
export async function clockOutForVenueDeparture(
  ctx: MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  reason: string,
  now: number,
) {
  if ((await reviewerParticipation(ctx, eventId, personId)).hasActiveReview) {
    throw new ConvexError({
      code: "ACTIVE_REVIEW_ASSIGNED",
      message: "Finish the current review and its scorecards before leaving.",
    });
  }
  const clockIns = (
    await Promise.all(
      (["present", "temporarily_unavailable"] as const).map((status) =>
        ctx.db
          .query("reviewerClockIns")
          .withIndex("by_person_status", (q) =>
            q.eq("reviewerPersonId", personId).eq("status", status),
          )
          .collect(),
      ),
    )
  )
    .flat()
    .filter((row) => row.eventId === eventId);
  for (const row of clockIns)
    await ctx.db.patch(row._id, {
      status: "clocked_out",
      clockedOutAt: now,
      unavailableReason: reason,
      expectedReturnAt: undefined,
      lastHeartbeatAt: now,
      version: row.version + 1,
    });
  const members = await ctx.db
    .query("reviewPanelMembers")
    .withIndex("by_event_person_status", (q) =>
      q.eq("eventId", eventId).eq("personId", personId).eq("status", "active"),
    )
    .collect();
  for (const panelId of new Set(members.map((row) => row.panelId)))
    await ctx.scheduler.runAfter(0, internal.reviewStaffing.checkPanel, {
      panelId,
    });
}

/** Clock-in is the single return-to-duty action. GPS remains advisory. */
export async function returnToReviewerDuty(
  ctx: MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  now: number,
) {
  const presence = await venuePresence(ctx, eventId, personId);
  if (!presence?.departureId) return;
  await resolveVenueDeparture(
    ctx,
    presence,
    presence.status === "reported_left" ? "returned" : "cancelled",
    now,
  );
  await ctx.db.patch(presence._id, {
    status: "unknown",
    observation: "uncertain",
    sampledAt: undefined,
    receivedAt: undefined,
    outsideSince: undefined,
    departureId: undefined,
    version: presence.version + 1,
    updatedAt: now,
  });
}
