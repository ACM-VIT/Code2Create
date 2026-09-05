import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePermission } from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { internalMutation, mutation } from "./_generated/server";
import {
  admissionRsvpCallScript,
  admissionRsvpCallScriptPolicyVersion,
  currentAdmissionRsvpReminder,
} from "./lib/admissionOfferCalls";
import { enqueueOutboundCall, normalizedE164Phone } from "./lib/outboundCalls";

export const remind = internalMutation({
  args: { offerId: v.id("admissionOffers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const current = await currentAdmissionRsvpReminder(ctx, args.offerId, now);
    if (!current || now < (current.offer.reminderAt ?? Infinity)) return null;
    const { offer, team, event, leader, grantIds } = current;
    const profile = await ctx.db
      .query("participantProfiles")
      .withIndex("by_membership", (q) => q.eq("membershipId", leader._id))
      .unique();
    const phone = normalizedE164Phone(profile?.phone);
    if (phone === null) return null;

    await enqueueOutboundCall(ctx, {
      eventId: event._id,
      targetPersonId: leader.personId,
      sourceType: "admission_offer_reminder",
      sourceId: offer._id,
      purpose: "participant_event_update",
      destinationPhone: phone,
      script: admissionRsvpCallScript(team.name, offer.expiresAt, event.timezone),
      locale: "en-IN",
      scriptPolicyVersion: admissionRsvpCallScriptPolicyVersion,
      authorizationGrantIds: grantIds,
      now,
    });
    return null;
  },
});

/** Bring one team's scheduled reminder forward without resending its RSVP email. */
export const sendNow = mutation({
  args: { eventSlug: v.string(), offerId: v.id("admissionOffers"), clientOperationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const operation = {
      eventId: event._id, actorPersonId: person._id, clientOperationId: args.clientOperationId,
      commandName: "admissions.rsvp.call_now", requestFingerprint: operationFingerprint([args.offerId]),
    };
    if (await findOperation(ctx, operation)) return null;
    const offer = await ctx.db.get(args.offerId);
    if (!offer || offer.eventId !== event._id) throw new ConvexError({ code: "OFFER_NOT_FOUND", message: "The RSVP offer was not found." });
    const grantIds = await requirePermission(ctx, {
      eventId: event._id, eventAccessSubjectId: subject._id, permissionKey: "application.offer.manage",
      scopeType: "application", scopeId: offer.applicationId,
    });
    const now = Date.now();
    const current = await currentAdmissionRsvpReminder(ctx, offer._id, now);
    if (!current) throw new ConvexError({ code: "RSVP_NOT_CALLABLE", message: "This team has no current unanswered RSVP reminder." });
    const profile = await ctx.db.query("participantProfiles")
      .withIndex("by_membership", q => q.eq("membershipId", current.leader._id)).unique();
    if (!normalizedE164Phone(profile?.phone)) throw new ConvexError({ code: "PHONE_UNAVAILABLE", message: "The team lead has no usable registered phone number." });
    const existing = await ctx.db.query("outboundCallDeliveries").withIndex("by_source", q => q
      .eq("eventId", event._id).eq("sourceType", "admission_offer_reminder")
      .eq("sourceId", offer._id).eq("purpose", "participant_event_update")).unique();
    const bringForward = !existing || existing.state === "pending" || existing.state === "retry_wait";
    if (bringForward) {
      await ctx.db.patch(offer._id, { reminderAt: now, version: offer.version + 1 });
      await ctx.scheduler.runAt(offer.expiresAt, internal.admissions.expireOffer, { offerId: offer._id, expectedOfferVersion: offer.version + 1 });
      if (existing) {
        await ctx.db.patch(existing._id, { nextAttemptAt: now, version: existing.version + 1, updatedAt: now });
        await ctx.scheduler.runAfter(0, internal.outboundCalls.deliver, { deliveryId: existing._id });
      } else {
        await ctx.scheduler.runAfter(0, internal.admissionOfferCalls.remind, { offerId: offer._id });
      }
    }
    await recordOperation(ctx, { ...operation, targetType: "admission_offer", targetId: offer._id, resultJson: "null", createdAt: now });
    await writeAuditEvent(ctx, {
      eventId: event._id, actorPersonId: person._id, permissionKey: "application.offer.manage", grantIds,
      scopeType: "application", scopeId: offer.applicationId, action: "admission.rsvp_call_requested",
      targetType: "admission_offer", targetId: offer._id,
      nextSummary: JSON.stringify({ reminderAt: bringForward ? now : offer.reminderAt, alreadyRequested: !!existing, broughtForward: bringForward }),
      reason: "Operator requested the team's RSVP reminder now",
    });
    return null;
  },
});
