import { internal } from "../_generated/api";
import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  normalizedReviewerAvailabilityWindows,
  type ReviewerAvailabilityWindow,
} from "./reviewerAvailability";

export function confirmedReviewWindows(
  windows: readonly ReviewerAvailabilityWindow[],
  round: Pick<
    Doc<"reviewRounds">,
    "startsAt" | "endsAt" | "reviewDurationSeconds"
  >,
) {
  const normalized = normalizedReviewerAvailabilityWindows(windows);
  if (
    normalized.some(
      (window) =>
        window.startsAt < round.startsAt ||
        window.endsAt > round.endsAt ||
        window.endsAt - window.startsAt < round.reviewDurationSeconds * 1_000,
    )
  ) {
    throw new ConvexError({
      code: "INVALID_REVIEW_CONFIRMATION",
      message:
        "Choose hours within this round, with enough time for a complete review.",
    });
  }
  return normalized;
}

export async function reviewerConfirmedWindow(
  ctx: QueryCtx | MutationCtx,
  round: Doc<"reviewRounds">,
  personId: Id<"people">,
  now: number,
  preparationSeconds = 0,
) {
  const confirmation = await ctx.db
    .query("reviewerRoundConfirmations")
    .withIndex("by_roundId_and_personId", (q) =>
      q.eq("roundId", round._id).eq("personId", personId),
    )
    .unique();
  const startsAt = Math.max(now, round.startsAt);
  const endsAt =
    startsAt + (round.reviewDurationSeconds + preparationSeconds) * 1_000;
  return confirmation?.status === "confirmed"
    ? (confirmation.windows.find(
        (window) => window.startsAt <= startsAt && window.endsAt >= endsAt,
      ) ?? null)
    : null;
}

export async function reviewerConfirmedForReview(
  ctx: QueryCtx | MutationCtx,
  round: Doc<"reviewRounds">,
  personId: Id<"people">,
  now: number,
  preparationSeconds = 0,
) {
  return (
    (await reviewerConfirmedWindow(
      ctx,
      round,
      personId,
      now,
      preparationSeconds,
    )) !== null
  );
}

export async function requireConfirmedReviewer(
  ctx: QueryCtx | MutationCtx,
  round: Doc<"reviewRounds">,
  personId: Id<"people">,
  now: number,
  preparationSeconds = 0,
) {
  if (
    !(await reviewerConfirmedForReview(
      ctx,
      round,
      personId,
      now,
      preparationSeconds,
    ))
  ) {
    throw new ConvexError({
      code: "REVIEWER_CONFIRMATION_REQUIRED",
      message:
        "Confirm your availability in the app for this review's full duration before joining.",
    });
  }
}

export async function requireConfirmedClockIn(
  ctx: QueryCtx | MutationCtx,
  round: Doc<"reviewRounds">,
  personId: Id<"people">,
  now: number,
) {
  const confirmation = await ctx.db
    .query("reviewerRoundConfirmations")
    .withIndex("by_roundId_and_personId", (q) =>
      q.eq("roundId", round._id).eq("personId", personId),
    )
    .unique();
  if (
    confirmation?.status !== "confirmed" ||
    !confirmation.windows.some(
      (window) =>
        window.startsAt <=
          now + Math.max(0, round.startsAt - round.clockInOpensAt) &&
        window.endsAt >=
          Math.max(now, window.startsAt) + round.reviewDurationSeconds * 1000,
    )
  ) {
    throw new ConvexError({
      code: "REVIEWER_CONFIRMATION_REQUIRED",
      message:
        "Confirm your availability in the app for a complete review, then clock in within the published early-arrival window for your shift.",
    });
  }
}

export async function scheduleShiftReminders(
  ctx: MutationCtx,
  confirmation: Doc<"reviewerRoundConfirmations">,
  round: Doc<"reviewRounds">,
  now: number,
) {
  if (
    confirmation.status !== "confirmed" ||
    round.staffing.assignmentReminderSeconds === 0
  )
    return;
  for (const window of confirmation.windows) {
    if (window.startsAt <= now) continue;
    await ctx.scheduler.runAt(
      Math.max(
        now,
        window.startsAt - round.staffing.assignmentReminderSeconds * 1000,
      ),
      internal.reviewConfirmations.prepareShiftReminder,
      {
        confirmationId: confirmation._id,
        confirmationVersion: confirmation.version,
        shiftStartsAt: window.startsAt,
      },
    );
  }
}
