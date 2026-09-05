import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { createAdmissionOffer } from "./admissions";
import { validateAdmissionRsvpSchedule, requireAdmissionRsvpCapacity } from "./lib/admissionRsvpSchedule";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePermission } from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { enqueueApplicationNotifications } from "./lib/participantNotificationDelivery";
import { normalizedText } from "./lib/strings";

async function applySchedule(ctx: MutationCtx, event: Doc<"events">, application: Doc<"applications">) {
  if (application.decisionStage !== "released" || (application.state !== "accepted" && application.state !== "offer_sent")) return;
  const closesAt = event.admissionRsvpClosesAt;
  const actorPersonId = event.admissionRsvpOpenedByPersonId;
  if (closesAt === undefined || actorPersonId === undefined || closesAt <= Date.now()) return;
  const subject = await requireEventSubject(ctx, event._id, actorPersonId);
  const grantIds = await requirePermission(ctx, {
    eventId: event._id, eventAccessSubjectId: subject._id,
    permissionKey: "application.offer.manage", scopeType: "event",
  });
  const [project, policy, team] = await Promise.all([
    ctx.db.get(application.submittedProjectVersionId), ctx.db.get(application.admissionPolicyVersionId), ctx.db.get(application.teamId),
  ]);
  if (!project || !policy || !team) throw new Error("The selected team's RSVP context is missing.");
  const now = Date.now();
  let offerId: Id<"admissionOffers">;
  if (application.state === "accepted") {
    const created = await createAdmissionOffer(ctx, {
      event, application, project, policy, team, actorPersonId, grantIds,
      expiresAt: closesAt, ...(event.admissionRsvpReminderAt !== undefined ? { reminderAt: event.admissionRsvpReminderAt } : {}), now,
    });
    offerId = created.offer._id;
  } else {
    const offer = application.currentOfferId ? await ctx.db.get(application.currentOfferId) : null;
    if (!offer || offer.state !== "offered") throw new Error("The pending RSVP offer is missing.");
    if (offer.expiresAt === closesAt && offer.reminderAt === event.admissionRsvpReminderAt) return;
    offerId = offer._id;
    await ctx.db.patch(offer._id, {
      expiresAt: closesAt, reminderAt: event.admissionRsvpReminderAt,
      createdByPersonId: actorPersonId, createdByGrantIds: grantIds, version: offer.version + 1,
    });
    await ctx.scheduler.runAt(closesAt, internal.admissions.expireOffer, { offerId, expectedOfferVersion: offer.version + 1 });
    if (event.admissionRsvpReminderAt !== undefined) {
      await ctx.scheduler.runAt(event.admissionRsvpReminderAt, internal.admissionOfferCalls.remind, { offerId });
    }
    // A changed deadline needs a corrected invitation; a call-time edit alone does not.
    if (offer.expiresAt !== closesAt) {
      await ctx.db.patch(application._id, { version: application.version + 1 });
      await ctx.scheduler.runAfter(0, internal.admissions.updateRosterOnboardingStatus, {
        applicationId: application._id, expectedApplicationVersion: application.version + 1,
        lockedRosterSnapshotId: project.lockedRosterSnapshotId, onboardingStatus: "offer_pending", cursor: null,
      });
      const communications = await ctx.db.query("communicationsPolicyVersions")
        .withIndex("by_event_status", q => q.eq("eventId", event._id).eq("status", "published")).unique();
      if (!communications) throw new Error("Published communications are missing.");
      await enqueueApplicationNotifications(ctx, {
        eventId: event._id, applicationId: application._id, teamId: team._id,
        lockedRosterSnapshotId: project.lockedRosterSnapshotId, lockedMemberCount: project.lockedMemberCount,
        communicationsPolicyVersionId: communications._id, templateKey: "offer", applicationVersion: application.version + 1, now,
      });
    }
  }
  await writeAuditEvent(ctx, {
    eventId: event._id, actorPersonId, permissionKey: "application.offer.manage", grantIds,
    scopeType: "application", scopeId: application._id, action: "admission.rsvp_scheduled",
    targetType: "admission_offer", targetId: offerId,
    nextSummary: JSON.stringify({ closesAt, reminderAt: event.admissionRsvpReminderAt }), reason: "Apply the event RSVP schedule",
  });
}

