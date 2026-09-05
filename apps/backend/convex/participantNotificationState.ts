import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { applicationMatchesNotification } from "./lib/participantNotificationDelivery";
import { normalizeEmail } from "./lib/strings";
import { appendParticipantDeliveryReadFactById } from "./lib/operationsAutonomyReadFacts/participantDeliveries";
import { participantEmailProvider, participantEmailTemplateKey } from "./values";

const maxAutomaticAttempts = 3;
const sendClaimMs = 30_000;

const providerEventType = v.union(
  v.literal("email.delivered"),
  v.literal("email.delivery_delayed"),
  v.literal("email.bounced"),
  v.literal("email.failed"),
  v.literal("email.suppressed"),
  v.literal("email.complained"),
);

const initialProviderOutcome = v.union(
  v.literal("queued"),
  v.literal("delivered"),
  v.literal("permanent_bounce"),
);

const deliveryClaim = v.union(
  v.null(),
  v.object({
    deliveryId: v.id("participantNotificationDeliveries"),
    templateKey: participantEmailTemplateKey,
    notificationProvider: participantEmailProvider,
    eventId: v.id("events"),
    eventSlug: v.string(),
    membershipId: v.id("eventMemberships"),
    participantClass: v.union(v.literal("vit_student"), v.literal("external_participant")),
    destinationEmail: v.string(),
    portalPath: v.string(),
    subjectTemplate: v.string(),
    textTemplate: v.string(),
    htmlTemplate: v.string(),
    participantName: v.string(),
    teamName: v.string(),
    eventName: v.string(),
    eventStartsAt: v.number(),
    eventEndsAt: v.number(),
    eventTimezone: v.string(),
    rsvpDeadline: v.optional(v.number()),
    venueName: v.string(),
    assets: v.array(
      v.object({
        storageId: v.id("_storage"),
        fileName: v.string(),
        contentType: v.string(),
        contentId: v.string(),
        disposition: v.union(v.literal("inline"), v.literal("attachment")),
        byteCount: v.number(),
        sha256: v.string(),
      }),
    ),
  }),
);

async function finishWithoutSend(
  ctx: MutationCtx,
  delivery: Doc<"participantNotificationDeliveries">,
  state: "failed" | "suppressed" | "superseded" | "unknown",
  errorCode: string,
  now: number,
) {
  await ctx.db.patch(delivery._id, {
    state,
    attemptId: undefined,
    claimExpiresAt: undefined,
    nextAttemptAt: undefined,
    providerErrorCode: errorCode,
    version: delivery.version + 1,
    updatedAt: now,
    completedAt: now,
  });
  await appendParticipantDeliveryReadFactById(ctx, delivery._id, now);
}

