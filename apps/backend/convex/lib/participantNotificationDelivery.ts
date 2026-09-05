import type { Doc, Id } from "../_generated/dataModel";
import type { ParticipantEmailProvider } from "@code2create/domain";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { appendParticipantDeliveryReadFactById } from "./operationsAutonomyReadFacts/participantDeliveries";

type AdmissionDecision = NonNullable<Doc<"applications">["humanDecision"]>;
export type ParticipantNotificationTemplate =
  Doc<"participantNotificationDeliveries">["templateKey"];
type ApplicationNotificationContext = Pick<
  Doc<"participantNotificationDeliveries">,
  "eventId" | "teamId" | "templateKey" | "applicationVersion"
>;

export function applicationMatchesNotification(
  application: Doc<"applications">,
  delivery: ApplicationNotificationContext,
): boolean {
  if (application.eventId !== delivery.eventId || application.teamId !== delivery.teamId) {
    return false;
  }
  const isReleasedResult =
    delivery.templateKey === "accept" ||
    delivery.templateKey === "waitlist" ||
    delivery.templateKey === "decline";
  if (!isReleasedResult && application.version !== delivery.applicationVersion) return false;
  switch (delivery.templateKey) {
    case "accept":
    case "waitlist":
    case "decline":
      return (
        application.decisionStage === "released" &&
        application.humanDecision === delivery.templateKey
      );
    case "offer":
      return application.state === "offer_sent";
    case "offer_confirmed":
      return application.state === "confirmed";
    case "external_event_pass":
      return application.state === "confirmed";
    case "offer_declined":
      return application.state === "withdrawn";
    case "offer_expired":
      return application.state === "offer_expired";
  }
}

export async function enqueueApplicationNotifications(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    applicationId: Id<"applications">;
    teamId: Id<"teams">;
    lockedRosterSnapshotId: Id<"teamSubmissionAttempts">;
    lockedMemberCount: number;
    communicationsPolicyVersionId: Id<"communicationsPolicyVersions">;
    templateKey: ParticipantNotificationTemplate;
    applicationVersion: number;
    now: number;
    schedule?: false;
    participantClass?: "external_participant";
  },
) {
  const communicationsPolicy = await ctx.db.get(args.communicationsPolicyVersionId);
  if (
    !communicationsPolicy ||
    communicationsPolicy.eventId !== args.eventId ||
    (communicationsPolicy.status !== "published" && communicationsPolicy.status !== "superseded")
  ) {
    throw new Error("Participant notification communications policy is invalid.");
  }
  const snapshot = await ctx.db.get(args.lockedRosterSnapshotId);
  if (
    !snapshot ||
    snapshot.eventId !== args.eventId ||
    snapshot.teamId !== args.teamId ||
    snapshot.state !== "complete" ||
    snapshot.processedMemberCount !== args.lockedMemberCount
  ) {
    throw new Error("Locked roster snapshot is invalid for participant notification.");
  }
  if (args.schedule === false) return args.lockedMemberCount;
  await ctx.scheduler.runAfter(0, internal.participantNotifications.enqueueRosterBatch, {
    eventId: args.eventId,
    applicationId: args.applicationId,
    teamId: args.teamId,
    lockedRosterSnapshotId: args.lockedRosterSnapshotId,
    lockedMemberCount: args.lockedMemberCount,
    communicationsPolicyVersionId: communicationsPolicy._id,
    templateKey: args.templateKey,
    applicationVersion: args.applicationVersion,
    cursor: null,
    processedMemberCount: 0,
    ...(args.participantClass !== undefined ? { participantClass: args.participantClass } : {}),
  });
  return args.lockedMemberCount;
}

export async function ensureApplicationNotification(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    applicationId: Id<"applications">;
    teamId: Id<"teams">;
    snapshotMember: Doc<"teamSubmissionMembers">;
    communicationsPolicyVersionId: Id<"communicationsPolicyVersions">;
    notificationProvider: ParticipantEmailProvider;
    templateKey: ParticipantNotificationTemplate;
    applicationVersion: number;
    now: number;
  },
) {
  const { snapshotMember } = args;
  if (snapshotMember.eventId !== args.eventId || snapshotMember.teamId !== args.teamId) {
    throw new Error("Locked roster snapshot is invalid for participant notification.");
  }
  const membership = await ctx.db.get(snapshotMember.membershipId);
  if (
    !membership ||
    membership.eventId !== args.eventId ||
    membership.personId !== snapshotMember.personId
  ) {
    throw new Error("Participant membership is missing for participant notification.");
  }
  // External admissions are communicated by the registration team, outside this release.
  if (
    membership.participantClass === "external_participant" &&
    (args.templateKey === "accept" || args.templateKey === "waitlist" || args.templateKey === "decline")
  ) {
    return null;
  }
  const person = await ctx.db.get(snapshotMember.personId);
  if (!person || person.status !== "active") {
    throw new Error("Participant identity is missing for participant notification.");
  }
  const emailNormalized = snapshotMember.destinationEmailNormalized;
  let destination = await ctx.db
    .query("participantNotificationDestinations")
    .withIndex("by_event_person_channel", (index) =>
      index.eq("eventId", args.eventId).eq("personId", person._id).eq("channel", "verified_email"),
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
    .withIndex("by_root_retry", (index) => index.eq("rootNotificationKey", rootNotificationKey))
    .first();
  if (existing) {
    return existing._id;
  }
  const destinationActive = destination.status === "active";
  const deliveryId = await ctx.db.insert("participantNotificationDeliveries", {
    eventId: args.eventId,
    applicationId: args.applicationId,
    teamId: args.teamId,
    membershipId: membership._id,
    personId: person._id,
    destinationId: destination._id,
    communicationsPolicyVersionId: args.communicationsPolicyVersionId,
    provider: args.notificationProvider,
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
  await appendParticipantDeliveryReadFactById(ctx, deliveryId, args.now);
  if (destinationActive) {
    await ctx.scheduler.runAfter(0, internal.participantEmail.deliver, { deliveryId });
  }
  return deliveryId;
}

export async function enqueueAdmissionDecisionNotifications(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    applicationId: Id<"applications">;
    teamId: Id<"teams">;
    lockedRosterSnapshotId: Id<"teamSubmissionAttempts">;
    lockedMemberCount: number;
    communicationsPolicyVersionId: Id<"communicationsPolicyVersions">;
    decision: AdmissionDecision;
    applicationVersion: number;
    now: number;
  },
) {
  return enqueueApplicationNotifications(ctx, { ...args, templateKey: args.decision });
}
