import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireRegistrationOpen } from "./events";
import { normalizeEmail } from "./strings";

/** A deadline exception for one previously imported identity, never general registration. */
export async function approvedRosterRecovery(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
  email: string,
  registrationNumber: string | undefined,
  now: number,
) {
  if (!registrationNumber || event.status !== "registration_closed") {
    return null;
  }
  const recovery = await ctx.db.query("participantRosterRecoveries")
    .withIndex("by_event_email", q => q.eq("eventId", event._id).eq("emailNormalized", normalizeEmail(email)))
    .unique();
  if (!recovery || recovery.status !== "approved" || now >= recovery.expiresAt ||
      recovery.vitRegistrationNumber !== registrationNumber) return null;
  const deadline = recovery.lateJoin ? event.endsAt : event.startsAt;
  if (deadline === undefined || now >= deadline || recovery.expiresAt > deadline) return null;
  const [entry, team] = await Promise.all([
    ctx.db.get(recovery.rosterEntryId), ctx.db.get(recovery.teamId),
  ]);
  if (!entry || !team || entry.eventId !== event._id || team.eventId !== event._id ||
      entry.status !== "pending" || entry.role !== "member" || entry.teamName !== team.name ||
      entry.vitRegistrationNumber !== registrationNumber ||
      (entry.emailNormalized !== undefined && entry.emailNormalized !== recovery.emailNormalized) ||
      (!recovery.lateJoin && entry.createdAt >= event.applicationsCloseAt) || !team.membershipLocked) return null;
  const application = await ctx.db.query("applications")
    .withIndex("by_team", q => q.eq("teamId", team._id)).unique();
  if (!application ||
      application.humanDecision !== "accept" || application.decisionStage !== "released") return null;
  if (recovery.lateJoin) {
    if (application.state !== "confirmed" ||
        !["confirmed", "checked_in", "active"].includes(team.status)) return null;
  } else if (team.status !== "admitted" || application.state !== "accepted" ||
      application.currentOfferId !== undefined) return null;
  return { recovery, entry, team, application };
}

export async function requireParticipantOnboardingOpen(
  ctx: MutationCtx,
  event: Doc<"events">,
  person: Pick<Doc<"people">, "verifiedEmail">,
  membership: Pick<Doc<"eventMemberships">, "participantClass" | "vitStudentIdentity">,
) {
  const now = Date.now();
  if (membership.participantClass === "vit_student") {
    const approved = await approvedRosterRecovery(ctx, event, person.verifiedEmail,
      membership.vitStudentIdentity?.registrationNumber, now);
    if (approved) return approved;
  }
  requireRegistrationOpen(event, membership.participantClass, now);
  return null;
}

export function recoveryUnavailable(): never {
  throw new ConvexError({ code: "ROSTER_RECOVERY_UNAVAILABLE",
    message: "This roster recovery is no longer available. Ask the event team to check your assignment." });
}