export const claimDelivery = internalMutation({
  args: {
    deliveryId: v.id("participantNotificationDeliveries"),
    attemptId: v.string(),
  },
  returns: deliveryClaim,
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery) return null;
    const now = Date.now();
    if (delivery.state === "sending" && (delivery.claimExpiresAt ?? 0) <= now) {
      await finishWithoutSend(
        ctx,
        delivery,
        "unknown",
        "email_send_outcome_unknown",
        now,
      );
      return null;
    }
    const canClaim =
      delivery.state === "pending" ||
      (delivery.state === "retry_wait" && (delivery.nextAttemptAt ?? 0) <= now);
    if (!canClaim) return null;
    const [event, application, destination, person, membership, communicationsPolicy, team] = await Promise.all(
      [
        ctx.db.get(delivery.eventId),
        ctx.db.get(delivery.applicationId),
        ctx.db.get(delivery.destinationId),
        ctx.db.get(delivery.personId),
        ctx.db.get(delivery.membershipId),
        ctx.db.get(delivery.communicationsPolicyVersionId),
        ctx.db.get(delivery.teamId),
      ],
    );
    if (!event || !application || !applicationMatchesNotification(application, delivery)) {
      await finishWithoutSend(ctx, delivery, "superseded", "application_state_changed", now);
      return null;
    }
    if (
      !membership ||
      membership.eventId !== delivery.eventId ||
      membership.personId !== delivery.personId
    ) {
      await finishWithoutSend(ctx, delivery, "failed", "membership_context_invalid", now);
      return null;
    }
    if (membership.participantClass === "external_participant" && delivery.templateKey !== "external_event_pass") {
      await finishWithoutSend(ctx, delivery, "suppressed", "external_admission_notification_disabled", now);
      return null;
    }
    if (delivery.templateKey === "offer") {
      const project = await ctx.db.get(application.submittedProjectVersionId);
      if (!project || project.lockedLeadMembershipId !== membership._id) {
        await finishWithoutSend(ctx, delivery, "suppressed", "rsvp_recipient_not_team_lead", now);
        return null;
      }
    }
    if (
      !communicationsPolicy ||
      communicationsPolicy.eventId !== delivery.eventId ||
      (communicationsPolicy.status !== "published" && communicationsPolicy.status !== "superseded")
    ) {
      await finishWithoutSend(ctx, delivery, "failed", "communications_policy_invalid", now);
      return null;
    }
    if (
      delivery.provider !== undefined &&
      delivery.provider !== communicationsPolicy.notificationProvider
    ) {
      await finishWithoutSend(ctx, delivery, "failed", "email_provider_pin_invalid", now);
      return null;
    }
    if (
      !destination ||
      destination.eventId !== delivery.eventId ||
      destination.personId !== delivery.personId ||
      destination.membershipId !== delivery.membershipId ||
      destination.channel !== "verified_email" ||
      destination.status !== "active" ||
      destination.emailNormalized !== delivery.destinationEmailNormalized
    ) {
      await finishWithoutSend(ctx, delivery, "suppressed", "destination_not_active", now);
      return null;
    }
    if (
      !person ||
      person.status !== "active" ||
      normalizeEmail(person.verifiedEmail) !== delivery.destinationEmailNormalized
    ) {
      await finishWithoutSend(ctx, delivery, "suppressed", "verified_email_changed", now);
      return null;
    }
    if (!team || team.eventId !== delivery.eventId) {
      await finishWithoutSend(ctx, delivery, "failed", "team_context_invalid", now);
      return null;
    }
    if (delivery.attemptCount >= maxAutomaticAttempts) {
      await finishWithoutSend(ctx, delivery, "failed", "send_attempts_exhausted", now);
      return null;
    }
    const emailTemplate = communicationsPolicy.emailTemplates.find(
      (template) => template.templateKey === delivery.templateKey,
    );
    if (!emailTemplate) {
      await finishWithoutSend(ctx, delivery, "failed", "email_template_missing", now);
      return null;
    }
    const assetBundle = emailTemplate.assetBundleId
      ? await ctx.db.get(emailTemplate.assetBundleId)
      : null;
    if (
      emailTemplate.assetBundleId !== undefined &&
      (!assetBundle ||
        assetBundle.eventId !== delivery.eventId ||
        assetBundle.templateKey !== delivery.templateKey)
    ) {
      await finishWithoutSend(ctx, delivery, "failed", "email_asset_bundle_invalid", now);
      return null;
    }
    const claimExpiresAt = now + sendClaimMs;
    await ctx.db.patch(delivery._id, {
      state: "sending",
      provider: communicationsPolicy.notificationProvider,
      attemptCount: delivery.attemptCount + 1,
      attemptId: args.attemptId,
      claimExpiresAt,
      nextAttemptAt: undefined,
      providerErrorCode: undefined,
      version: delivery.version + 1,
      updatedAt: now,
    });
    await appendParticipantDeliveryReadFactById(ctx, delivery._id, now);
    await ctx.scheduler.runAt(claimExpiresAt, internal.participantEmail.deliver, {
      deliveryId: delivery._id,
    });
    const offer = application.currentOfferId ? await ctx.db.get(application.currentOfferId) : null;
    return {
      ...(offer ? { rsvpDeadline: offer.expiresAt } : {}),
      deliveryId: delivery._id,
      templateKey: delivery.templateKey,
      notificationProvider: communicationsPolicy.notificationProvider,
      eventId: event._id,
      eventSlug: event.slug,
      membershipId: membership._id,
      participantClass: membership.participantClass,
      destinationEmail: destination.emailNormalized,
      portalPath: delivery.portalPath,
      subjectTemplate: emailTemplate.subject,
      textTemplate: emailTemplate.text,
      htmlTemplate: emailTemplate.html,
      participantName: person.displayName,
      teamName: team.name,
      eventName: event.name,
      eventStartsAt: communicationsPolicy.startsAt,
      eventEndsAt: communicationsPolicy.endsAt,
      eventTimezone: event.timezone,
      venueName: communicationsPolicy.venueName,
      assets: (assetBundle?.assets ?? []).map((asset) => ({
        storageId: asset.storageId,
        fileName: asset.fileName,
        contentType: asset.contentType,
        contentId: asset.contentId,
        disposition: asset.disposition,
        byteCount: asset.byteCount,
        sha256: asset.sha256,
      })),
    };
  },
});

