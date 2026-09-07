import { internal } from "./_generated/api";
import { normalizedE164Phone } from "./lib/outboundCalls";
import { admissionRsvpCallScript, currentAdmissionRsvpReminder } from "./lib/admissionOfferCalls";
import { venueCallResponseSchema } from "./lib/venueCallResponsePayload";
import {
  venueConfirmationCall,
  venueCallResponseValue,
} from "./lib/venueCallValidators";
import { applyVenueCallResponse } from "./lib/venueCallResponse";
import type { OutboundCallEventType } from "@code2create/domain";
import { v } from "convex/values";

import { activeRoundPause } from "./lib/reviewRoundPauses";

import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { openVenueDeparture } from "./lib/reviewerVenue";
import { venueCallPurpose } from "./lib/reviewerVenuePolicy";
import { outingCallBlockedReason } from "./lib/outingCalls";

const claimLifetimeMs = 30 * 1_000;
const maximumDispatchAttempts = 3;

const outboundCallEventType = v.union(
  v.literal("call.queued"),
  v.literal("call.initiated"),
  v.literal("call.ringing"),
  v.literal("call.answered"),
  v.literal("call.completed"),
  v.literal("call.busy"),
  v.literal("call.no_answer"),
  v.literal("call.cancelled"),
  v.literal("call.failed"),
);

const activeStateRank = {
  provider_accepted: 0,
  queued: 1,
  initiated: 2,
  ringing: 3,
  answered: 4,
} as const;

type ActiveState = keyof typeof activeStateRank;

function isActiveState(state: Doc<"outboundCallDeliveries">["state"],
): state is ActiveState {
  return (
    state === "provider_accepted" ||
    state === "queued" ||
    state === "initiated" ||
    state === "ringing" ||
    state === "answered"
  );
}

function eventState(eventType: OutboundCallEventType, providerErrorCode: string | undefined,
) {
  switch (eventType) {
    case "call.queued":
      return "queued" as const;
    case "call.initiated":
      return "initiated" as const;
    case "call.ringing":
      return "ringing" as const;
    case "call.answered":
      return "answered" as const;
    case "call.completed":
      return "completed" as const;
    case "call.busy":
      return "busy" as const;
    case "call.no_answer":
      return "no_answer" as const;
    case "call.cancelled":
      return "cancelled" as const;
    case "call.failed":
      return providerErrorCode === "provider_dispatch_ambiguous"
        ? ("ambiguous" as const)
        : ("failed" as const);
  }
}

function terminalState(state: Doc<"outboundCallDeliveries">["state"]) {
  return (
    state === "unavailable" ||
    state === "completed" ||
    state === "busy" ||
    state === "no_answer" ||
    state === "cancelled" ||
    state === "failed"
  );
}

function completionState(state: Doc<"outboundCallDeliveries">["state"]) {
  return terminalState(state) || state === "ambiguous";
}

