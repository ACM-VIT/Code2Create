import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject, requireMembership } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import {
  applicationMatchesNotification,
  ensureApplicationNotification,
} from "./lib/participantNotificationDelivery";
import { normalizeEmail, normalizedText } from "./lib/strings";
import { appendParticipantDeliveryReadFactById } from "./lib/operationsAutonomyReadFacts/participantDeliveries";
import { participantEmailProvider } from "./values";

const notificationTemplateKey = v.union(
  v.literal("accept"),
  v.literal("waitlist"),
  v.literal("decline"),
  v.literal("offer"),
  v.literal("offer_confirmed"),
  v.literal("offer_declined"),
  v.literal("offer_expired"),
  v.literal("external_event_pass"),
);

const notificationDeliveryState = v.union(
  v.literal("pending"),
  v.literal("sending"),
  v.literal("retry_wait"),
  v.literal("sent"),
  v.literal("delivery_delayed"),
  v.literal("delivered"),
  v.literal("bounced"),
  v.literal("failed"),
  v.literal("suppressed"),
  v.literal("unknown"),
  v.literal("superseded"),
);

const participantDeliveryView = v.object({
  templateKey: notificationTemplateKey,
  state: notificationDeliveryState,
  createdAt: v.number(),
  updatedAt: v.number(),
  deliveredAt: v.optional(v.number()),
});

const operationsDeliveryView = v.object({
  id: v.id("participantNotificationDeliveries"),
  state: notificationDeliveryState,
  provider: v.optional(participantEmailProvider),
  version: v.number(),
  updatedAt: v.number(),
});

