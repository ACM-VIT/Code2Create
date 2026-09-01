import { ConvexError } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { ParticipantClass } from "../values";

type ApplicationDeadlineEvent = Pick<
  Doc<"events">,
  "applicationsCloseAt" | "externalApplicationsCloseAt" | "status"
>;

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

export function applicationsCloseAtFor(
  event: ApplicationDeadlineEvent,
  participantClass: ParticipantClass,
) {
  if (participantClass === "vit_student") return event.applicationsCloseAt;
  if (event.externalApplicationsCloseAt === undefined) {
    throw new Error("The external-participant application deadline is not configured.");
  }
  return event.externalApplicationsCloseAt;
}

export function requireRegistrationOpen(
  event: ApplicationDeadlineEvent,
  participantClass: ParticipantClass,
  now = Date.now(),
) {
  if (
    event.status !== "registration_open" ||
    now >= applicationsCloseAtFor(event, participantClass)
  ) {
    throw new ConvexError({
      code: "APPLICATIONS_CLOSED",
      message: "Applications are closed. Your saved work is still available to read.",
    });
  }
}
