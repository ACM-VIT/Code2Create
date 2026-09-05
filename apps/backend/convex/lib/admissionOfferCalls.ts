import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { matchingPermissionGrantIds } from "./permissions";

export const admissionRsvpCallScriptPolicyVersion = "admission-rsvp-reminder-v1";

/** The source of a reminder must still be the lead's current, unanswered offer. */
export async function currentAdmissionRsvpReminder(
  ctx: MutationCtx,
  offerId: Id<"admissionOffers">,
  now: number,
) {
  const offer = await ctx.db.get(offerId);
  if (
    !offer ||
    offer.state !== "offered" ||
    offer.reminderAt === undefined ||
    now >= offer.expiresAt
  ) {
    return null;
  }

  const [application, team, event, sender] = await Promise.all([
    ctx.db.get(offer.applicationId),
    ctx.db.get(offer.teamId),
    ctx.db.get(offer.eventId),
    ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", offer.eventId).eq("personId", offer.createdByPersonId),
      )
      .unique(),
  ]);
  if (
    !application ||
    application.eventId !== offer.eventId ||
    application.teamId !== offer.teamId ||
    application.currentOfferId !== offer._id ||
    application.state !== "offer_sent" ||
    !team ||
    team.eventId !== offer.eventId ||
    team.lockedProjectVersionId !== application.submittedProjectVersionId ||
    !event ||
    event.status === "complete" ||
    !sender ||
    sender.status !== "active"
  ) {
    return null;
  }

  const project = await ctx.db.get(application.submittedProjectVersionId);
  if (
    !project ||
    project.lockedRosterSnapshotId !== offer.lockedRosterSnapshotId ||
    project.lockedLeadMembershipId !== team.leadMembershipId
  ) {
    return null;
  }
  const leader = await ctx.db.get(project.lockedLeadMembershipId);
  if (!leader || leader.eventId !== offer.eventId || leader.eligibilityStatus !== "eligible" || leader.participantClass !== "vit_student") {
    return null;
  }
  const [person, subject, activeGrants] = await Promise.all([
    ctx.db.get(leader.personId),
    ctx.db.get(leader.eventAccessSubjectId),
    matchingPermissionGrantIds(ctx, {
      eventId: offer.eventId,
      eventAccessSubjectId: sender._id,
      permissionKey: "application.offer.manage",
      scopeType: "application",
      scopeId: application._id,
    }),
  ]);
  const grantIds = activeGrants.filter((id) => offer.createdByGrantIds.includes(id));
  if (!person || person.status !== "active" || subject?.status !== "active" || !grantIds.length) {
    return null;
  }
  return { offer, team, event, leader, grantIds };
}

export function admissionRsvpCallScript(teamName: string, expiresAt: number, timezone: string) {
  const deadline = new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(expiresAt);
  return `This is Code2Create's automated RSVP reminder for ${teamName}. Your team's offer is still waiting for a response. Please open the participant portal from your offer email and confirm or decline for your whole team by ${deadline}.`;
}
