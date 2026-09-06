import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { enqueueOutboundCall, normalizedE164Phone } from "./outboundCalls";
import { outingWindow } from "./participantServiceQueue";

export function outingCall(ctx: QueryCtx | MutationCtx, entry: Doc<"participantServiceQueueEntries">) {
  return ctx.db.query("outboundCallDeliveries")
    .withIndex("by_source", (q) => q.eq("eventId", entry.eventId)
      .eq("sourceType", "participant_outing").eq("sourceId", entry._id)
      .eq("purpose", "participant_event_update"))
    .unique();
}

async function currentOverdueOuting(ctx: MutationCtx, entryId: Id<"participantServiceQueueEntries">, now: number) {
  const entry = await ctx.db.get(entryId);
  if (!entry || entry.phase.status !== "overdue" || entry.phase.returnBy > now) return null;
  const phase = entry.phase;
  const departures = await ctx.db.query("attendancePresenceEvents")
    .withIndex("by_membership_time", (q) => q.eq("membershipId", entry.membershipId).eq("receivedAt", phase.departedAt))
    .collect();
  if (!departures.some((scan) => scan.eventId === entry.eventId && scan.sourceKind === "scanner" &&
    scan.outcome === "accepted" && scan.movementReason === "short_break" &&
    scan.transition === (phase.returnTransition === "venue_entry" ? "venue_exit" : "zone_exit") &&
    scan.sessionId === phase.sessionId && scan.outing?.status === "out" && scan.outing.returnBy === phase.returnBy)) return null;
  const [event, membership, person] = await Promise.all([
    ctx.db.get(entry.eventId), ctx.db.get(entry.membershipId), ctx.db.get(entry.personId),
  ]);
  if (!event || person?.status !== "active" || !membership ||
      membership.eventId !== entry.eventId || membership.personId !== entry.personId ||
      membership.onboardingStatus !== "accepted" || membership.eligibilityStatus !== "eligible") return null;
  const window = await outingWindow(ctx, event);
  if (!window || now < window.opensAt || now >= window.closesAt) return null;
  const profile = await ctx.db.query("participantProfiles")
    .withIndex("by_membership", (q) => q.eq("membershipId", entry.membershipId)).unique();
  return { entry, profile };
}

/** The accepted exit scan authorizes this automatic reminder for its own outing.
 * It has no manual caller or arbitrary recipient. A return deletes the source.
 */
export async function enqueueOverdueOutingCall(ctx: MutationCtx, entryId: Id<"participantServiceQueueEntries">, now: number) {
  const current = await currentOverdueOuting(ctx, entryId, now);
  if (!current) return;
  const { entry, profile } = current;
  await enqueueOutboundCall(ctx, {
    eventId: entry.eventId,
    targetPersonId: entry.personId,
    sourceType: "participant_outing",
    sourceId: entry._id,
    purpose: "participant_event_update",
    ...(profile ? { destinationPhone: profile.phone } : {}),
    script: "You have exceeded your 15-minute Code2Create break, and other people are waiting for their turn. Can you please come back now?",
    locale: "en-IN",
    scriptPolicyVersion: "participant-outing-return-v2",
    authorizationGrantIds: [],
    now,
  });
}

export async function outingCallBlockedReason(ctx: MutationCtx, delivery: Doc<"outboundCallDeliveries">, now: number) {
  if (delivery.purpose !== "participant_event_update") return "participant_call_source_invalid";
  const entryId = ctx.db.normalizeId("participantServiceQueueEntries", delivery.sourceId);
  const current = entryId ? await currentOverdueOuting(ctx, entryId, now) : null;
  if (!current || current.entry.eventId !== delivery.eventId || current.entry.personId !== delivery.targetPersonId) {
    return "outing_no_longer_overdue";
  }
  return normalizedE164Phone(current.profile?.phone) === delivery.destinationPhoneE164
    ? null : "participant_phone_changed";
}
