import { ConvexError } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export async function requireEventBySlug(ctx: QueryCtx | MutationCtx, eventSlug: string) {
  const event = await ctx.db
    .query("events")
    .withIndex("by_slug", (index) => index.eq("slug", eventSlug.trim().toLowerCase()))
    .unique();
  if (!event) {
    throw new ConvexError({ code: "EVENT_NOT_FOUND", message: "The event does not exist." });
  }
  return event;
}

export function requireRegistrationOpen(event: Doc<"events">, now = Date.now()) {
  if (event.status !== "registration_open" || now >= event.applicationsCloseAt) {
    throw new ConvexError({
      code: "APPLICATIONS_CLOSED",
      message: "Applications are closed. Your saved work is still available to read.",
    });
  }
}
