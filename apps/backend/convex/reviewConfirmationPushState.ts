import { isRoundReviewer } from "./lib/reviewRoster";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { pushTokenFingerprint } from "./lib/pushTokens";
import { matchingPermissionGrantIds } from "./lib/permissions";

export const claim = internalMutation({
  args: {
    notificationId: v.id("reviewConfirmationNotifications"),
    attemptId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      token: v.string(),
      provider: v.union(v.literal("fcm"), v.literal("apns")),
      environment: v.union(v.literal("development"), v.literal("production")),
      expiresAt: v.number(),
      roundName: v.string(),
      roundId: v.id("reviewRounds"),
      purpose: v.union(v.literal("availability"), v.literal("shift_reminder")),
      shiftStartsAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    const now = Date.now();
    if (
      !notification ||
      (notification.state !== "pending" &&
        !(
          notification.state === "sending" &&
          notification.claimExpiresAt !== undefined &&
          notification.claimExpiresAt <= now
        ))
    )
      return null;
    const confirmation = await ctx.db.get(notification.confirmationId);
    const round = confirmation ? await ctx.db.get(confirmation.roundId) : null;
    if (
      !confirmation ||
      confirmation.version !== notification.confirmationVersion ||
      (notification.purpose === "availability"
        ? confirmation.status !== "pending"
        : confirmation.status !== "confirmed" ||
          !confirmation.windows.some(
            (window) =>
              window.startsAt === notification.shiftStartsAt &&
              window.startsAt > now,
          )) ||
      !round ||
      !["published", "open"].includes(round.status) ||
      round.endsAt <= now ||
      !(await isRoundReviewer(ctx, round._id, confirmation.personId))
    ) {
      await ctx.db.patch(notification._id, {
        state: "cancelled",
        updatedAt: now,
      });
      return null;
    }
    let expiresAt = notification.shiftStartsAt ?? round.endsAt;
    if (notification.purpose === "availability") {
      const request = await ctx.db.query("reviewConfirmationRequests")
        .withIndex("by_roundId", q => q.eq("roundId", round._id)).unique();
      if (!request || request.state !== "open" || now < request.opensAt || now >= request.closesAt) {
        await ctx.db.patch(notification._id, { state: "cancelled", updatedAt: now });
        return null;
      }
      expiresAt = request.closesAt;
    }
    if (notification.purpose === "shift_reminder") {
      // Nothing sends reviewer shift reminders; a stored notification is cancelled.
      await ctx.db.patch(notification._id, { state: "cancelled", updatedAt: now });
      return null;
    }
    const subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", round.eventId).eq("personId", confirmation.personId),
      )
      .unique();
    if (
      !subject ||
      subject.status !== "active" ||
      (
        await matchingPermissionGrantIds(ctx, {
          eventId: round.eventId,
          eventAccessSubjectId: subject._id,
          permissionKey: "reviewer.clock_in",
          scopeType: "round",
          scopeId: round._id,
        })
      ).length === 0
    ) {
      await ctx.db.patch(notification._id, {
        state: "cancelled",
        errorCode: "reviewer_access_ended",
        updatedAt: now,
      });
      return null;
    }
    const devices = await ctx.db
      .query("reviewerDevices")
      .withIndex("by_event_person_status_seen", (q) =>
        q
          .eq("eventId", round.eventId)
          .eq("personId", confirmation.personId)
          .eq("status", "active"),
      )
      .order("desc")
      .take(10);
    const device = devices.find(
      (candidate) => candidate.pushTokenStatus === "active",
    );
    if (
      !device ||
      !device.pushToken ||
      !device.pushProvider ||
      !device.pushEnvironment
    ) {
      await ctx.db.patch(notification._id, {
        state: "unavailable",
        errorCode: "push_token_unavailable",
        updatedAt: now,
      });
      return null;
    }
    if (notification.attempts >= 3) {
      await ctx.db.patch(notification._id, {
        state: "failed",
        errorCode: "attempts_exhausted",
        updatedAt: now,
      });
      return null;
    }
    const claimExpiresAt = Math.min(now + 30_000, expiresAt);
    await ctx.db.patch(notification._id, {
      state: "sending",
      attemptId: args.attemptId,
      claimExpiresAt,
      attempts: notification.attempts + 1,
      deviceId: device._id,
      tokenFingerprint: pushTokenFingerprint(device.pushToken),
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      claimExpiresAt,
      internal.reviewConfirmationPush.deliver,
      {
        notificationId: notification._id,
      },
    );
    return {
      token: device.pushToken,
      provider: device.pushProvider,
      environment: device.pushEnvironment,
      expiresAt,
      roundName: round.name,
      roundId: round._id,
      purpose: notification.purpose,
      ...(notification.shiftStartsAt === undefined
        ? {}
        : { shiftStartsAt: notification.shiftStartsAt }),
    };
  },
});

export const finish = internalMutation({
  args: {
    notificationId: v.id("reviewConfirmationNotifications"),
    attemptId: v.string(),
    ok: v.boolean(),
    errorCode: v.optional(v.string()),
    retryable: v.optional(v.boolean()),
    invalidateToken: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    if (
      !notification ||
      notification.state !== "sending" ||
      notification.attemptId !== args.attemptId
    )
      return null;
    const now = Date.now();
    if (args.invalidateToken && notification.deviceId) {
      const device = await ctx.db.get(notification.deviceId);
      if (
        device?.pushToken &&
        pushTokenFingerprint(device.pushToken) === notification.tokenFingerprint
      ) {
        await ctx.db.patch(device._id, {
          pushTokenStatus: "invalid",
          pushTokenInvalidatedAt: now,
          pushTokenFailureCode: args.errorCode,
          version: device.version + 1,
        });
      }
    }
    const retry =
      !args.ok && args.retryable === true && notification.attempts < 3;
    await ctx.db.patch(notification._id, {
      state: args.ok ? "sent" : retry ? "pending" : "failed",
      attemptId: undefined,
      claimExpiresAt: undefined,
      errorCode: args.errorCode,
      updatedAt: now,
    });
    if (retry)
      await ctx.scheduler.runAfter(
        5_000,
        internal.reviewConfirmationPush.deliver,
        {
          notificationId: notification._id,
        },
      );
    return null;
  },
});
