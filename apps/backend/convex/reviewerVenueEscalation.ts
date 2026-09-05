import { venueCallConsentVersion } from "@code2create/domain";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { enqueueOutboundCall } from "./lib/outboundCalls";
import { pushTokenFingerprint } from "./lib/pushTokens";
import {
  activeVenueAuthority,
  openVenueDeparture,
  resolveVenueDeparture,
} from "./lib/reviewerVenue";
import {
  locationFreshnessMs,
  venueCallPurpose,
  venueCallScriptVersion,
} from "./lib/reviewerVenuePolicy";

export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("reviewerVenuePresence")
      .withIndex("by_nextCheckAt", (q) =>
        q.gt("nextCheckAt", 0).lte("nextCheckAt", now),
      )
      .take(100);
    for (const presence of rows) {
      const authority = await activeVenueAuthority(ctx, presence, now);
      if (!authority) {
        await resolveVenueDeparture(ctx, presence, "cancelled", now);
        await ctx.db.patch(presence._id, {
          monitoringEnabled: false,
          status: "unknown",
          observation: "uncertain",
          outsideSince: undefined,
          departureId: undefined,
          nextCheckAt: undefined,
          updatedAt: now,
        });
        continue;
      }
      const fresh =
        presence.sampledAt !== undefined &&
        now - presence.sampledAt <= locationFreshnessMs;
      await ctx.db.patch(presence._id, {
        ...(!fresh && presence.status !== "reported_left"
          ? {
              status: "unknown" as const,
              observation: "uncertain" as const,
              outsideSince: undefined,
            }
          : {}),
        nextCheckAt: now + 60_000,
      });
      if (!fresh || !presence.departureId) continue;
      const active = await openVenueDeparture(ctx, presence.departureId, now);
      if (!active) continue;
      const { departure, policy } = active;
      if (
        departure.notificationAttempts < 3 &&
        (departure.notificationState === "pending" ||
          departure.notificationState === "failed" ||
          (departure.notificationState === "sending" &&
            (departure.notificationClaimUntil ?? 0) <= now))
      ) {
        await ctx.scheduler.runAfter(
          0,
          internal.reviewPush.deliverVenueReminder,
          { departureId: departure._id },
        );
      }
      if (
        departure.reminderStartedAt === undefined ||
        now < departure.reminderStartedAt + policy.callDelayMinutes * 60_000 ||
        departure.callDeliveryId ||
        !policy.confirmationAgent
      )
        continue;
      const consent = await ctx.db
        .query("outboundCallConsents")
        .withIndex("by_event_person_purpose", (q) =>
          q
            .eq("eventId", presence.eventId)
            .eq("personId", presence.personId)
            .eq("purpose", venueCallPurpose),
        )
        .unique();
      const consentReady =
        consent?.state === "granted" &&
        consent.consentPolicyVersion === venueCallConsentVersion &&
        consent.scriptPolicyVersion === venueCallScriptVersion;
      if (!consentReady || !consent.destinationPhoneE164) continue;
      const person = await ctx.db.get(presence.personId);
      const callDeliveryId = await enqueueOutboundCall(ctx, {
        eventId: presence.eventId,
        targetPersonId: presence.personId,
        sourceType: "reviewer_venue_departure",
        sourceId: departure._id,
        purpose: venueCallPurpose,
        script: `I am the automated Code2Create assistant. Your phone suggests you may be outside ${policy.name}. I will save your answers for the organizers. Are you at the venue and available to review?`,
        venueConfirmation: {
          appId: policy.confirmationAgent.appId,
          appVersion: policy.confirmationAgent.appVersion,
          reviewerName: person?.displayName ?? "Reviewer",
          venueName: policy.name,
          expiresAt:
            now + policy.confirmationAgent.responseWindowMinutes * 60_000,
        },
        locale: "en-IN",
        scriptPolicyVersion: venueCallScriptVersion,
        destinationPhone: consent.destinationPhoneE164,
        consent: { id: consent._id, version: consent.version },
        authorizationGrantIds: authority.grants,
        now,
      });
      await ctx.db.patch(departure._id, { callDeliveryId, updatedAt: now });
    }
    if (rows.length === 100)
      await ctx.scheduler.runAfter(
        0,
        internal.reviewerVenueEscalation.sweep,
        {},
      );
    return null;
  },
});

export const claimNotification = internalMutation({
  args: { departureId: v.id("reviewerVenueDepartures"), attemptId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const active = await openVenueDeparture(ctx, args.departureId, now);
    if (!active) return null;
    const { departure, device, policy } = active;
    if (
      departure.notificationState === "sent" ||
      departure.notificationState === "unavailable" ||
      departure.notificationAttempts >= 3 ||
      (departure.notificationState === "sending" &&
        (departure.notificationClaimUntil ?? 0) > now)
    )
      return null;
    // An unreachable push provider must not prevent the later, consented phone fallback.
    await ctx.db.patch(departure._id, {
      reminderStartedAt: departure.reminderStartedAt ?? now,
    });
    if (
      device.pushTokenStatus !== "active" ||
      !device.pushToken ||
      !device.pushProvider ||
      !device.pushEnvironment
    ) {
      await ctx.db.patch(departure._id, {
        notificationState: "unavailable",
        notificationError: "push_not_registered",
        updatedAt: now,
      });
      return null;
    }
    await ctx.db.patch(departure._id, {
      notificationState: "sending",
      notificationAttemptId: args.attemptId,
      notificationAttempts: departure.notificationAttempts + 1,
      notificationClaimUntil: now + 30_000,
      updatedAt: now,
    });
    return {
      reviewerDeviceId: device._id,
      tokenFingerprint: pushTokenFingerprint(device.pushToken),
      provider: device.pushProvider,
      token: device.pushToken,
      environment: device.pushEnvironment,
      title: "Have you left the venue?",
      body: `You appear to be outside ${policy.name}. Open the app to inform the review desk. If this is unresolved, we may call in ${policy.callDelayMinutes} minutes.`,
      expiresAt: Math.min(policy.endsAt, now + locationFreshnessMs),
    };
  },
});

export const recordNotification = internalMutation({
  args: {
    departureId: v.id("reviewerVenueDepartures"),
    attemptId: v.string(),
    sent: v.boolean(),
    reviewerDeviceId: v.id("reviewerDevices"),
    tokenFingerprint: v.string(),
    invalidateToken: v.boolean(),
    retryable: v.boolean(),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const departure = await ctx.db.get(args.departureId);
    if (
      !departure ||
      departure.notificationState !== "sending" ||
      departure.notificationAttemptId !== args.attemptId
    )
      return null;
    const now = Date.now();
    if (!args.sent && args.invalidateToken) {
      const device = await ctx.db.get(args.reviewerDeviceId);
      if (
        device?.pushTokenStatus === "active" &&
        device.pushToken !== undefined &&
        pushTokenFingerprint(device.pushToken) === args.tokenFingerprint
      ) {
        await ctx.db.patch(device._id, {
          pushTokenStatus: "invalid",
          pushTokenInvalidatedAt: now,
          pushTokenFailureCode: args.errorCode,
          version: device.version + 1,
        });
      }
    }
    await ctx.db.patch(departure._id, {
      notificationState: args.sent ? "sent" : args.retryable ? "failed" : "unavailable",
      notificationClaimUntil: undefined,
      ...(args.sent
        ? {
            notifiedAt: departure.notifiedAt ?? now,
            notificationError: undefined,
          }
        : { notificationError: args.errorCode ?? "push_failed" }),
      updatedAt: now,
    });
    return null;
  },
});
