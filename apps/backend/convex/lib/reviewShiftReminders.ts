import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  reviewerCallConsentPolicyVersion,
  reviewerCallScriptPolicyVersion,
} from "@code2create/domain";
import { enqueueOutboundCall } from "./outboundCalls";
import { matchingPermissionGrantIds } from "./permissions";

export async function currentShiftReminder(
  ctx: MutationCtx,
  confirmation: Doc<"reviewerRoundConfirmations">,
  round: Doc<"reviewRounds">,
  expectedVersion: number,
  shiftStartsAt: number,
  now: number,
) {
  if (
    confirmation.status !== "confirmed" ||
    confirmation.version !== expectedVersion ||
    confirmation.roundId !== round._id ||
    !confirmation.windows.some((window) => window.startsAt === shiftStartsAt) ||
    !["published", "open"].includes(round.status) ||
    round.staffing.assignmentReminderSeconds === 0 ||
    now >= shiftStartsAt ||
    now >= round.endsAt
  )
    return null;
  const [clockIn, subject] = await Promise.all([
    ctx.db
      .query("reviewerClockIns")
      .withIndex("by_round_person", (q) =>
        q
          .eq("roundId", round._id)
          .eq("reviewerPersonId", confirmation.personId),
      )
      .unique(),
    ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", round.eventId).eq("personId", confirmation.personId),
      )
      .unique(),
  ]);
  if (clockIn?.status === "present" || !subject || subject.status !== "active")
    return null;
  const grantIds = await matchingPermissionGrantIds(ctx, {
    eventId: round.eventId,
    eventAccessSubjectId: subject._id,
    permissionKey: "reviewer.clock_in",
    scopeType: "round",
    scopeId: round._id,
  });
  return grantIds.length > 0
    ? {
        remindAt:
          shiftStartsAt - round.staffing.assignmentReminderSeconds * 1000,
        grantIds,
      }
    : null;
}

export async function enqueueShiftReminderCall(
  ctx: MutationCtx,
  args: {
    notificationId: Id<"reviewConfirmationNotifications">;
    confirmation: Doc<"reviewerRoundConfirmations">;
    round: Doc<"reviewRounds">;
    shiftStartsAt: number;
    grantIds: Id<"permissionGrants">[];
    now: number;
  },
) {
  if (!args.round.staffing.assignmentReminderCalls) return;
  // The existing reviewer call setting now explicitly covers both kinds of duty call.
  const consent = await ctx.db
    .query("outboundCallConsents")
    .withIndex("by_event_person_purpose", (q) =>
      q
        .eq("eventId", args.round.eventId)
        .eq("personId", args.confirmation.personId)
        .eq("purpose", "reviewer_substitute_page"),
    )
    .unique();
  if (
    consent?.state !== "granted" ||
    consent.consentPolicyVersion !== reviewerCallConsentPolicyVersion ||
    consent.scriptPolicyVersion !== reviewerCallScriptPolicyVersion ||
    !consent.destinationPhoneE164
  )
    return;
  const startsAt = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
  }).format(args.shiftStartsAt);
  const script = `Code2Create reminder: your confirmed review duty for ${args.round.name} starts at ${startsAt} India time. Please open the reviewer app and clock in when you arrive.`;
  const deliveryId = await enqueueOutboundCall(ctx, {
    eventId: args.round.eventId,
    targetPersonId: args.confirmation.personId,
    sourceType: "reviewer_shift_reminder",
    sourceId: args.notificationId,
    shiftReminder: {
      confirmationVersion: args.confirmation.version,
      shiftStartsAt: args.shiftStartsAt,
    },
    purpose: "reviewer_shift_reminder",
    destinationPhone: consent.destinationPhoneE164,
    script,
    locale: "en-IN",
    scriptPolicyVersion: reviewerCallScriptPolicyVersion,
    consent: { id: consent._id, version: consent.version },
    authorizationGrantIds: args.grantIds,
    now: args.now,
  });
  const delivery = await ctx.db.get(deliveryId);
  // A never-dispatched reminder can follow corrected hours/consent. Once an
  // attempt reached dispatch, its identity and snapshot must remain unchanged.
  if (
    delivery?.attemptCount === 0 &&
    ["pending", "cancelled"].includes(delivery.state)
  ) {
    await ctx.db.patch(deliveryId, {
      state: "pending",
      shiftReminder: {
        confirmationVersion: args.confirmation.version,
        shiftStartsAt: args.shiftStartsAt,
      },
      destinationPhoneE164: consent.destinationPhoneE164,
      consentId: consent._id,
      consentVersion: consent.version,
      authorizationGrantIds: args.grantIds,
      scriptPolicyVersion: reviewerCallScriptPolicyVersion,
      script,
      providerErrorCode: undefined,
      completedAt: undefined,
      version: delivery.version + 1,
      updatedAt: args.now,
    });
    if (delivery.state === "cancelled")
      await ctx.scheduler.runAfter(0, internal.outboundCalls.deliver, {
        deliveryId,
      });
  }
}
