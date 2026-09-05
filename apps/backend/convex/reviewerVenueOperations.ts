import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePermission } from "./lib/permissions";
import { writeAuditEvent } from "./lib/audit";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { venuePolicy, venuePresence } from "./lib/reviewerVenue";
import {
  validateVenuePolicy,
  venuePolicyFields,
} from "./lib/reviewerVenuePolicy";

async function operator(
  ctx: QueryCtx | MutationCtx,
  eventSlug: string,
  permissionKey:
    | "review.configuration.read"
    | "review.configuration.publish"
    | "reviewer.profile.read",
) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const grants = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey,
    scopeType: "event",
  });
  return { event, person, grants };
}

export const configuration = query({
  args: { eventSlug: v.string() },
  handler: async (ctx, args) => {
    const { event } = await operator(
      ctx,
      args.eventSlug,
      "review.configuration.read",
    );
    return venuePolicy(ctx, event._id);
  },
});

export const configure = mutation({
  args: {
    eventSlug: v.string(),
    policy: v.object(venuePolicyFields),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, grants } = await operator(
      ctx,
      args.eventSlug,
      "review.configuration.publish",
    );
    validateVenuePolicy(args.policy);
    const operation = {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "reviewer.venue.configure",
      requestFingerprint: operationFingerprint([
        JSON.stringify(args.policy),
        args.expectedVersion,
      ]),
    };
    const prior = await findOperation(ctx, operation);
    if (prior)
      return {
        version: storedOperationVersion(
          prior.resultJson,
          "venue configuration",
        ),
      };
    const current = await venuePolicy(ctx, event._id);
    if ((current?.version ?? 0) !== args.expectedVersion)
      throw new ConvexError({
        code: "VENUE_POLICY_CHANGED",
        message: "Venue settings changed. Refresh before saving.",
      });
    const now = Date.now();
    const version = args.expectedVersion + 1;
    const fields = {
      ...args.policy,
      name: args.policy.name.trim(),
      eventId: event._id,
      version,
      updatedByPersonId: person._id,
      updatedAt: now,
    };
    const policyId =
      current?._id ?? (await ctx.db.insert("reviewerVenuePolicies", fields));
    if (current)
      await ctx.db.patch(current._id, {
        ...fields,
        confirmationAgent: args.policy.confirmationAgent,
      });
    await recordOperation(ctx, {
      ...operation,
      targetType: "reviewer_venue_policy",
      targetId: policyId,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.configuration.publish",
      grantIds: grants,
      scopeType: "event",
      action: "reviewer.venue_policy_changed",
      targetType: "reviewer_venue_policy",
      targetId: policyId,
      nextSummary: JSON.stringify(args.policy),
      reason: "Organizer configured reviewer venue checks",
    });
    return { version };
  },
});

export const roster = query({
  args: { eventSlug: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { event } = await operator(
      ctx,
      args.eventSlug,
      "reviewer.profile.read",
    );
    const policy = await venuePolicy(ctx, event._id);
    const profiles = await ctx.db
      .query("reviewerProfiles")
      .withIndex("by_event_person", (q) => q.eq("eventId", event._id))
      .paginate(args.paginationOpts);
    const page = await Promise.all(
      profiles.page.map(async (profile) => {
        const [person, presence] = await Promise.all([
          ctx.db.get(profile.personId),
          venuePresence(ctx, event._id, profile.personId),
        ]);
        const departure = presence?.departureId
          ? await ctx.db.get(presence.departureId)
          : await ctx.db
              .query("reviewerVenueDepartures")
              .withIndex("by_eventId_personId_leftAt", (q) =>
                q.eq("eventId", event._id).eq("personId", profile.personId),
              )
              .order("desc")
              .first();
        const call = departure?.callDeliveryId
          ? await ctx.db.get(departure.callDeliveryId)
          : null;
        return {
          personId: profile.personId,
          name: person?.displayName ?? "Reviewer",
          profileStatus: profile.status,
          status:
            policy?.enabled && presence?.policyVersion === policy.version
              ? presence.status
              : ("unknown" as const),
          monitoringEnabled: presence?.monitoringEnabled ?? false,
          lastCheckedAt: presence?.sampledAt,
          reason: departure?.reason,
          leftAt: departure?.leftAt,
          notificationState: departure?.notificationState,
          callState: call?.state,
          callError: call?.providerErrorCode,
          callId: call?._id,
          response: call?.venueResponse
            ? {
                outcome: call.venueResponse.outcome,
                confirmed: call.venueResponse.confirmed,
                summary: call.venueResponse.summary,
                returnInMinutes: call.venueResponse.returnInMinutes,
              }
            : undefined,
          responseEffect: call?.venueResponseEffect,
          responseRecordedAt: call?.responseRecordedAt,
        };
      }),
    );
    return { ...profiles, page };
  },
});

export const callResponse = query({
  args: { eventSlug: v.string(), deliveryId: v.id("outboundCallDeliveries") },
  handler: async (ctx, args) => {
    const { event } = await operator(
      ctx,
      args.eventSlug,
      "reviewer.profile.read",
    );
    const call = await ctx.db.get(args.deliveryId);
    if (
      !call ||
      call.eventId !== event._id ||
      call.sourceType !== "reviewer_venue_departure"
    )
      return null;
    const responseEvent = call.responseEventId ? await ctx.db.get(call.responseEventId) : null;
    return responseEvent?.venueResponse ?? null;
  },
});
