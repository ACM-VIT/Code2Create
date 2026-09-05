import { ConvexError } from "convex/values";
import { getAll } from "convex-helpers/server/relationships";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/** Timing for an offer, including a previously saved schedule applied by a queued job. */
export function validateAdmissionOfferTiming(
  event: Doc<"events">,
  closesAt: number,
  reminderAt: number | undefined,
  now: number,
) {
  const latest = Math.min(event.startsAt ?? Infinity, now + 30 * 24 * 60 * 60 * 1_000);
  if (!Number.isSafeInteger(closesAt) || closesAt <= now || closesAt > latest) {
    throw new ConvexError({ code: "INVALID_OFFER_EXPIRY", message: "RSVP must close in the future, no later than the event start or 30 days from now." });
  }
  if (reminderAt !== undefined && (!Number.isSafeInteger(reminderAt) || reminderAt >= closesAt)) {
    throw new ConvexError({ code: "INVALID_RSVP_REMINDER", message: "Reminder calls must start before RSVP closes." });
  }
}

/** A newly submitted schedule must never turn an elapsed timestamp into an immediate call. */
export function validateAdmissionRsvpSchedule(
  event: Doc<"events">,
  closesAt: number,
  reminderAt: number | undefined,
  now: number,
) {
  validateAdmissionOfferTiming(event, closesAt, reminderAt, now);
  if (reminderAt !== undefined && reminderAt <= now) {
    throw new ConvexError({ code: "INVALID_RSVP_REMINDER", message: "Reminder calls must start in the future, before RSVP closes." });
  }
}

/** Validate the selected roster before publishing invitations; each offer reserves atomically too. */
export async function requireAdmissionRsvpCapacity(ctx: MutationCtx, applications: Doc<"applications">[]) {
  const projects = await getAll(ctx.db, "projectVersions", applications.map(a => a.submittedProjectVersionId));
  const demand = new Map<Id<"admissionPolicyVersions">, number>();
  for (const [index, application] of applications.entries()) {
    const project = projects[index];
    if (!project) throw new Error("A selected team's locked roster is missing.");
    demand.set(application.admissionPolicyVersionId, (demand.get(application.admissionPolicyVersionId) ?? 0) + project.lockedMemberCount);
  }
  for (const [policyId, count] of demand) {
    const bucket = await ctx.db.query("admissionCapacityBuckets")
      .withIndex("by_policy", q => q.eq("admissionPolicyVersionId", policyId)).unique();
    if (!bucket || bucket.reserved + count > bucket.capacity) {
      throw new ConvexError({ code: "ADMISSION_CAPACITY_FULL", message: "The selected teams exceed available participant capacity. Update the admission capacity before opening RSVP." });
    }
  }
}

/** Account for every selected roster as well as places already reserved by offers. */
export async function requireSelectedAdmissionCapacity(ctx: MutationCtx, eventId: Id<"events">) {
  const selected = await ctx.db.query("applications")
    .withIndex("by_event_state_submitted", q => q.eq("eventId", eventId).eq("state", "accepted")).take(2001);
  if (selected.length > 2000) throw new ConvexError({ code: "RSVP_BATCH_TOO_LARGE", message: "The selected cohort exceeds the supported event size." });
  await requireAdmissionRsvpCapacity(ctx, selected);
}
