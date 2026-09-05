import { z } from "zod";
import { reviewerParticipation } from "./lib/reviewerParticipation";
import { clockOutForVenueDeparture } from "./lib/reviewerVenueStaffing";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import {
  resolveVenueDeparture,
  venueDevice,
  venuePolicy,
  venuePresence,
  venueReviewer,
} from "./lib/reviewerVenue";
import {
  classifyVenueLocation,
  locationFreshnessMs,
  venuePolicyActive,
} from "./lib/reviewerVenuePolicy";
import { normalizedText } from "./lib/strings";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds } from "./lib/permissions";

export const mine = query({
  args: { eventSlug: v.string(), installationId: v.string() },
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grants = await matchingPermissionGrantIds(ctx, {
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
    if (!grants.length || profile?.status !== "active")
      return {
        policy: null,
        presence: null,
        departure: null,
        eventLive: event.status === "live",
        deviceReady: false,
        trackingOnThisDevice: false,
        eligible: false,
        reviewInProgress: false,
      };
    const [policy, presence, device] = await Promise.all([
      venuePolicy(ctx, event._id),
      venuePresence(ctx, event._id, person._id),
      ctx.db
        .query("reviewerDevices")
        .withIndex("by_event_installation", (q) =>
          q.eq("eventId", event._id).eq("installationId", args.installationId),
        )
        .unique(),
    ]);
    const departure = presence?.departureId
      ? await ctx.db.get(presence.departureId)
      : null;
    return {
      policy,
      presence,
      departure,
      eventLive: event.status === "live",
      deviceReady:
        device?.status === "active" && device.personId === person._id,
      trackingOnThisDevice:
        device !== null && presence?.reviewerDeviceId === device._id,
      eligible: true,
      reviewInProgress: (
        await reviewerParticipation(ctx, event._id, person._id)
      ).hasActiveReview,
    };
  },
});

export const setMonitoring = mutation({
  args: {
    eventSlug: v.string(),
    installationId: v.string(),
    enabled: v.boolean(),
    ownerId: v.string(),
    expectedGeneration: v.optional(v.number()),
    clientOperationId: v.string(),
  },
  returns: v.object({ generation: v.number(), startedAt: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject, grants } = await venueReviewer(
      ctx,
      args.eventSlug,
    );
    if (person.authUserId !== args.ownerId) {
      throw new ConvexError({
        code: "VENUE_OWNER_CHANGED",
        message: "Sign in with the account that requested this venue check change.",
      });
    }
    const device = await venueDevice(
      ctx,
      event._id,
      person._id,
      args.installationId,
    );
    const fingerprint = operationFingerprint([
      args.installationId,
      args.enabled,
      args.expectedGeneration ?? null,
    ]);
    const commandName = "reviewer.venue.monitoring";
    const operation = {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName,
      requestFingerprint: fingerprint,
    };
    const prior = await findOperation(ctx, operation);
    if (prior)
      return storedOperationResult(
        prior.resultJson,
        "venue tracking",
        z.object({ generation: z.number().int(), startedAt: z.number().int() }),
      );
    const [policy, current] = await Promise.all([
      venuePolicy(ctx, event._id),
      venuePresence(ctx, event._id, person._id),
    ]);
    const now = Date.now();
    if (
      args.enabled &&
      (!policy || !venuePolicyActive(policy, now) || event.status !== "live")
    ) {
      throw new ConvexError({
        code: "VENUE_MONITORING_CLOSED",
        message:
          "Venue checks are available during the configured live event window.",
      });
    }
    if (!args.enabled && current && current.reviewerDeviceId !== device._id) {
      throw new ConvexError({
        code: "VENUE_DEVICE_CHANGED",
        message: "Venue checks are running on your other phone.",
      });
    }
    if (
      !args.enabled &&
      current &&
      args.expectedGeneration !== current.trackingGeneration
    ) {
      throw new ConvexError({
        code: "VENUE_TRACKING_CHANGED",
        message: "Venue checks changed. Refresh before stopping this session.",
      });
    }
    const generation = (current?.trackingGeneration ?? 0) + 1;
    if (current && current.status !== "reported_left")
      await resolveVenueDeparture(ctx, current, "cancelled", now);
    const fields = {
      eventId: event._id,
      personId: person._id,
      reviewerDeviceId: device._id,
      policyVersion: policy?.version ?? 0,
      trackingGeneration: generation,
      trackingStartedAt: now,
      monitoringEnabled: args.enabled,
      status:
        current?.status === "reported_left"
          ? ("reported_left" as const)
          : ("unknown" as const),
      observation: "uncertain" as const,
      ...(current?.status === "reported_left" && current.departureId
        ? { departureId: current.departureId }
        : {}),
      ...(args.enabled ? { nextCheckAt: now + 60_000 } : {}),
      version: (current?.version ?? 0) + 1,
      updatedAt: now,
    };
    const presenceId =
      current?._id ?? (await ctx.db.insert("reviewerVenuePresence", fields));
    if (current)
      await ctx.db.patch(current._id, {
        ...fields,
        sampledAt: undefined,
        receivedAt: undefined,
        outsideSince: undefined,
        departureId:
          current.status === "reported_left" ? current.departureId : undefined,
        nextCheckAt: args.enabled ? now + 60_000 : undefined,
      });
    await recordOperation(ctx, {
      ...operation,
      targetType: "reviewer_venue_presence",
      targetId: presenceId,
      resultJson: JSON.stringify({ generation, startedAt: now }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "reviewer.device.register",
      grantIds: grants,
      scopeType: "self",
      scopeId: subject._id,
      action: "reviewer.venue_monitoring_changed",
      targetType: "reviewer_venue_presence",
      targetId: presenceId,
      nextSummary: JSON.stringify({ enabled: args.enabled, generation }),
      reason: args.enabled
        ? "Reviewer enabled venue checks"
        : "Reviewer stopped venue checks",
    });
    return { generation, startedAt: now };
  },
});

export const reportLocation = mutation({
  args: {
    eventSlug: v.string(),
    installationId: v.string(),
    generation: v.number(),
    latitude: v.number(),
    longitude: v.number(),
    accuracy: v.number(),
    sampledAt: v.number(),
    mocked: v.optional(v.boolean()),
  },
  returns: v.object({ accepted: v.boolean(), active: v.boolean() }),
  handler: async (ctx, args) => {
    const { event, person } = await venueReviewer(ctx, args.eventSlug);
    const device = await venueDevice(
      ctx,
      event._id,
      person._id,
      args.installationId,
    );
    const [policy, current] = await Promise.all([
      venuePolicy(ctx, event._id),
      venuePresence(ctx, event._id, person._id),
    ]);
    const now = Date.now();
    if (
      !policy ||
      !current ||
      !current.monitoringEnabled ||
      current.reviewerDeviceId !== device._id ||
      current.trackingGeneration !== args.generation ||
      current.policyVersion !== policy.version ||
      !venuePolicyActive(policy, now) ||
      event.status !== "live"
    )
      return { accepted: false, active: false };
    if (
      !Number.isSafeInteger(args.sampledAt) ||
      args.sampledAt > now + 30_000 ||
      args.sampledAt < current.trackingStartedAt ||
      now - args.sampledAt > 120_000 ||
      (current.sampledAt !== undefined && args.sampledAt <= current.sampledAt)
    )
      return { accepted: false, active: true };
    const observation = classifyVenueLocation(policy, args);
    const sampledAt = Math.min(now, args.sampledAt);
    const fresh =
      current.sampledAt !== undefined &&
      sampledAt - current.sampledAt <= locationFreshnessMs;
    let status = current.status;
    let outsideSince = current.outsideSince;
    let departureId = current.departureId;
    if (current.status !== "reported_left") {
      if (observation === "inside") {
        await resolveVenueDeparture(ctx, current, "returned", now);
        status = "inside";
        outsideSince = undefined;
        departureId = undefined;
      } else if (observation === "uncertain") {
        // A poor fix is not evidence that someone left or returned.
        status = "unknown";
        outsideSince = undefined;
      } else {
        outsideSince =
          fresh && current.observation === "outside"
            ? (current.outsideSince ?? now)
            : now;
        const existingDeparture = departureId
          ? await ctx.db.get(departureId)
          : null;
        if (existingDeparture?.state === "open") status = "left";
        else if (now - outsideSince >= policy.absenceGraceMinutes * 60_000) {
          status = "left";
          departureId = await ctx.db.insert("reviewerVenueDepartures", {
            eventId: event._id,
            personId: person._id,
            presenceId: current._id,
            policyVersion: policy.version,
            state: "open",
            leftAt: now,
            notificationState: "pending",
            notificationAttempts: 0,
            updatedAt: now,
          });
          await ctx.scheduler.runAfter(
            0,
            internal.reviewPush.deliverVenueReminder,
            { departureId },
          );
        } else status = "outside";
      }
    }
    await ctx.db.patch(current._id, {
      observation,
      status,
      sampledAt,
      receivedAt: now,
      outsideSince,
      departureId,
      nextCheckAt: current.nextCheckAt ?? now + 60_000,
      updatedAt: now,
    });
    return { accepted: true, active: true };
  },
});

export const declareDeparture = mutation({
  args: {
    eventSlug: v.string(),
    installationId: v.string(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { event, person, subject, grants } = await venueReviewer(
      ctx,
      args.eventSlug,
    );
    const device = await venueDevice(
      ctx,
      event._id,
      person._id,
      args.installationId,
    );
    const reason = normalizedText(args.reason, "Leaving reason", 3, 300);
    const operation = {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "reviewer.venue.leave",
      requestFingerprint: operationFingerprint([args.installationId, reason]),
    };
    if (await findOperation(ctx, operation)) return null;
    const [policy, current] = await Promise.all([
      venuePolicy(ctx, event._id),
      venuePresence(ctx, event._id, person._id),
    ]);
    if (
      !policy ||
      !venuePolicyActive(policy, Date.now()) ||
      event.status !== "live"
    )
      throw new ConvexError({
        code: "VENUE_MONITORING_CLOSED",
        message: "Venue reporting is closed for this event.",
      });
    const now = Date.now();
    await clockOutForVenueDeparture(ctx, event._id, person._id, reason, now);
    const presenceId =
      current?._id ??
      (await ctx.db.insert("reviewerVenuePresence", {
        eventId: event._id,
        personId: person._id,
        reviewerDeviceId: device._id,
        policyVersion: policy.version,
        trackingGeneration: 0,
        trackingStartedAt: now,
        monitoringEnabled: false,
        status: "unknown",
        observation: "uncertain",
        version: 1,
        updatedAt: now,
      }));
    const policyChanged = current && current.policyVersion !== policy.version;
    if (policyChanged)
      await resolveVenueDeparture(ctx, current, "cancelled", now);
    let departureId = policyChanged ? undefined : current?.departureId;
    if (departureId) {
      await ctx.db.patch(departureId, {
        state: "reported",
        reportedAt: now,
        reason,
        updatedAt: now,
      });
    } else {
      departureId = await ctx.db.insert("reviewerVenueDepartures", {
        eventId: event._id,
        personId: person._id,
        presenceId,
        policyVersion: policy.version,
        state: "reported",
        leftAt: now,
        reportedAt: now,
        reason,
        notificationState: "unavailable",
        notificationAttempts: 0,
        updatedAt: now,
      });
    }
    await ctx.db.patch(presenceId, {
      ...(policyChanged
        ? {
            policyVersion: policy.version,
            trackingGeneration: current.trackingGeneration + 1,
            trackingStartedAt: now,
            monitoringEnabled: false,
            observation: "uncertain" as const,
            sampledAt: undefined,
            receivedAt: undefined,
            nextCheckAt: undefined,
          }
        : {}),
      status: "reported_left",
      departureId,
      outsideSince: undefined,
      version: (current?.version ?? 1) + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      ...operation,
      targetType: "reviewer_venue_departure",
      targetId: departureId,
      resultJson: "1",
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "reviewer.device.register",
      grantIds: grants,
      scopeType: "self",
      scopeId: subject._id,
      action: "reviewer.venue_departure_reported",
      targetType: "reviewer_venue_departure",
      targetId: departureId,
      reason,
      nextSummary: JSON.stringify({ state: "reported", reason }),
    });
    return null;
  },
});
