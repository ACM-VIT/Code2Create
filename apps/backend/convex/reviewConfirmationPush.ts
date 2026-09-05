"use node";

import { randomUUID } from "node:crypto";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { sendReviewerPush } from "./reviewPush";

export const deliver = internalAction({
  args: { notificationId: v.id("reviewConfirmationNotifications") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attemptId = randomUUID();
    const claim = await ctx.runMutation(
      internal.reviewConfirmationPushState.claim,
      {
        ...args,
        attemptId,
      },
    );
    if (!claim) return null;
    const outcome = await sendReviewerPush({
      ...claim,
      title:
        claim.purpose === "availability"
          ? "Confirm your review availability"
          : "Your review duty starts soon",
      body:
        claim.purpose === "availability"
          ? `${claim.roundName}: choose the hours you can review in the app.`
          : `${claim.roundName}: clock in for your confirmed shift${claim.shiftStartsAt === undefined ? "." : ` at ${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(claim.shiftStartsAt)} IST.`}`,
      collapseKey: `availability-${args.notificationId}`,
      data: {
        kind:
          claim.purpose === "availability"
            ? "reviewer_availability_confirmation"
            : "reviewer_shift_reminder",
        roundId: claim.roundId,
      },
    });
    await ctx.runMutation(internal.reviewConfirmationPushState.finish, {
      ...args,
      attemptId,
      ok: outcome.ok,
      ...(outcome.ok
        ? {}
        : {
            errorCode: outcome.errorCode,
            retryable: outcome.retryable,
            invalidateToken: outcome.invalidateToken,
          }),
    });
    return null;
  },
});
