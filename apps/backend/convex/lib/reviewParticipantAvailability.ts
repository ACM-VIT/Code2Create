import { ConvexError } from "convex/values";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { readAttendanceTeamAvailability } from "./attendanceTeamAvailability";

type ReadCtx = QueryCtx | MutationCtx;

export async function readReviewParticipantAvailability(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
  },
) {
  const availability = await readAttendanceTeamAvailability(ctx, args);
  return {
    activeCount: availability.activeMemberCount,
    availableCount: availability.insideMemberCount,
  };
}

export async function findReviewParticipantAvailabilityWaiver(
  ctx: ReadCtx,
  reviewSessionId: Id<"reviewSessions">,
) {
  return ctx.db
    .query("reviewParticipantAvailabilityWaivers")
    .withIndex("by_review", (index) => index.eq("reviewSessionId", reviewSessionId))
    .unique();
}

export async function createReviewParticipantAvailabilityWaiver(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    roundId: Id<"reviewRounds">;
    teamId: Id<"teams">;
    reviewSessionId: Id<"reviewSessions">;
    requiredCount: number;
    observedCount: number;
    grantedByPersonId: Id<"people">;
    grantIds: Array<Id<"permissionGrants">>;
    reason: string;
    createdAt: number;
  },
) {
  if (await findReviewParticipantAvailabilityWaiver(ctx, args.reviewSessionId)) {
    throw new ConvexError({
      code: "PARTICIPANT_AVAILABILITY_ALREADY_WAIVED",
      message: "Participant availability is already waived for this review.",
    });
  }
  return ctx.db.insert("reviewParticipantAvailabilityWaivers", args);
}