const retryOperationResult = z
  .object({
    deliveryId: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict();

const disableDestinationOperationResult = z
  .object({
    destinationId: z.string().min(1),
    status: z.literal("disabled"),
    version: z.number().int().positive(),
    suppressedDeliveryCount: z.number().int().nonnegative(),
  })
  .strict();

const operationsRecipientView = v.object({
  personId: v.id("people"),
  displayName: v.string(),
  destination: v.union(
    v.null(),
    v.object({
      id: v.id("participantNotificationDestinations"),
      email: v.string(),
      status: v.union(v.literal("active"), v.literal("disabled")),
      version: v.number(),
    }),
  ),
  delivery: v.union(v.null(), operationsDeliveryView),
  canManage: v.boolean(),
});

const notificationRosterBatchSize = 50;

export const enqueueRosterBatch = internalMutation({
  args: {
    eventId: v.id("events"),
    applicationId: v.id("applications"),
    teamId: v.id("teams"),
    lockedRosterSnapshotId: v.id("teamSubmissionAttempts"),
    lockedMemberCount: v.number(),
    communicationsPolicyVersionId: v.id("communicationsPolicyVersions"),
    templateKey: notificationTemplateKey,
    applicationVersion: v.number(),
    cursor: v.union(v.string(), v.null()),
    processedMemberCount: v.number(),
    participantClass: v.optional(v.literal("external_participant")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const [application, snapshot, communicationsPolicy] = await Promise.all([
      ctx.db.get(args.applicationId),
      ctx.db.get(args.lockedRosterSnapshotId),
      ctx.db.get(args.communicationsPolicyVersionId),
    ]);
    if (
      !application ||
      application.eventId !== args.eventId ||
      application.teamId !== args.teamId ||
      !snapshot ||
      snapshot.eventId !== args.eventId ||
      snapshot.teamId !== args.teamId ||
      snapshot.state !== "complete" ||
      snapshot.processedMemberCount !== args.lockedMemberCount ||
      !communicationsPolicy ||
      communicationsPolicy.eventId !== args.eventId ||
      (communicationsPolicy.status !== "published" && communicationsPolicy.status !== "superseded")
    ) {
      throw new Error("The participant notification batch context is invalid.");
    }
    if (!applicationMatchesNotification(application, args)) return null;
    const page = await ctx.db
      .query("teamSubmissionMembers")
      .withIndex("by_submission_attempt_and_ordinal", (index) =>
        index.eq("submissionAttemptId", snapshot._id),
      )
      .paginate({ numItems: notificationRosterBatchSize, cursor: args.cursor });
    const now = Date.now();
    for (const snapshotMember of page.page) {
      if (args.participantClass !== undefined) {
        const membership = await ctx.db.get(snapshotMember.membershipId);
        if (!membership || membership.eventId !== args.eventId) {
          throw new Error("The participant notification membership is invalid.");
        }
        if (membership.participantClass !== args.participantClass) continue;
      }
      await ensureApplicationNotification(ctx, {
        eventId: args.eventId,
        applicationId: application._id,
        teamId: args.teamId,
        snapshotMember,
        communicationsPolicyVersionId: communicationsPolicy._id,
        notificationProvider: communicationsPolicy.notificationProvider,
        templateKey: args.templateKey,
        applicationVersion: args.applicationVersion,
        now,
      });
    }
    const processedMemberCount = args.processedMemberCount + page.page.length;
    if (page.isDone) {
      if (processedMemberCount !== args.lockedMemberCount) {
        throw new Error("The participant notification roster is incomplete.");
      }
      return null;
    }
    await ctx.scheduler.runAfter(0, internal.participantNotifications.enqueueRosterBatch, {
      ...args,
      cursor: page.continueCursor,
      processedMemberCount,
    });
    return null;
  },
});

export const mine = query({
  args: { eventSlug: v.string() },
  returns: v.union(v.null(), participantDeliveryView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const readGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "communications.delivery.self.read",
      scopeType: "self",
      scopeId: membership._id,
    });
    if (readGrantIds.length === 0) return null;
    const delivery = await ctx.db
      .query("participantNotificationDeliveries")
      .withIndex("by_membership_created", (index) => index.eq("membershipId", membership._id))
      .order("desc")
      .first();
    if (!delivery || delivery.eventId !== event._id) return null;
    return {
      templateKey: delivery.templateKey,
      state: delivery.state,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
      ...(delivery.deliveredAt !== undefined ? { deliveredAt: delivery.deliveredAt } : {}),
    };
  },
});

export const forApplication = query({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(operationsRecipientView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const application = await ctx.db.get(args.applicationId);
    if (!application || application.eventId !== event._id) {
      throw new ConvexError({
        code: "APPLICATION_NOT_FOUND",
        message: "The application does not exist in this event.",
      });
    }
    const project = await ctx.db.get(application.submittedProjectVersionId);
    if (!project || project.eventId !== event._id || project.teamId !== application.teamId) {
      throw new Error("The submitted project snapshot is missing.");
    }

    const page = await ctx.db
      .query("teamSubmissionMembers")
      .withIndex("by_submission_attempt_and_ordinal", (index) =>
        index.eq("submissionAttemptId", project.lockedRosterSnapshotId),
      )
      .paginate(args.paginationOpts);
    const recipients = [];
    for (const snapshotMember of page.page) {
      if (snapshotMember.eventId !== event._id || snapshotMember.teamId !== application.teamId) {
        throw new Error("The locked team snapshot is invalid.");
      }
      const membership = await ctx.db.get(snapshotMember.membershipId);
      if (!membership || membership.eventId !== event._id) {
        throw new Error("The locked team snapshot is missing a participant membership.");
      }
      const readGrantIds = await matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "communications.delivery.read",
        scopeType: "person",
        scopeId: membership.personId,
      });
      if (readGrantIds.length === 0) continue;
      const [recipient, destination, delivery, manageGrantIds] = await Promise.all([
        ctx.db.get(snapshotMember.personId),
        ctx.db
          .query("participantNotificationDestinations")
          .withIndex("by_event_person_channel", (index) =>
            index
              .eq("eventId", event._id)
              .eq("personId", membership.personId)
              .eq("channel", "verified_email"),
          )
          .unique(),
        ctx.db
          .query("participantNotificationDeliveries")
          .withIndex("by_application_membership_created", (index) =>
            index.eq("applicationId", application._id).eq("membershipId", membership._id),
          )
          .order("desc")
          .first(),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "communications.delivery.manage",
          scopeType: "person",
          scopeId: membership.personId,
        }),
      ]);
      if (!recipient) throw new Error("The notification recipient identity is missing.");
      if (destination && destination.membershipId !== membership._id) {
        throw new Error("The notification destination belongs to another membership.");
      }
      if (
        delivery &&
        (delivery.eventId !== event._id || delivery.personId !== membership.personId)
      ) {
        throw new Error("The notification delivery belongs to another recipient.");
      }
      recipients.push({
        personId: recipient._id,
        displayName: recipient.displayName,
        destination: destination
          ? {
              id: destination._id,
              email: destination.emailNormalized,
              status: destination.status,
              version: destination.version,
            }
          : null,
        delivery: delivery
          ? {
              id: delivery._id,
              state: delivery.state,
              ...(delivery.provider !== undefined ? { provider: delivery.provider } : {}),
              version: delivery.version,
              updatedAt: delivery.updatedAt,
            }
          : null,
        canManage: manageGrantIds.length > 0,
      });
    }
    return { ...page, page: recipients };
  },
});

