import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { venueReviewer, venuePresence } from "./lib/reviewerVenue";

export const acknowledgeWarning = mutation({
  args: { eventSlug: v.string(), departureId: v.id("reviewerVenueDepartures") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { event, person } = await venueReviewer(ctx, args.eventSlug);
    const presence = await venuePresence(ctx, event._id, person._id);
    if (presence?.departureId !== args.departureId) return null;
    const departure = await ctx.db.get(args.departureId);
    if (departure?.state === "open" && departure.notifiedAt === undefined)
      await ctx.db.patch(departure._id, {
        notifiedAt: Date.now(),
        reminderStartedAt: departure.reminderStartedAt ?? Date.now(),
        updatedAt: Date.now(),
      });
    return null;
  },
});