async function undispatchableReason(
  ctx: MutationCtx,
  delivery: Doc<"outboundCallDeliveries">,
  now: number,
) {
  if (delivery.destinationPhoneE164 === undefined) return "phone_not_e164";
  if (delivery.sourceType === "participant_outing") return outingCallBlockedReason(ctx, delivery, now);
  if (delivery.purpose === "participant_event_update") {
    if (delivery.sourceType !== "admission_offer_reminder" && delivery.sourceType !== "review_team_notice") {
      return "participant_call_source_invalid";
    }
  } else {
    if (delivery.consentId === undefined || delivery.consentVersion === undefined) {
      return "call_consent_not_granted";
    }
    const consent = await ctx.db.get(delivery.consentId);
    if (
      (delivery.venueConfirmation && delivery.venueConfirmation.expiresAt <= now) ||
      !consent || consent.eventId !== delivery.eventId ||
      consent.personId !== delivery.targetPersonId ||
      consent.purpose !== delivery.purpose ||
      consent.state !== "granted" || consent.version !== delivery.consentVersion ||
      consent.destinationPhoneE164 !== delivery.destinationPhoneE164 ||
      consent.scriptPolicyVersion !== delivery.scriptPolicyVersion
    ) return "call_consent_changed";
  }
  const requiredPermissionKey =
    delivery.sourceType === "admission_offer_reminder"
      ? "application.offer.manage"
      : delivery.purpose === venueCallPurpose
      ? "reviewer.device.register"
      : delivery.purpose === "reviewer_substitute_page"
      ? "review.substitute.page"
      : "communications.delivery.manage";
  const grants = await Promise.all(
    delivery.authorizationGrantIds.map((grantId) => ctx.db.get(grantId)),
  );
  const authorized = grants.some(
    (grant) =>
      grant !== null &&
      grant.eventId === delivery.eventId &&
      grant.permissionKey === requiredPermissionKey &&
      grant.status === "active" &&
      grant.validFrom <= now &&
      (grant.validUntil === undefined || grant.validUntil > now),
  );
  if (!authorized) return "call_authority_expired";
  if (delivery.sourceType === "admission_offer_reminder") {
    const offerId = ctx.db.normalizeId("admissionOffers", delivery.sourceId);
    const current = offerId ? await currentAdmissionRsvpReminder(ctx, offerId, now) : null;
    if (
      !current || current.event._id !== delivery.eventId ||
      current.leader.personId !== delivery.targetPersonId ||
      !current.grantIds.some((id) => delivery.authorizationGrantIds.includes(id))
    ) return "rsvp_offer_no_longer_pending";
    const profile = await ctx.db.query("participantProfiles")
      .withIndex("by_membership", (q) => q.eq("membershipId", current.leader._id)).unique();
    if (normalizedE164Phone(profile?.phone) !== delivery.destinationPhoneE164) {
      return "participant_phone_changed";
    }
  }
  if (delivery.sourceType === "reviewer_venue_departure") {
    const departureId = ctx.db.normalizeId(
      "reviewerVenueDepartures",
      delivery.sourceId,
    );
    const active = departureId
      ? await openVenueDeparture(ctx, departureId, now)
      : null;
    if (
      !active ||
      !delivery.venueConfirmation ||
      active.departure.callDeliveryId !== delivery._id ||
      active.policy.confirmationAgent?.appId !==
        delivery.venueConfirmation.appId ||
      active.policy.confirmationAgent?.appVersion !==
        delivery.venueConfirmation.appVersion ||
      active.presence.eventId !== delivery.eventId ||
      active.presence.personId !== delivery.targetPersonId ||
      active.departure.reminderStartedAt === undefined ||
      now <
        active.departure.reminderStartedAt +
          active.policy.callDelayMinutes * 60_000
    )
      return "venue_absence_resolved";
  }
  if (delivery.sourceType === "reviewer_page") {
    const pageId = ctx.db.normalizeId("reviewerPages", delivery.sourceId);
    const page = pageId ? await ctx.db.get(pageId) : null;
    if (
      !page ||
      page.eventId !== delivery.eventId ||
      page.targetPersonId !== delivery.targetPersonId ||
      (page.state !== "sent" && page.state !== "opened") ||
      page.expiresAt <= now
    ) {
      return "reviewer_page_not_active";
    }
  }
  if (delivery.sourceType === "review_team_notice") {
    const noticeId = ctx.db.normalizeId("reviewTeamNotices", delivery.sourceId);
    const notice = noticeId ? await ctx.db.get(noticeId) : null;
    if (!notice || notice.eventId !== delivery.eventId)
      return "review_notice_unavailable";
    const [round, state, policy, team] = await Promise.all([
      ctx.db.get(notice.roundId),
      ctx.db.get(notice.teamRoundStateId),
      ctx.db
        .query("reviewQueuePolicies")
        .withIndex("by_round", (q) => q.eq("roundId", notice.roundId))
        .unique(),
      ctx.db.get(notice.teamId),
    ]);
    const leader = team ? await ctx.db.get(team.leadMembershipId) : null;
    if (
      !round ||
      round.status !== "open" ||
      now >= round.endsAt ||
      !policy?.voiceCalls ||
      !state ||
      state.panelId !== notice.panelId ||
      state.version !== notice.queueVersion ||
      state.state !== (notice.kind === "up_next" ? "queued" : "called") ||
      leader?.personId !== delivery.targetPersonId ||
      (await activeRoundPause(ctx, round._id))
    )
      return "review_notice_no_longer_current";
    const profile = await ctx.db
      .query("participantProfiles")
      .withIndex("by_membership", (q) => q.eq("membershipId", leader._id))
      .unique();
    if (normalizedE164Phone(profile?.phone) !== delivery.destinationPhoneE164)
      return "participant_phone_changed";
  }
  return null;
}

