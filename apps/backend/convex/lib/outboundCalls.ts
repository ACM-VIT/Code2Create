import type { VenueConfirmationCall } from "@code2create/domain";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const e164Pattern = /^\+[1-9]\d{7,14}$/u;

export function normalizedE164Phone(value: string | undefined) {
  if (value === undefined) return null;
  const normalized = value.trim().replace(/[\s().-]/gu, "");
  return e164Pattern.test(normalized) ? normalized : null;
}

export function reviewerPageCallScript(args: {
  roundName: string;
  responseWindowSeconds: number;
}) {
  return [
    `Code2Create needs you as a substitute reviewer for ${args.roundName}.`,
    `Open the reviewer app now and accept or decline within ${args.responseWindowSeconds} seconds.`,
  ].join(" ");
}

export async function enqueueOutboundCall(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    targetPersonId: Id<"people">;
    sourceType:
      | "reviewer_page"
      | "participant_notification"
      | "review_team_notice"
      | "reviewer_venue_departure";
    sourceId: string;
    purpose:
      | "reviewer_substitute_page"
      | "participant_event_update"
      | "reviewer_venue_absence";
    destinationPhone?: string;
    script: string;
    venueConfirmation?: VenueConfirmationCall;
    locale: string;
    scriptPolicyVersion: string;
    consent?: {
      id: Id<"outboundCallConsents">;
      version: number;
    };
    authorizationGrantIds: Id<"permissionGrants">[];
    now: number;
  },
) {
  if (args.script.length < 8 || args.script.length > 600) {
    throw new Error("An outbound call script must contain 8–600 characters.");
  }
  const existing = await ctx.db
    .query("outboundCallDeliveries")
    .withIndex("by_source", (index) =>
      index
        .eq("eventId", args.eventId)
        .eq("sourceType", args.sourceType)
        .eq("sourceId", args.sourceId)
        .eq("purpose", args.purpose),
    )
    .unique();
  if (existing) return existing._id;

  const destinationPhoneE164 = normalizedE164Phone(args.destinationPhone);
  const deliveryId = await ctx.db.insert("outboundCallDeliveries", {
    eventId: args.eventId,
    targetPersonId: args.targetPersonId,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    purpose: args.purpose,
    ...(destinationPhoneE164 !== null ? { destinationPhoneE164 } : {}),
    script: args.script,
    ...(args.venueConfirmation
      ? { venueConfirmation: args.venueConfirmation }
      : {}),
    locale: args.locale,
    scriptPolicyVersion: args.scriptPolicyVersion,
    ...(args.consent !== undefined
      ? { consentId: args.consent.id, consentVersion: args.consent.version }
      : {}),
    authorizationGrantIds: args.authorizationGrantIds,
    state: destinationPhoneE164 === null ? "unavailable" : "pending",
    attemptCount: 0,
    ...(destinationPhoneE164 === null
      ? {
          providerErrorCode:
            args.destinationPhone === undefined ? "call_consent_not_granted" : "phone_not_e164",
          completedAt: args.now,
        }
      : {}),
    version: 1,
    createdAt: args.now,
    updatedAt: args.now,
  });
  if (destinationPhoneE164 !== null) {
    await ctx.scheduler.runAfter(0, internal.outboundCalls.deliver, { deliveryId,
    });
  }
  return deliveryId;
}