export const openForApplication = internalMutation({
  args: { applicationId: v.id("applications") }, returns: v.null(),
  handler: async (ctx, args) => {
    const application = await ctx.db.get(args.applicationId);
    if (!application) return null;
    const event = await ctx.db.get(application.eventId);
    if (event?.admissionResultsReleasedAt !== undefined) await applySchedule(ctx, event, application);
    return null;
  },
});

export const applyBatch = internalMutation({
  args: { eventId: v.id("events"), cursor: v.union(v.string(), v.null()) }, returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event || event.admissionResultsReleasedAt === undefined) return null;
    const page = await ctx.db.query("applications")
      .withIndex("by_event_submitted", q => q.eq("eventId", event._id))
      .paginate({ cursor: args.cursor, numItems: 1 });
    for (const application of page.page) await applySchedule(ctx, event, application);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.admissionRsvp.applyBatch, { eventId: event._id, cursor: page.continueCursor });
    return null;
  },
});

export const configure = mutation({
  args: {
    eventSlug: v.string(), expectedEventVersion: v.number(), closesAt: v.number(), reminderAt: v.optional(v.number()),
    reason: v.string(), clientOperationId: v.string(),
  }, returns: v.null(),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const fingerprint = operationFingerprint([args.expectedEventVersion, args.closesAt, args.reminderAt ?? null, args.reason]);
    const operation = { eventId: event._id, actorPersonId: person._id, clientOperationId: args.clientOperationId,
      commandName: "admissions.rsvp.configure", requestFingerprint: fingerprint };
    if (await findOperation(ctx, operation)) return null;
    const grantIds = await requirePermission(ctx, {
      eventId: event._id, eventAccessSubjectId: subject._id, permissionKey: "application.offer.manage", scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) throw new ConvexError({ code: "EVENT_CHANGED", message: "Refresh the RSVP settings before saving." });
    if (event.admissionResultsReleasedAt === undefined) throw new ConvexError({ code: "RESULTS_NOT_RELEASED", message: "Set the RSVP schedule when releasing results." });
    validateAdmissionRsvpSchedule(event, args.closesAt, args.reminderAt, Date.now());
    const selected = await ctx.db.query("applications")
      .withIndex("by_event_state_submitted", q => q.eq("eventId", event._id).eq("state", "accepted")).take(2001);
    if (selected.length > 2000) throw new ConvexError({ code: "RSVP_BATCH_TOO_LARGE", message: "The selected cohort exceeds the supported event size." });
    await requireAdmissionRsvpCapacity(ctx, selected);
    const reason = normalizedText(args.reason, "RSVP schedule note", 5, 500);
    const now = Date.now();
    await ctx.db.patch(event._id, { admissionRsvpClosesAt: args.closesAt, admissionRsvpReminderAt: args.reminderAt,
      admissionRsvpOpenedByPersonId: person._id, version: event.version + 1, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.admissionRsvp.applyBatch, { eventId: event._id, cursor: null });
    await recordOperation(ctx, { ...operation, targetType: "event", targetId: event._id, resultJson: "null", createdAt: now });
    await writeAuditEvent(ctx, {
      eventId: event._id, actorPersonId: person._id, permissionKey: "application.offer.manage", grantIds,
      scopeType: "event", action: "admission.rsvp_configured", targetType: "event", targetId: event._id,
      nextSummary: JSON.stringify({ closesAt: args.closesAt, reminderAt: args.reminderAt }), reason,
    });
    return null;
  },
});
