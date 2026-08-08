import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { pushTokenFingerprint } from "./lib/pushTokens";

const maxSendAttempts = 3;
const sendClaimMs = 15_000;

const deliveryClaim = v.union(
  v.null(),
  v.object({
    pageId: v.id("reviewerPages"),
    token: v.string(),
    provider: v.union(v.literal("fcm"), v.literal("apns")),
    environment: v.union(v.literal("development"), v.literal("production")),
    roundName: v.string(),
    tableLabel: v.string(),
    expiresAt: v.number(),
  }),
);

export const claimDelivery = internalMutation({
  args: {
    deliveryId: v.id("reviewerPushDeliveries"),
    attemptId: v.string(),
  },
  returns: deliveryClaim,
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery) return null;
    const now = Date.now();
    const canClaim =
      delivery.state === "pending" ||
      (delivery.state === "retry_wait" && (delivery.nextAttemptAt ?? 0) <= now) ||
      (delivery.state === "sending" && (delivery.claimExpiresAt ?? 0) <= now);
    if (!canClaim) return null;

    const [page, device] = await Promise.all([
      ctx.db.get(delivery.pageId),
      ctx.db.get(delivery.reviewerDeviceId),
    ]);
    if (
      !page ||
      page.eventId !== delivery.eventId ||
      page.targetPersonId !== delivery.targetPersonId ||
      (page.state !== "sent" && page.state !== "opened") ||
      page.expiresAt <= now
    ) {
      await ctx.db.patch(delivery._id, {
        state: "superseded",
        attemptId: undefined,
        claimExpiresAt: undefined,
        nextAttemptAt: undefined,
        providerErrorCode: "page_no_longer_active",
        version: delivery.version + 1,
        updatedAt: now,
        completedAt: now,
      });
      return null;
    }
    if (
      !device ||
      device.eventId !== delivery.eventId ||
      device.personId !== delivery.targetPersonId ||
      device.status !== "active" ||
      device.pushTokenStatus !== "active" ||
      device.pushToken === undefined ||
      device.pushProvider === undefined ||
      device.pushEnvironment === undefined ||
      delivery.tokenFingerprint === undefined ||
      pushTokenFingerprint(device.pushToken) !== delivery.tokenFingerprint
    ) {
      await ctx.db.patch(delivery._id, {
        state: "unavailable",
        attemptId: undefined,
        claimExpiresAt: undefined,
        nextAttemptAt: undefined,
        providerErrorCode: "push_token_unavailable",
        version: delivery.version + 1,
        updatedAt: now,
        completedAt: now,
      });
      return null;
    }
    if (delivery.attemptCount >= maxSendAttempts) {
      await ctx.db.patch(delivery._id, {
        state: "failed",
        attemptId: undefined,
        claimExpiresAt: undefined,
        nextAttemptAt: undefined,
        providerErrorCode: "send_attempts_exhausted",
        version: delivery.version + 1,
        updatedAt: now,
        completedAt: now,
      });
      return null;
    }

    const [panel, round] = await Promise.all([
      ctx.db.get(page.panelId),
      ctx.db.get(page.roundId),
    ]);
    if (!panel || !round || panel.eventId !== delivery.eventId || round.eventId !== delivery.eventId) {
      await ctx.db.patch(delivery._id, {
        state: "failed",
        attemptId: undefined,
        claimExpiresAt: undefined,
        nextAttemptAt: undefined,
        providerErrorCode: "page_context_invalid",
        version: delivery.version + 1,
        updatedAt: now,
        completedAt: now,
      });
      return null;
    }

    const claimExpiresAt = Math.min(page.expiresAt, now + sendClaimMs);
    await ctx.db.patch(delivery._id, {
      state: "sending",
      attemptCount: delivery.attemptCount + 1,
      attemptId: args.attemptId,
      claimExpiresAt,
      nextAttemptAt: undefined,
      providerErrorCode: undefined,
      version: delivery.version + 1,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(claimExpiresAt, internal.reviewPush.deliverPage, {
      deliveryId: delivery._id,
    });
    return {
      pageId: page._id,
      token: device.pushToken,
      provider: device.pushProvider,
      environment: device.pushEnvironment,
      roundName: round.name,
      tableLabel: panel.tableLabel,
      expiresAt: page.expiresAt,
    };
  },
});

export const recordProviderAcceptance = internalMutation({
  args: {
    deliveryId: v.id("reviewerPushDeliveries"),
    attemptId: v.string(),
    providerMessageId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.state !== "sending" || delivery.attemptId !== args.attemptId) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(delivery._id, {
      state: "provider_accepted",
      attemptId: undefined,
      claimExpiresAt: undefined,
      nextAttemptAt: undefined,
      providerMessageId: args.providerMessageId,
      providerErrorCode: undefined,
      version: delivery.version + 1,
      updatedAt: now,
      completedAt: now,
    });
    return null;
  },
});

export const recordSendFailure = internalMutation({
  args: {
    deliveryId: v.id("reviewerPushDeliveries"),
    attemptId: v.string(),
    errorCode: v.string(),
    retryable: v.boolean(),
    invalidateToken: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.state !== "sending" || delivery.attemptId !== args.attemptId) {
      return null;
    }
    const now = Date.now();
    const page = await ctx.db.get(delivery.pageId);
    if (args.invalidateToken && delivery.tokenFingerprint !== undefined) {
      const device = await ctx.db.get(delivery.reviewerDeviceId);
      if (
        device &&
        device.pushTokenStatus === "active" &&
        device.pushToken !== undefined &&
        pushTokenFingerprint(device.pushToken) === delivery.tokenFingerprint
      ) {
        await ctx.db.patch(device._id, {
          pushTokenStatus: "invalid",
          pushTokenInvalidatedAt: now,
          pushTokenFailureCode: args.errorCode,
          version: device.version + 1,
        });
      }
    }

    const pageStillActive =
      page !== null &&
      (page.state === "sent" || page.state === "opened") &&
      page.expiresAt > now;
    const retry = args.retryable && delivery.attemptCount < maxSendAttempts && pageStillActive;
    if (retry) {
      const delayMs = delivery.attemptCount === 1 ? 2_000 : 5_000;
      const nextAttemptAt = now + delayMs;
      if (page && nextAttemptAt < page.expiresAt) {
        await ctx.db.patch(delivery._id, {
          state: "retry_wait",
          attemptId: undefined,
          claimExpiresAt: undefined,
          nextAttemptAt,
          providerErrorCode: args.errorCode,
          version: delivery.version + 1,
          updatedAt: now,
        });
        await ctx.scheduler.runAt(nextAttemptAt, internal.reviewPush.deliverPage, {
          deliveryId: delivery._id,
        });
        return null;
      }
    }

    await ctx.db.patch(delivery._id, {
      state: "failed",
      attemptId: undefined,
      claimExpiresAt: undefined,
      nextAttemptAt: undefined,
      providerErrorCode: args.errorCode,
      version: delivery.version + 1,
      updatedAt: now,
      completedAt: now,
    });
    return null;
  },
});
