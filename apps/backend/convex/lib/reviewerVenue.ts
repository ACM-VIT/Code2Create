import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireEventBySlug } from "./events";
import { requireCurrentPerson, requireEventSubject } from "./identity";
import { matchingPermissionGrantIds, requirePermission } from "./permissions";
import {
  locationFreshnessMs,
  reviewerVenueStatus,
  venuePolicyActive,
} from "./reviewerVenuePolicy";

type ReadCtx = QueryCtx | MutationCtx;

export const reviewerVenueView = v.object({
  status: reviewerVenueStatus,
  sampledAt: v.optional(v.number()),
});

export async function readVenuePresenceView(
  ctx: ReadCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
) {
  const [policy, presence] = await Promise.all([
    venuePolicy(ctx, eventId),
    venuePresence(ctx, eventId, personId),
  ]);
  return {
    status:
      policy?.enabled && presence?.policyVersion === policy.version
        ? presence.status
        : ("unknown" as const),
    ...(presence?.sampledAt !== undefined
      ? { sampledAt: presence.sampledAt }
      : {}),
  };
}

export async function venueReviewer(ctx: ReadCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const grants = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "reviewer.device.register",
    scopeType: "self",
    scopeId: subject._id,
  });
  const profile = await ctx.db
    .query("reviewerProfiles")
    .withIndex("by_event_person", (q) =>
      q.eq("eventId", event._id).eq("personId", person._id),
    )
    .unique();
  if (!profile || profile.status !== "active")
    throw new ConvexError({
      code: "REVIEWER_PROFILE_REQUIRED",
      message: "An active reviewer profile is required.",
    });
  return { event, person, subject, grants };
}

export async function venueDevice(
  ctx: ReadCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  installationId: string,
) {
  const device = await ctx.db
    .query("reviewerDevices")
    .withIndex("by_event_installation", (q) =>
      q.eq("eventId", eventId).eq("installationId", installationId),
    )
    .unique();
  if (!device || device.personId !== personId || device.status !== "active") {
    throw new ConvexError({
      code: "REVIEWER_DEVICE_REQUIRED",
      message: "Register this phone for the signed-in reviewer first.",
    });
  }
  return device;
}

export function venuePolicy(ctx: ReadCtx, eventId: Id<"events">) {
  return ctx.db
    .query("reviewerVenuePolicies")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .unique();
}

export function venuePresence(
  ctx: ReadCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
) {
  return ctx.db
    .query("reviewerVenuePresence")
    .withIndex("by_eventId_personId", (q) =>
      q.eq("eventId", eventId).eq("personId", personId),
    )
    .unique();
}

export async function activeVenueAuthority(
  ctx: ReadCtx,
  presence: Doc<"reviewerVenuePresence">,
  now: number,
) {
  const [policy, device, person, subject, profile, event] = await Promise.all([
    venuePolicy(ctx, presence.eventId),
    ctx.db.get(presence.reviewerDeviceId),
    ctx.db.get(presence.personId),
    ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", presence.eventId).eq("personId", presence.personId),
      )
      .unique(),
    ctx.db
      .query("reviewerProfiles")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", presence.eventId).eq("personId", presence.personId),
      )
      .unique(),
    ctx.db.get(presence.eventId),
  ]);
  if (
    !presence.monitoringEnabled ||
    !policy ||
    policy.version !== presence.policyVersion ||
    !venuePolicyActive(policy, now) ||
    !event ||
    event.status !== "live" ||
    !device ||
    device.status !== "active" ||
    device.personId !== presence.personId ||
    device.eventId !== presence.eventId ||
    !person ||
    person.status !== "active" ||
    !subject ||
    subject.status !== "active" ||
    !profile ||
    profile.status !== "active"
  )
    return null;
  const grants = await matchingPermissionGrantIds(ctx, {
    eventId: presence.eventId,
    eventAccessSubjectId: subject._id,
    permissionKey: "reviewer.device.register",
    scopeType: "self",
    scopeId: subject._id,
  });
  return grants.length ? { policy, device, grants } : null;
}

export async function openVenueDeparture(
  ctx: ReadCtx,
  departureId: Id<"reviewerVenueDepartures">,
  now: number,
) {
  const departure = await ctx.db.get(departureId);
  if (!departure || departure.state !== "open") return null;
  const presence = await ctx.db.get(departure.presenceId);
  if (
    !presence ||
    presence.departureId !== departure._id ||
    presence.status !== "left" ||
    presence.observation !== "outside" ||
    presence.sampledAt === undefined ||
    now - presence.sampledAt > locationFreshnessMs
  )
    return null;
  const authority = await activeVenueAuthority(ctx, presence, now);
  return authority ? { ...authority, departure, presence } : null;
}

export async function resolveVenueDeparture(
  ctx: MutationCtx,
  presence: Doc<"reviewerVenuePresence">,
  state: "returned" | "cancelled",
  now: number,
) {
  if (!presence.departureId) return;
  const departure = await ctx.db.get(presence.departureId);
  if (
    departure &&
    (departure.state === "open" || departure.state === "reported")
  ) {
    await ctx.db.patch(departure._id, {
      state,
      resolvedAt: now,
      updatedAt: now,
    });
  }
}