export const retry = mutation({
  args: {
    eventSlug: v.string(),
    deliveryId: v.id("participantNotificationDeliveries"),
    expectedDeliveryVersion: v.number(),
    confirmedNotAcceptedEvidence: v.optional(v.string()),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    deliveryId: v.id("participantNotificationDeliveries"),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 3, 300);
    const confirmedNotAcceptedEvidence = args.confirmedNotAcceptedEvidence === undefined
      ? undefined
      : normalizedText(args.confirmedNotAcceptedEvidence, "Non-acceptance evidence", 20, 1_000);
    const requestFingerprint = operationFingerprint([
      args.deliveryId,
      args.expectedDeliveryVersion,
      reason,
      confirmedNotAcceptedEvidence ?? "",
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "communications.delivery.retry",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "notification retry",
        retryOperationResult,
      );
      const deliveryId = ctx.db.normalizeId("participantNotificationDeliveries", result.deliveryId);
      if (!deliveryId || deliveryId !== prior.targetId) {
        throw new Error("The stored notification retry target is invalid.");
      }
      return { deliveryId, version: result.version };
    }

    const source = await ctx.db.get(args.deliveryId);
    if (!source || source.eventId !== event._id) {
      throw new ConvexError({
        code: "DELIVERY_NOT_FOUND",
        message: "The notification delivery does not exist in this event.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "communications.delivery.manage",
      scopeType: "person",
      scopeId: source.personId,
    });
    if (source.version !== args.expectedDeliveryVersion) {
      throw new ConvexError({
        code: "DELIVERY_CHANGED",
        message: "The notification delivery changed. Review its current state before retrying.",
      });
    }
    const reconciledUnknown = source.state === "unknown" &&
      confirmedNotAcceptedEvidence !== undefined &&
      source.providerMessageId === undefined && source.providerAcceptedAt === undefined;
    if (source.state !== "failed" && !reconciledUnknown) {
      throw new ConvexError({
        code: "DELIVERY_NOT_RETRYABLE",
        message:
          source.state === "unknown"
            ? "The provider outcome is unknown. Reconcile it with the provider before retrying."
            : "Only a definitively failed notification can be retried manually.",
      });
    }
    const latest = await ctx.db
      .query("participantNotificationDeliveries")
      .withIndex("by_root_retry", (index) =>
        index.eq("rootNotificationKey", source.rootNotificationKey),
      )
      .order("desc")
      .first();
    if (!latest || latest._id !== source._id) {
      throw new ConvexError({
        code: "DELIVERY_RETRY_SUPERSEDED",
        message: "A newer delivery attempt already exists.",
      });
    }
    const [application, destination, recipient] = await Promise.all([
      ctx.db.get(source.applicationId),
      ctx.db.get(source.destinationId),
      ctx.db.get(source.personId),
    ]);
    if (!application || !applicationMatchesNotification(application, source)) {
      throw new ConvexError({
        code: "DELIVERY_CONTEXT_CHANGED",
        message: "The application decision changed, so this notification cannot be retried.",
      });
    }
    if (
      !destination ||
      destination.eventId !== event._id ||
      destination.membershipId !== source.membershipId ||
      destination.personId !== source.personId ||
      destination.status !== "active" ||
      destination.emailNormalized !== source.destinationEmailNormalized
    ) {
      throw new ConvexError({
        code: "DESTINATION_NOT_ACTIVE",
        message: "The participant's verified email destination is not active.",
      });
    }
    if (
      !recipient ||
      recipient.status !== "active" ||
      normalizeEmail(recipient.verifiedEmail) !== source.destinationEmailNormalized
    ) {
      throw new ConvexError({
        code: "VERIFIED_EMAIL_CHANGED",
        message: "The participant's verified email changed. Do not retry the old destination.",
      });
    }

    const now = Date.now();
    await ctx.db.patch(source._id, {
      state: "superseded",
      version: source.version + 1,
      updatedAt: now,
    });
    await appendParticipantDeliveryReadFactById(ctx, source._id, now);
    const deliveryId = await ctx.db.insert("participantNotificationDeliveries", {
      eventId: source.eventId,
      applicationId: source.applicationId,
      teamId: source.teamId,
      membershipId: source.membershipId,
      personId: source.personId,
      destinationId: source.destinationId,
      communicationsPolicyVersionId: source.communicationsPolicyVersionId,
      ...(source.provider !== undefined ? { provider: source.provider } : {}),
      channel: "verified_email",
      destinationEmailNormalized: source.destinationEmailNormalized,
      templateKey: source.templateKey,
      applicationVersion: source.applicationVersion,
      portalPath: source.portalPath,
      rootNotificationKey: source.rootNotificationKey,
      retryNumber: source.retryNumber + 1,
      supersedesDeliveryId: source._id,
      state: "pending",
      attemptCount: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await appendParticipantDeliveryReadFactById(ctx, deliveryId, now);
    await ctx.scheduler.runAfter(0, internal.participantEmail.deliver, { deliveryId });
    const result = { deliveryId, version: 1 };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "communications.delivery.retry",
      requestFingerprint,
      targetType: "participant_notification_delivery",
      targetId: deliveryId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "communications.delivery.manage",
      grantIds,
      scopeType: "person",
      scopeId: source.personId,
      action: "communications.participant_notification_retried",
      targetType: "participant_notification_delivery",
      targetId: deliveryId,
      previousSummary: JSON.stringify({
        deliveryId: source._id,
        state: source.state,
        retryNumber: source.retryNumber,
        version: source.version,
        ...(reconciledUnknown ? { confirmedNotAcceptedEvidence } : {}),
      }),
      nextSummary: JSON.stringify({
        deliveryId,
        state: "pending",
        retryNumber: source.retryNumber + 1,
        version: result.version,
      }),
      reason,
    });
    return result;
  },
});