async function disableDestinationForProviderFailure(
  ctx: MutationCtx,
  delivery: Doc<"participantNotificationDeliveries">,
  reasonCode: string,
  now: number,
) {
  const destination = await ctx.db.get(delivery.destinationId);
  if (
    destination &&
    destination.eventId === delivery.eventId &&
    destination.personId === delivery.personId &&
    destination.emailNormalized === delivery.destinationEmailNormalized &&
    destination.status === "active"
  ) {
    await ctx.db.patch(destination._id, {
      status: "disabled",
      disabledAt: now,
      disabledByPersonId: undefined,
      disabledReasonCode: reasonCode,
      version: destination.version + 1,
      updatedAt: now,
    });
  }
}

async function applyProviderEvent(
  ctx: MutationCtx,
  providerEvent: Doc<"participantNotificationProviderEvents">,
  delivery: Doc<"participantNotificationDeliveries">,
) {
  if (providerEvent.appliedAt !== undefined) return true;
  const now = Date.now();
  // The immutable policy records which provider owns this delivery, including
  // deliveries whose send response did not persist a provider pin.
  const policy = await ctx.db.get(delivery.communicationsPolicyVersionId);
  if (
    !policy ||
    policy.eventId !== delivery.eventId ||
    policy.notificationProvider !== providerEvent.provider ||
    (delivery.provider !== undefined && delivery.provider !== providerEvent.provider)
  ) {
    return false;
  }
  if (delivery.providerMessageId !== providerEvent.providerMessageId) {
    throw new Error("Participant email event does not match the delivery message ID.");
  }
  if (delivery.destinationEmailNormalized !== providerEvent.recipientEmailNormalized) {
    throw new Error("Participant email event does not match the delivery recipient.");
  }
  const olderThanCurrent =
    delivery.lastProviderEventAt !== undefined &&
    (providerEvent.providerAt < delivery.lastProviderEventAt ||
      (providerEvent.providerAt === delivery.lastProviderEventAt &&
        delivery.lastProviderEventId !== undefined &&
        providerEvent.eventId <= delivery.lastProviderEventId));
  if (olderThanCurrent) {
    await ctx.db.patch(providerEvent._id, { appliedAt: now });
    return true;
  }

  const common = {
    provider: providerEvent.provider,
    lastProviderEventAt: providerEvent.providerAt,
    lastProviderEventId: providerEvent.eventId,
    version: delivery.version + 1,
    updatedAt: now,
  };
  if (providerEvent.eventType === "email.delivered") {
    await ctx.db.patch(delivery._id, {
      ...common,
      state: "delivered",
      sentAt: delivery.sentAt ?? providerEvent.providerAt,
      deliveredAt: providerEvent.providerAt,
      completedAt: providerEvent.providerAt,
      providerErrorCode: undefined,
    });
  } else if (providerEvent.eventType === "email.delivery_delayed") {
    await ctx.db.patch(delivery._id, {
      ...common,
      state: "delivery_delayed",
      completedAt: undefined,
      providerErrorCode: providerEvent.providerErrorCode ?? "cloudflare_email_deferred",
    });
  } else {
    const state =
      providerEvent.eventType === "email.bounced"
        ? "bounced"
        : providerEvent.eventType === "email.failed"
          ? "failed"
          : "suppressed";
    const reasonCode =
      providerEvent.providerErrorCode ?? providerEvent.eventType.replaceAll(".", "_");
    await ctx.db.patch(delivery._id, {
      ...common,
      state,
      providerErrorCode: reasonCode,
      completedAt: providerEvent.providerAt,
    });
    if (providerEvent.disableDestination) {
      await disableDestinationForProviderFailure(ctx, delivery, reasonCode, now);
    }
  }
  await appendParticipantDeliveryReadFactById(ctx, delivery._id, now);
  await ctx.db.patch(providerEvent._id, { appliedAt: now });
  return true;
}

export const recordSent = internalMutation({
  args: {
    deliveryId: v.id("participantNotificationDeliveries"),
    attemptId: v.string(),
    provider: participantEmailProvider,
    providerMessageId: v.string(),
    initialOutcome: initialProviderOutcome,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.state !== "sending" || delivery.attemptId !== args.attemptId) {
      return null;
    }
    if (delivery.provider !== undefined && delivery.provider !== args.provider) {
      throw new Error("Participant email provider changed during delivery.");
    }
    const now = Date.now();
    const state =
      args.initialOutcome === "queued"
        ? "sent"
        : args.initialOutcome === "delivered"
          ? "delivered"
          : "bounced";
    await ctx.db.patch(delivery._id, {
      state,
      attemptId: undefined,
      claimExpiresAt: undefined,
      nextAttemptAt: undefined,
      provider: args.provider,
      providerMessageId: args.providerMessageId,
      providerAcceptedAt: now,
      providerErrorCode:
        args.initialOutcome === "permanent_bounce"
          ? `${args.provider}_permanent_bounce`
          : undefined,
      sentAt: now,
      deliveredAt: args.initialOutcome === "delivered" ? now : undefined,
      completedAt: args.initialOutcome === "queued" ? undefined : now,
      version: delivery.version + 1,
      updatedAt: now,
    });
    await appendParticipantDeliveryReadFactById(ctx, delivery._id, now);
    if (args.initialOutcome === "permanent_bounce") {
      await disableDestinationForProviderFailure(
        ctx,
        delivery,
        `${args.provider}_permanent_bounce`,
        now,
      );
    }
    const providerEvents = args.provider === "cloudflare_email"
      ? await ctx.db
          .query("participantNotificationProviderEvents")
          .withIndex("by_provider_message_time", (index) =>
            index.eq("providerMessageId", args.providerMessageId),
          )
          .collect()
      : [];
    providerEvents.sort(
      (left, right) =>
        left.providerAt - right.providerAt || left.eventId.localeCompare(right.eventId),
    );
    for (const providerEvent of providerEvents) {
      const current = await ctx.db.get(delivery._id);
      if (!current) break;
      await applyProviderEvent(ctx, providerEvent, current);
    }
    return null;
  },
});