export const claimDelivery = internalMutation({
  args: {
    deliveryId: v.id("outboundCallDeliveries"),
    attemptId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      deliveryId: v.id("outboundCallDeliveries"),
      destinationPhoneE164: v.string(),
      script: v.string(),
      requiredProvider: v.optional(v.literal("sarvam")),
      venueConfirmation: v.optional(venueConfirmationCall),
    }),
  ),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    const now = Date.now();
    if (
      !delivery ||
      delivery.destinationPhoneE164 === undefined ||
      !(
        delivery.state === "pending" ||
        delivery.state === "retry_wait" ||
        (delivery.state === "sending" &&
          delivery.claimExpiresAt !== undefined &&
          delivery.claimExpiresAt <= now)
      ) ||
      (delivery.state === "retry_wait" && delivery.nextAttemptAt !== undefined && now < delivery.nextAttemptAt) ||
      delivery.attemptCount >= maximumDispatchAttempts
    ) {
      return null;
    }
    let script = delivery.script;
    const blockedReason = await undispatchableReason(ctx, delivery, now);
    if (blockedReason !== null) {
      await ctx.db.patch(delivery._id, {
        state: "cancelled",
        claimExpiresAt: undefined,
        nextAttemptAt: undefined,
        providerErrorCode: blockedReason,
        version: delivery.version + 1,
        updatedAt: now,
        completedAt: now,
      });
      return null;
    }
    if (delivery.sourceType === "admission_offer_reminder") {
      const offerId = ctx.db.normalizeId("admissionOffers", delivery.sourceId);
      const current = offerId ? await currentAdmissionRsvpReminder(ctx, offerId, now) : null;
      if (!current || current.offer.reminderAt === undefined) throw new Error("The validated RSVP reminder is missing.");
      if (now < current.offer.reminderAt) {
        await ctx.db.patch(delivery._id, {
          state: "retry_wait", nextAttemptAt: current.offer.reminderAt, claimExpiresAt: undefined,
          version: delivery.version + 1, updatedAt: now,
        });
        await ctx.scheduler.runAt(current.offer.reminderAt, internal.outboundCalls.deliver, { deliveryId: delivery._id });
        return null;
      }
      script = admissionRsvpCallScript(current.team.name, current.offer.expiresAt, current.event.timezone);
    }
    if (delivery.sourceType === "reviewer_shift_reminder") {
      // Reviewer shift reminders were retired; a delivery queued earlier never dials.
      await ctx.db.patch(delivery._id, {
        state: "cancelled", providerErrorCode: "shift_reminder_retired",
        claimExpiresAt: undefined, nextAttemptAt: undefined,
        version: delivery.version + 1, updatedAt: now, completedAt: now,
      });
      return null;
    }
    await ctx.db.patch(delivery._id, {
      state: "sending",
      script,
      attemptId: args.attemptId,
      claimExpiresAt: now + claimLifetimeMs,
      nextAttemptAt: undefined,
      attemptCount: delivery.attemptCount + 1,
      version: delivery.version + 1,
      updatedAt: now,
    });
    return {
      deliveryId: delivery._id,
      destinationPhoneE164: delivery.destinationPhoneE164,
      script,
      ...(delivery.sourceType === "participant_outing" ? { requiredProvider: "sarvam" as const } : {}),
      ...(delivery.venueConfirmation
        ? { venueConfirmation: delivery.venueConfirmation }
        : {}),
    };
  },
});

