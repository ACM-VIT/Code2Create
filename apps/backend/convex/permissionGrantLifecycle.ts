import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import {
  permissionGrantLifecycleBatchSize,
  sweepPermissionGrantLifecycle,
  transitionPermissionGrant,
} from "./lib/permissionGrantLifecycle";

export const transitionGrant = internalMutation({
  args: { grantId: v.id("permissionGrants") },
  returns: v.union(
    v.literal("activated"),
    v.literal("expired"),
    v.literal("unchanged"),
  ),
  handler: (ctx, args) =>
    transitionPermissionGrant(ctx, { grantId: args.grantId, now: Date.now() }),
});

export const sweep = internalMutation({
  args: {},
  returns: v.object({
    activated: v.number(),
    expired: v.number(),
    affectedSubjects: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx) => {
    const result = await sweepPermissionGrantLifecycle(ctx, {
      now: Date.now(),
      limit: permissionGrantLifecycleBatchSize,
    });
    if (result.hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.permissionGrantLifecycle.sweep,
        {},
      );
    }
    return result;
  },
});
