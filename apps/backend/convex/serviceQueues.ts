import { ConvexError, v } from "convex/values";

import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEligibleMembership,
  requireMembership,
} from "./lib/identity";

type ReadCtx = QueryCtx | MutationCtx;

const serviceQueueKind = v.literal("outing_permission");

const serviceQueueView = v.object({
  kind: serviceQueueKind,
  joined: v.boolean(),
  position: v.union(v.null(), v.number()),
  waitingCount: v.number(),
  joinedAt: v.union(v.null(), v.number()),
});

async function participantContext(ctx: ReadCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const membership = requireEligibleMembership(
    await requireMembership(ctx, event._id, person._id),
  );
  return { event, person, membership };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.array(serviceQueueView),
  handler: async (ctx, args) => {
    const { event, membership } = await participantContext(ctx, args.eventSlug);
    if (event.status !== "live") return [];
    const entries = await ctx.db
      .query("participantServiceQueueEntries")
      .withIndex("by_event_kind_joined", (index) =>
        index.eq("eventId", event._id).eq("kind", "outing_permission"),
      )
      .order("asc")
      .collect();
    const ownIndex = entries.findIndex((entry) => entry.membershipId === membership._id);
    return [{
      kind: "outing_permission" as const,
      joined: ownIndex >= 0,
      position: ownIndex >= 0 ? ownIndex + 1 : null,
      waitingCount: entries.length,
      joinedAt: ownIndex >= 0 ? (entries[ownIndex]?.joinedAt ?? null) : null,
    }];
  },
});

export const join = mutation({
  args: { eventSlug: v.string(), kind: serviceQueueKind },
  returns: v.object({ joined: v.boolean(), joinedAt: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership } = await participantContext(ctx, args.eventSlug);
    if (event.status !== "live") {
      throw new ConvexError({
        code: "QUEUE_CLOSED",
        message: "The outing permission queue is available while the event is live.",
      });
    }
    const existing = await ctx.db
      .query("participantServiceQueueEntries")
      .withIndex("by_membership_kind", (index) =>
        index.eq("membershipId", membership._id).eq("kind", args.kind),
      )
      .unique();
    if (existing) return { joined: false, joinedAt: existing.joinedAt };
    const joinedAt = Date.now();
    await ctx.db.insert("participantServiceQueueEntries", {
      eventId: event._id,
      membershipId: membership._id,
      personId: person._id,
      kind: args.kind,
      joinedAt,
    });
    return { joined: true, joinedAt };
  },
});

export const leave = mutation({
  args: { eventSlug: v.string(), kind: serviceQueueKind },
  returns: v.object({ left: v.boolean() }),
  handler: async (ctx, args) => {
    const { membership } = await participantContext(ctx, args.eventSlug);
    const existing = await ctx.db
      .query("participantServiceQueueEntries")
      .withIndex("by_membership_kind", (index) =>
        index.eq("membershipId", membership._id).eq("kind", args.kind),
      )
      .unique();
    if (!existing) return { left: false };
    await ctx.db.delete(existing._id);
    return { left: true };
  },
});
