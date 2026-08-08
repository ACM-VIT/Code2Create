import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { loadPublishedCommunicationsPolicy } from "./communicationsPolicy";
import { normalizeEmail } from "./strings";

type AdmissionDecision = NonNullable<Doc<"applications">["humanDecision"]>;
export type ParticipantNotificationTemplate =
  Doc<"participantNotificationDeliveries">["templateKey"];

export function applicationMatchesNotification(
  application: Doc<"applications">,
  delivery: Doc<"participantNotificationDeliveries">,
): boolean {
  if (
    application.eventId !== delivery.eventId ||
    application.teamId !== delivery.teamId ||
    application.version < delivery.applicationVersion
  ) {
    return false;
  }
  switch (delivery.templateKey) {
    case "accept":
    case "waitlist":
    case "decline":
    case "needs_information":
      return application.humanDecision === delivery.templateKey;
    case "offer":
      return (
        application.version === delivery.applicationVersion &&
        application.state === "offer_sent"
      );
    case "offer_confirmed":
      return (
        application.version === delivery.applicationVersion &&
        application.state === "confirmed"
      );
    case "offer_declined":
      return (
        application.version === delivery.applicationVersion &&
        application.state === "withdrawn"
      );
    case "offer_expired":
      return (
        application.version === delivery.applicationVersion &&
        application.state === "offer_expired"
      );
  }
}

export async function enqueueApplicationNotifications(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    applicationId: Id<"applications">;
    teamId: Id<"teams">;
    lockedTeamMemberIds: Id<"teamMembers">[];
    templateKey: ParticipantNotificationTemplate;
    applicationVersion: number;
    now: number;
  },
) {
  const event = await ctx.db.get(args.eventId);
  if (!event) throw new Error("Participant notification event is missing.");
  const { policy: communicationsPolicy } = await loadPublishedCommunicationsPolicy(ctx, event);
  const deliveryIds: Id<"participantNotificationDeliveries">[] = [];
  for (const teamMemberId of args.lockedTeamMemberIds) {
    const teamMember = await ctx.db.get(teamMemberId);
    if (!teamMember || teamMember.teamId !== args.teamId || teamMember.status !== "active") {
      throw new Error("Locked team membership is missing for participant notification.");
    }
    const membership = await ctx.db.get(teamMember.membershipId);
    if (!membership || membership.eventId !== args.eventId) {
      throw new Error("Participant membership is missing for participant notification.");
    }
    const person = await ctx.db.get(membership.personId);
    if (!person || person.status !== "active") {
      throw new Error("Participant identity is missing for participant notification.");
    }
    const emailNormalized = normalizeEmail(person.verifiedEmail);
    let destination = await ctx.db
      .query("participantNotificationDestinations")
      .withIndex("by_event_person_channel", (index) =>
        index
          .eq("eventId", args.eventId)
          .eq("personId", person._id)
          .eq("channel", "verified_email"),
      )
      .unique();
    if (!destination) {
      const destinationId = await ctx.db.insert("participantNotificationDestinations", {
        eventId: args.eventId,
        membershipId: membership._id,
        personId: person._id,
        channel: "verified_email",
        emailNormalized,
        status: "active",
        version: 1,
        createdAt: args.now,
        updatedAt: args.now,
      });
      destination = await ctx.db.get(destinationId);
    } else if (destination.emailNormalized !== emailNormalized) {
      await ctx.db.patch(destination._id, {
        membershipId: membership._id,
        emailNormalized,
        status: "active",
        disabledAt: undefined,
        disabledByPersonId: undefined,
        disabledReasonCode: undefined,
        version: destination.version + 1,
        updatedAt: args.now,
      });
      destination = await ctx.db.get(destination._id);
    }
    if (!destination) throw new Error("Participant notification destination did not persist.");

    const rootNotificationKey = [
      args.templateKey,
      args.applicationId,
      args.applicationVersion,
      membership._id,
    ].join(":");
    const existing = await ctx.db
      .query("participantNotificationDeliveries")
      .withIndex("by_root_retry", (index) =>
        index.eq("rootNotificationKey", rootNotificationKey),
      )
      .first();
    if (existing) {
      deliveryIds.push(existing._id);
      continue;
    }
    const destinationActive = destination.status === "active";
    const deliveryId = await ctx.db.insert("participantNotificationDeliveries", {
      eventId: args.eventId,
      applicationId: args.applicationId,
      teamId: args.teamId,
      membershipId: membership._id,
      personId: person._id,
      destinationId: destination._id,
      communicationsPolicyVersionId: communicationsPolicy._id,
      channel: "verified_email",
      destinationEmailNormalized: destination.emailNormalized,
      templateKey: args.templateKey,
      applicationVersion: args.applicationVersion,
      portalPath: "/",
      rootNotificationKey,
      retryNumber: 0,
      state: destinationActive ? "pending" : "suppressed",
      attemptCount: 0,
      ...(!destinationActive
        ? {
            providerErrorCode: "destination_disabled",
            completedAt: args.now,
          }
        : {}),
      version: 1,
      createdAt: args.now,
      updatedAt: args.now,
    });
    deliveryIds.push(deliveryId);
    if (destinationActive) {
      await ctx.scheduler.runAfter(0, internal.participantEmail.deliver, { deliveryId });
    }
  }
  return deliveryIds;
}

export async function enqueueAdmissionDecisionNotifications(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    applicationId: Id<"applications">;
    teamId: Id<"teams">;
    lockedTeamMemberIds: Id<"teamMembers">[];
    decision: AdmissionDecision;
    applicationVersion: number;
    now: number;
  },
) {
  return enqueueApplicationNotifications(ctx, { ...args, templateKey: args.decision });
}