export const recordSendFailure = internalMutation({
  args: {
    deliveryId: v.id("participantNotificationDeliveries"),
    attemptId: v.string(),
    errorCode: v.string(),
    retryable: v.boolean(),
    ambiguous: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.state !== "sending" || delivery.attemptId !== args.attemptId) {
      return null;
    }
    const now = Date.now();
    if (args.ambiguous) {
      await finishWithoutSend(ctx, delivery, "unknown", args.errorCode, now);
      return null;
    }
    if (args.retryable && delivery.attemptCount < maxAutomaticAttempts) {
      const delayMs = delivery.attemptCount === 1 ? 5_000 : 30_000;
      const nextAttemptAt = now + delayMs;
      await ctx.db.patch(delivery._id, {
        state: "retry_wait",
        attemptId: undefined,
        claimExpiresAt: undefined,
        nextAttemptAt,
        providerErrorCode: args.errorCode,
        version: delivery.version + 1,
        updatedAt: now,
      });
      await appendParticipantDeliveryReadFactById(ctx, delivery._id, now);
      await ctx.scheduler.runAt(nextAttemptAt, internal.participantEmail.deliver, {
        deliveryId: delivery._id,
      });
      return null;
    }
    await finishWithoutSend(ctx, delivery, "failed", args.errorCode, now);
    return null;
  },
});

export const recordProviderEvent = internalMutation({
  args: {
    eventId: v.string(),
    providerMessageId: v.string(),
    recipientEmailNormalized: v.string(),
    eventType: providerEventType,
    providerAt: v.number(),
    disableDestination: v.boolean(),
    providerErrorCode: v.optional(v.string()),
    payloadHash: v.string(),
  },
  returns: v.object({ duplicate: v.boolean(), matched: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("participantNotificationProviderEvents")
      .withIndex("by_provider_event", (index) =>
        index.eq("provider", "cloudflare_email").eq("eventId", args.eventId),
      )
      .unique();
    if (existing) {
      if (
        existing.providerMessageId !== args.providerMessageId ||
        existing.recipientEmailNormalized !== args.recipientEmailNormalized ||
        existing.eventType !== args.eventType ||
        existing.providerAt !== args.providerAt ||
        existing.disableDestination !== args.disableDestination ||
        existing.providerErrorCode !== args.providerErrorCode ||
        existing.payloadHash !== args.payloadHash
      ) {
        throw new Error("Cloudflare Email event ID was reused with different content.");
      }
      if (existing.appliedAt !== undefined) return { duplicate: true, matched: true };
    }
    const now = Date.now();
    const providerEventId = existing?._id ?? await ctx.db.insert("participantNotificationProviderEvents", {
      provider: "cloudflare_email",
      eventId: args.eventId,
      providerMessageId: args.providerMessageId,
      recipientEmailNormalized: args.recipientEmailNormalized,
      eventType: args.eventType,
      providerAt: args.providerAt,
      disableDestination: args.disableDestination,
      ...(args.providerErrorCode !== undefined
        ? { providerErrorCode: args.providerErrorCode }
        : {}),
      payloadHash: args.payloadHash,
      receivedAt: now,
    });
    const delivery = await ctx.db
      .query("participantNotificationDeliveries")
      .withIndex("by_provider_message", (index) =>
        index.eq("providerMessageId", args.providerMessageId),
      )
      .unique();
    if (!delivery) {
      return { duplicate: existing !== null, matched: false };
    }
    const providerEvent = await ctx.db.get(providerEventId);
    if (!providerEvent) throw new Error("Participant email event did not persist.");
    const matched = await applyProviderEvent(ctx, providerEvent, delivery);
    return { duplicate: existing !== null, matched };
  },
});
