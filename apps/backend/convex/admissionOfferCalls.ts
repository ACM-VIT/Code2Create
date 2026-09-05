import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
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
