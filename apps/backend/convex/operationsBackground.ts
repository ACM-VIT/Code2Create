import { v } from "convex/values";

import { internalMutation } from "./_generated/server";

const backgroundHolder = v.union(v.literal("health_refresh"), v.literal("autonomy_tick"));
const backgroundLeaseKey = "operations_background";

export const claim = internalMutation({
  args: {
    holder: backgroundHolder,
    leaseId: v.string(),
    now: v.number(),
    leaseDurationMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("operationsBackgroundLeases")
      .withIndex("by_key", (index) => index.eq("key", backgroundLeaseKey))
      .unique();
    if (existing && existing.leaseExpiresAt > args.now) return false;

    const lease = {
      holder: args.holder,
      leaseId: args.leaseId,
      leaseExpiresAt: args.now + args.leaseDurationMs,
    };
    if (existing) await ctx.db.patch(existing._id, lease);
    else await ctx.db.insert("operationsBackgroundLeases", { key: backgroundLeaseKey, ...lease });
    return true;
  },
});

export const renew = internalMutation({
  args: {
    leaseId: v.string(),
    now: v.number(),
    leaseDurationMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("operationsBackgroundLeases")
      .withIndex("by_key", (index) => index.eq("key", backgroundLeaseKey))
      .unique();
    if (!existing || existing.leaseId !== args.leaseId) return false;

    await ctx.db.patch(existing._id, {
      leaseExpiresAt: args.now + args.leaseDurationMs,
    });
    return true;
  },
});

export const release = internalMutation({
  args: { leaseId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("operationsBackgroundLeases")
      .withIndex("by_key", (index) => index.eq("key", backgroundLeaseKey))
      .unique();
    if (!existing || existing.leaseId !== args.leaseId) return false;
    await ctx.db.delete(existing._id);
    return true;
  },
});
