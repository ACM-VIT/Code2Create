import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { loadPublishedCommunicationsPolicy } from "./lib/communicationsPolicy";
import { requireEventBySlug } from "./lib/events";
import { currentTeamForMembership } from "./lib/floor";
import { requireCurrentPerson, requireEventSubject, requireMembership } from "./lib/identity";
import { requirePermission } from "./lib/permissions";

const acceptedTeamCommunications = v.object({
  policyVersionId: v.id("communicationsPolicyVersions"),
  policyVersion: v.number(),
  venueName: v.string(),
  venueAddress: v.optional(v.string()),
  venueMapUrl: v.optional(v.string()),
  startsAt: v.number(),
  endsAt: v.number(),
  nextSteps: v.array(
    v.object({
      stableKey: v.string(),
      title: v.string(),
      detail: v.string(),
      actionUrl: v.optional(v.string()),
      dueAt: v.optional(v.number()),
    }),
  ),
  discordUrl: v.string(),
  discordLabel: v.string(),
});

const visibleApplicationStates = new Set(["accepted", "offer_sent", "confirmed"]);

export async function acceptedTeamCommunicationsForTeam(
  ctx: QueryCtx,
  event: Doc<"events">,
  teamId: Id<"teams">,
) {
  const application = await ctx.db
    .query("applications")
    .withIndex("by_team", (index) => index.eq("teamId", teamId))
    .unique();
  const acceptedByReleasedResults = Boolean(
    application &&
    event.admissionResultsReleasedAt !== undefined &&
    (application.decisionStage === "recorded" || application.decisionStage === "released") &&
    application.humanDecision === "accept",
  );
  if (
    !application ||
    (!visibleApplicationStates.has(application.state) && !acceptedByReleasedResults)
  )
    return null;
  const { policy, normalized } = await loadPublishedCommunicationsPolicy(ctx, event);
  return {
    policyVersionId: policy._id,
    policyVersion: policy.version,
    venueName: normalized.venueName,
    ...(normalized.venueAddress !== undefined ? { venueAddress: normalized.venueAddress } : {}),
    ...(normalized.venueMapUrl !== undefined ? { venueMapUrl: normalized.venueMapUrl } : {}),
    startsAt: normalized.startsAt,
    endsAt: normalized.endsAt,
    nextSteps: normalized.nextSteps,
    discordUrl: normalized.discordUrl,
    discordLabel: normalized.discordLabel,
  };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.union(v.null(), acceptedTeamCommunications),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const teamContext = await currentTeamForMembership(ctx, event._id, membership._id);
    if (!teamContext) return null;
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.read",
      scopeType: "team",
      scopeId: teamContext.team._id,
    });
    return acceptedTeamCommunicationsForTeam(ctx, event, teamContext.team._id);
  },
});
