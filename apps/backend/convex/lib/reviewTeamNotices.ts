import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { matchingPermissionGrantIds } from "./permissions";
import { enqueueOutboundCall, normalizedE164Phone } from "./outboundCalls";

export async function notifyReviewTeam(
  ctx: MutationCtx,
  state: Doc<"teamRoundStates">,
  kind: "up_next" | "called",
  now: number,
) {
  if (!state.panelId) throw new Error("A review notice requires a panel.");
  const prior = await ctx.db
    .query("reviewTeamNotices")
    .withIndex("by_state_version_kind", (q) =>
      q
        .eq("teamRoundStateId", state._id)
        .eq("queueVersion", state.version)
        .eq("kind", kind),
    )
    .unique();
  if (prior) return prior._id;
  const [round, panel, team, policy] = await Promise.all([
    ctx.db.get(state.roundId),
    ctx.db.get(state.panelId),
    ctx.db.get(state.teamId),
    ctx.db
      .query("reviewQueuePolicies")
      .withIndex("by_round", (q) => q.eq("roundId", state.roundId))
      .unique(),
  ]);
  if (!round || !panel || !team)
    throw new Error("Review notice context is missing.");
  const message =
    kind === "up_next"
      ? `Your team is next at ${panel.name} for ${round.name}. Gather your team nearby and watch this dashboard for the call.`
      : `Your review at ${panel.name} for ${round.name} is ready. Bring your team and show the team review code.`;
  const noticeId = await ctx.db.insert("reviewTeamNotices", {
    eventId: state.eventId,
    roundId: round._id,
    panelId: panel._id,
    teamId: team._id,
    teamRoundStateId: state._id,
    queueVersion: state.version,
    kind,
    message,
    createdAt: now,
  });
  if (!policy?.voiceCalls) return noticeId;
  const [leader, operator] = await Promise.all([
    ctx.db.get(team.leadMembershipId),
    ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", state.eventId).eq("personId", policy.operatorPersonId),
      )
      .unique(),
  ]);
  if (!leader || !operator || operator.status !== "active") return noticeId;
  const grants = await matchingPermissionGrantIds(ctx, {
    eventId: state.eventId,
    eventAccessSubjectId: operator._id,
    permissionKey: "communications.delivery.manage",
    scopeType: "event",
  });
  if (!grants.length) return noticeId;
  const profile = await ctx.db
    .query("participantProfiles")
    .withIndex("by_membership", (q) => q.eq("membershipId", leader._id))
    .unique();
  const phone = normalizedE164Phone(profile?.phone);
  if (phone === null) return noticeId;
  await enqueueOutboundCall(ctx, {
    eventId: state.eventId,
    targetPersonId: leader.personId,
    sourceType: "review_team_notice",
    sourceId: noticeId,
    purpose: "participant_event_update",
    destinationPhone: phone,
    script: `Code2Create review update. ${message}`.slice(0, 600),
    locale: "en-IN",
    scriptPolicyVersion: "team-review-call-up-v1",
    authorizationGrantIds: grants,
    now,
  });
  return noticeId;
}