export const disableDestination = mutation({
  args: {
    eventSlug: v.string(),
    destinationId: v.id("participantNotificationDestinations"),
    expectedDestinationVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    destinationId: v.id("participantNotificationDestinations"),
    status: v.literal("disabled"),
    version: v.number(),
    suppressedDeliveryCount: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    destinationId: Id<"participantNotificationDestinations">;
    status: "disabled";
    version: number;
    suppressedDeliveryCount: number;
  }> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 3, 300);
    const requestFingerprint = operationFingerprint([
      args.destinationId,
      args.expectedDestinationVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "communications.destination.disable",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "destination-disable",
        disableDestinationOperationResult,
      );
      const destinationId = ctx.db.normalizeId(
        "participantNotificationDestinations",
        result.destinationId,
      );
      if (!destinationId || destinationId !== prior.targetId) {
        throw new Error("The stored destination-disable target is invalid.");
      }
      return {
        destinationId,
        status: result.status,
        version: result.version,
        suppressedDeliveryCount: result.suppressedDeliveryCount,
      };
    }

    const destination = await ctx.db.get(args.destinationId);
    if (!destination || destination.eventId !== event._id) {
      throw new ConvexError({
        code: "DESTINATION_NOT_FOUND",
        message: "The notification destination does not exist in this event.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "communications.delivery.manage",
      scopeType: "person",
      scopeId: destination.personId,
    });
    if (
      destination.version !== args.expectedDestinationVersion ||
      destination.status !== "active"
    ) {
      throw new ConvexError({
        code: "DESTINATION_CHANGED",
        message: "The destination changed. Review its current state before disabling it.",
      });
    }
    const [pending, retryWaiting] = await Promise.all([
      ctx.db
        .query("participantNotificationDeliveries")
        .withIndex("by_destination_state", (index) =>
          index.eq("destinationId", destination._id).eq("state", "pending"),
        )
        .collect(),
      ctx.db
        .query("participantNotificationDeliveries")
        .withIndex("by_destination_state", (index) =>
          index.eq("destinationId", destination._id).eq("state", "retry_wait"),
        )
        .collect(),
    ]);
    const now = Date.now();
    const suppressible = [...pending, ...retryWaiting];
    await ctx.db.patch(destination._id, {
      status: "disabled",
      disabledAt: now,
      disabledByPersonId: person._id,
      disabledReasonCode: "staff_disabled",
      version: destination.version + 1,
      updatedAt: now,
    });
    for (const delivery of suppressible) {
      await ctx.db.patch(delivery._id, {
        state: "suppressed",
        nextAttemptAt: undefined,
        providerErrorCode: "destination_disabled_by_staff",
        completedAt: now,
        version: delivery.version + 1,
        updatedAt: now,
      });
      await appendParticipantDeliveryReadFactById(ctx, delivery._id, now);
    }
    const result = {
      destinationId: destination._id,
      status: "disabled" as const,
      version: destination.version + 1,
      suppressedDeliveryCount: suppressible.length,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "communications.destination.disable",
      requestFingerprint,
      targetType: "participant_notification_destination",
      targetId: destination._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "communications.delivery.manage",
      grantIds,
      scopeType: "person",
      scopeId: destination.personId,
      action: "communications.participant_destination_disabled",
      targetType: "participant_notification_destination",
      targetId: destination._id,
      previousSummary: JSON.stringify({
        status: destination.status,
        version: destination.version,
      }),
      nextSummary: JSON.stringify({
        status: result.status,
        version: result.version,
        suppressedDeliveryCount: result.suppressedDeliveryCount,
      }),
      reason,
    });
    return result;
  },
});