export const recordAccepted = internalMutation({
  args: {
    deliveryId: v.id("outboundCallDeliveries"),
    attemptId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.state !== "sending" || delivery.attemptId !== args.attemptId) {
      return null;
    }
    await ctx.db.patch(delivery._id, {
      state: "provider_accepted",
      claimExpiresAt: undefined,
      version: delivery.version + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const recordDispatchFailure = internalMutation({
  args: {
    deliveryId: v.id("outboundCallDeliveries"),
    attemptId: v.string(),
    errorCode: v.string(),
    ambiguous: v.boolean(),
    retryable: v.boolean(),
  },
  returns: v.object({ retry: v.boolean(), delayMs: v.optional(v.number()) }),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.state !== "sending" || delivery.attemptId !== args.attemptId) {
      return { retry: false };
    }
    const now = Date.now();
    if (args.retryable && delivery.attemptCount < maximumDispatchAttempts) {
      const delayMs = 2 ** (delivery.attemptCount - 1) * 5_000;
      await ctx.db.patch(delivery._id, {
        state: "retry_wait",
        claimExpiresAt: undefined,
        nextAttemptAt: now + delayMs,
        providerErrorCode: args.errorCode,
        version: delivery.version + 1,
        updatedAt: now,
      });
      return { retry: true, delayMs };
    }
    await ctx.db.patch(delivery._id, {
      state: args.ambiguous ? "ambiguous" : "failed",
      claimExpiresAt: undefined,
      providerErrorCode: args.errorCode,
      version: delivery.version + 1,
      updatedAt: now,
      completedAt: now,
    });
    return { retry: false };
  },
});

export const recordProviderEvent = internalMutation({
  args: {
    providerEventId: v.string(),
    deliveryId: v.string(),
    eventType: outboundCallEventType,
    providerAt: v.number(),
    providerCallId: v.optional(v.string()),
    providerErrorCode: v.optional(v.string()),
    venueResponse: v.optional(venueCallResponseValue),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("outboundCallProviderEvents")
      .withIndex("by_provider_event", (index) => index.eq("providerEventId", args.providerEventId),
      )
      .unique();
    if (duplicate) {
      if (
        duplicate.deliveryId !== args.deliveryId ||
        duplicate.eventType !== args.eventType ||
        duplicate.providerAt !== args.providerAt ||
        duplicate.providerCallId !== args.providerCallId ||
        duplicate.providerErrorCode !== args.providerErrorCode ||
        JSON.stringify(duplicate.venueResponse) !==
          JSON.stringify(args.venueResponse)
      ) {
        throw new Error(
          "An outbound call provider event ID was reused with different data.",
        );
      }
      return null;
    }
    const deliveryId = ctx.db.normalizeId("outboundCallDeliveries", args.deliveryId,
    );
    if (!deliveryId) throw new Error("Outbound call delivery ID is invalid.");
    const delivery = await ctx.db.get(deliveryId);
    if (!delivery) throw new Error("Outbound call delivery is missing.");
    const now = Date.now();
    if (
      args.venueResponse &&
      (args.eventType !== "call.completed" ||
        delivery.sourceType !== "reviewer_venue_departure" ||
        !delivery.venueConfirmation)
    )
      throw new Error("Unexpected call confirmation.");
    const response = args.venueResponse
      ? venueCallResponseSchema.parse(args.venueResponse)
      : undefined;
    if (
      delivery.providerCallId &&
      args.providerCallId &&
      delivery.providerCallId !== args.providerCallId
    )
      throw new Error("Call ID does not match the delivery.");
    const responseEventId = await ctx.db.insert("outboundCallProviderEvents", {
      eventId: delivery.eventId,
      deliveryId: delivery._id,
      providerEventId: args.providerEventId,
      eventType: args.eventType,
      ...(args.providerCallId !== undefined ? { providerCallId: args.providerCallId } : {}),
      ...(args.providerErrorCode !== undefined
        ? { providerErrorCode: args.providerErrorCode }
        : {}),
      ...(response ? { venueResponse: response } : {}),
      providerAt: args.providerAt,
      receivedAt: now,
    });
    if (terminalState(delivery.state)) return null;
    if (response) {
      const effect = await applyVenueCallResponse(ctx, delivery, response, now);
      const { transcript: _transcript, ...summary } = response;
      await ctx.db.patch(delivery._id, {
        responseEventId,
        venueResponse: summary,
        venueResponseEffect: effect,
        responseRecordedAt: now,
      });
    }
    const nextState = eventState(args.eventType, args.providerErrorCode);
    if (delivery.state === "ambiguous" && isActiveState(nextState)) return null;
    const currentRank = isActiveState(delivery.state) ? activeStateRank[delivery.state] : -1;
    const nextRank = isActiveState(nextState)
      ? activeStateRank[nextState]
      : Number.POSITIVE_INFINITY;
    if (nextRank < currentRank) return null;
    await ctx.db.patch(delivery._id, {
      state: nextState,
      ...(args.providerCallId !== undefined ? { providerCallId: args.providerCallId } : {}),
      ...(args.providerErrorCode !== undefined
        ? { providerErrorCode: args.providerErrorCode }
        : {}),
      claimExpiresAt: undefined,
      nextAttemptAt: undefined,
      version: delivery.version + 1,
      updatedAt: now,
      ...(completionState(nextState) ? { completedAt: now } : {}),
    });
    return null;
  },
});
