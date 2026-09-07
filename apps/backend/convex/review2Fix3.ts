import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { insertTeamRoundState, patchTeamRoundState } from "./lib/reviewQueueProjection";
import { ensureRoundConfirmation } from "./lib/reviewRoster";
import { advanceAccessVersion } from "./lib/accessVersion";
import { revokeSourceGrants } from "./lib/permissions";
import { initializeAttendanceTeamAvailability } from "./lib/attendanceTeamAvailability";

/** One-off Review 2 adjustments on 2026-09-08 (scale, fixed questions, queue balance); delete after use. */

async function requireActor(ctx: MutationCtx, eventId: Id<"events">, email: string) {
  const subject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_email", (q) => q.eq("eventId", eventId).eq("emailNormalized", email))
    .first();
  if (!subject) throw new Error(`No event subject for ${email}.`);
  return subject.personId;
}

/** Moves a round's rubric to a new score range; refuses once any scorecard exists for it. */
export const setScale = internalMutation({
  args: { roundId: v.id("reviewRounds"), minimum: v.number(), maximum: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const rubric = await ctx.db.get(round.rubricVersionId);
    if (!rubric) throw new Error("The rubric is missing.");
    const session = await ctx.db
      .query("reviewSessions")
      .withIndex("by_round_status_updated", (q) => q.eq("roundId", round._id))
      .first();
    if (session) throw new Error("Scores may already exist for this round; the scale stays as it is.");
    if (!Number.isInteger(args.minimum) || !Number.isInteger(args.maximum) || args.minimum >= args.maximum) {
      throw new Error("Choose whole-number bounds with the minimum below the maximum.");
    }
    const previous = { minimum: rubric.scoreMinimum, maximum: rubric.scoreMaximum };
    await ctx.db.patch(rubric._id, { scoreMinimum: args.minimum, scoreMaximum: args.maximum });
    return { rubric: rubric.name, previous, now: { minimum: args.minimum, maximum: args.maximum } };
  },
});

/** Turns off generated questions for a round so every session gets the fixed rubric questions. */
export const disableGeneratedQuestions = internalMutation({
  args: { roundId: v.id("reviewRounds") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("reviewQuestionPolicies")
      .withIndex("by_round", (q) => q.eq("roundId", args.roundId))
      .unique();
    if (!config) return { changed: false, reason: "no policy row; generation was already off" };
    if (!config.policy.enabled) return { changed: false, reason: "already off" };
    await ctx.db.patch(config._id, {
      policy: { ...config.policy, enabled: false },
      version: config.version + 1,
      updatedAt: Date.now(),
    });
    return { changed: true, version: config.version + 1 };
  },
});

/** Evens out queued teams across a round's panels, moving from the back of the longer queues. */
export const rebalanceQueue = internalMutation({
  args: { roundId: v.id("reviewRounds"), actorEmail: v.string(), dryRun: v.boolean() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const actorPersonId = await requireActor(ctx, round.eventId, args.actorEmail);
    const panels = (
      await ctx.db
        .query("reviewPanels")
        .filter((q) => q.eq(q.field("roundId"), round._id))
        .collect()
    )
      .filter((panel) => panel.status !== "closed")
      .sort((a, b) => a.stableKey.localeCompare(b.stableKey, undefined, { numeric: true }));
    const queued = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_state_priority_queued", (q) => q.eq("roundId", round._id).eq("state", "queued"))
      .collect();
    const byPanel = new Map(panels.map((panel) => [panel._id, queued.filter((s) => s.panelId === panel._id).sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))]));
    const total = queued.length;
    const base = Math.floor(total / panels.length);
    const extra = total % panels.length;
    const target = new Map(panels.map((panel, index) => [panel._id, base + (index < extra ? 1 : 0)]));
    const moves: { team: Id<"teams">; from: string; to: string }[] = [];
    const donors = panels.filter((panel) => (byPanel.get(panel._id)?.length ?? 0) > (target.get(panel._id) ?? 0));
    const receivers = panels.filter((panel) => (byPanel.get(panel._id)?.length ?? 0) < (target.get(panel._id) ?? 0));
    let sequence = 0;
    for (const receiver of receivers) {
      while ((byPanel.get(receiver._id)?.length ?? 0) < (target.get(receiver._id) ?? 0)) {
        const donor = donors.find((panel) => (byPanel.get(panel._id)?.length ?? 0) > (target.get(panel._id) ?? 0));
        if (!donor) break;
        const state = byPanel.get(donor._id)?.pop();
        if (!state) break;
        byPanel.get(receiver._id)?.push(state);
        moves.push({ team: state.teamId, from: donor.name, to: receiver.name });
        if (!args.dryRun) {
          await patchTeamRoundState(ctx, state, {
            panelId: receiver._id,
            queuedAt: now + sequence,
            movedFromPanelId: donor._id,
            lastMovedAt: now,
            version: state.version + 1,
            updatedByPersonId: actorPersonId,
            updatedAt: now,
          });
        }
        sequence += 1;
      }
    }
    return {
      applied: !args.dryRun,
      total,
      moves: moves.length,
      perPanel: Object.fromEntries(panels.map((panel) => [panel.name, byPanel.get(panel._id)?.length ?? 0])),
    };
  },
});

/**
 * A round that ran outside the system cannot publish elimination decisions
 * (there is no close snapshot). Marking it all-advance lifts it out of the
 * later round's progression gate; the desk's queue already decides who is reviewed.
 */
export const allAdvanceProgression = internalMutation({
  args: { roundId: v.id("reviewRounds"), reason: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const policy = await ctx.db
      .query("reviewProgressions")
      .withIndex("by_event_round", (q) => q.eq("eventId", round.eventId).eq("roundId", round._id))
      .unique();
    if (!policy) throw new Error("The round has no progression policy.");
    if (policy.mode === "all_advance") return { changed: false, mode: policy.mode };
    await ctx.db.patch(policy._id, {
      mode: "all_advance",
      version: policy.version + 1,
      updatedAt: Date.now(),
      reason: args.reason,
    });
    return { changed: true, previous: policy.mode, version: policy.version + 1 };
  },
});

/** Queues one team on a named panel, at the back of that panel's queue. */
export const enqueueTeam = internalMutation({
  args: {
    roundId: v.id("reviewRounds"),
    teamCode: v.string(),
    panelStableKey: v.string(),
    actorEmail: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const actorPersonId = await requireActor(ctx, round.eventId, args.actorEmail);
    const team = await ctx.db
      .query("teams")
      .withIndex("by_event_code", (q) => q.eq("eventId", round.eventId).eq("publicCode", args.teamCode.trim().toUpperCase()))
      .unique();
    if (!team) throw new Error("The team does not exist.");
    const panel = (
      await ctx.db
        .query("reviewPanels")
        .filter((q) => q.eq(q.field("roundId"), round._id))
        .collect()
    ).find((row) => row.stableKey === args.panelStableKey);
    if (!panel) throw new Error("The panel does not exist.");
    const state = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_team", (q) => q.eq("roundId", round._id).eq("teamId", team._id))
      .unique();
    if (state && !["unassigned", "skipped", "withdrawn"].includes(state.state)) {
      return { changed: false, team: team.name, state: state.state, panelId: state.panelId };
    }
    const fields = {
      panelId: panel._id,
      state: "queued" as const,
      queuedAt: now,
      callAttemptCount: 0,
      updatedByPersonId: actorPersonId,
      updatedAt: now,
    };
    if (state) {
      await patchTeamRoundState(ctx, state, {
        ...fields,
        skipReason: undefined,
        calledAt: undefined,
        lastCallAttemptAt: undefined,
        holdReason: undefined,
        stateBeforeHold: undefined,
        heldAt: undefined,
        missedAt: undefined,
        version: state.version + 1,
      });
    } else {
      await insertTeamRoundState(ctx, { eventId: round.eventId, roundId: round._id, teamId: team._id, priority: 0, version: 1, ...fields });
    }
    return { changed: true, team: team.name, panel: panel.name, previous: state?.state ?? null };
  },
});

/** Makes a listed team callable: competitor category and a confirmed status. */
export const makeReviewable = internalMutation({
  args: { teamCodes: v.array(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const events = await ctx.db.query("events").take(2);
    const event = events[0];
    if (!event || events.length !== 1) throw new Error("Expected exactly one event.");
    const changed: { team: string; from: string; category: string }[] = [];
    const missing: string[] = [];
    for (const raw of args.teamCodes) {
      const code = raw.trim().toUpperCase();
      const team = await ctx.db
        .query("teams")
        .withIndex("by_event_code", (q) => q.eq("eventId", event._id).eq("publicCode", code))
        .unique();
      if (!team) {
        missing.push(code);
        continue;
      }
      const status = ["confirmed", "checked_in", "active"].includes(team.status) ? team.status : "confirmed";
      // Competitor is the absence of a category; "oc" is the only stored value.
      await ctx.db.patch(team._id, {
        competitionCategory: undefined,
        status,
        version: team.version + 1,
        updatedAt: now,
      });
      changed.push({ team: team.name, from: `${team.status}/${team.competitionCategory ?? "competitor"}`, category: "competitor" });
    }
    return { changed, missing };
  },
});

/** Removes listed teams from the queue (withdrawn teams as withdrawn, others as skipped). */
export const dequeueTeams = internalMutation({
  args: { roundId: v.id("reviewRounds"), actorEmail: v.string(), teamCodes: v.array(v.string()), reason: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const actorPersonId = await requireActor(ctx, round.eventId, args.actorEmail);
    const result: { code: string; team: string; to: string }[] = [];
    const missing: string[] = [];
    for (const raw of args.teamCodes) {
      const code = raw.trim().toUpperCase();
      const team = await ctx.db
        .query("teams")
        .withIndex("by_event_code", (q) => q.eq("eventId", round.eventId).eq("publicCode", code))
        .unique();
      const state = team
        ? await ctx.db
            .query("teamRoundStates")
            .withIndex("by_round_team", (q) => q.eq("roundId", round._id).eq("teamId", team._id))
            .unique()
        : null;
      if (!team || !state || state.state !== "queued") {
        missing.push(code);
        continue;
      }
      const to = team.status === "withdrawn" ? ("withdrawn" as const) : ("skipped" as const);
      await patchTeamRoundState(ctx, state, {
        state: to,
        ...(to === "skipped" ? { skipReason: args.reason } : {}),
        panelId: undefined,
        queuedAt: undefined,
        calledAt: undefined,
        callAttemptCount: 0,
        lastCallAttemptAt: undefined,
        holdReason: undefined,
        stateBeforeHold: undefined,
        heldAt: undefined,
        missedAt: undefined,
        version: state.version + 1,
        updatedByPersonId: actorPersonId,
        updatedAt: now,
      });
      result.push({ code, team: team.name, to });
    }
    return { changed: result.length, result, missing };
  },
});

/** Every seated reviewer gets a confirmed window covering the whole round; rerun after desk swaps. */
export const confirmSeatedReviewers = internalMutation({
  args: { roundId: v.id("reviewRounds") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const members = (
      await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_round_person_status", (q) => q.eq("roundId", round._id))
        .collect()
    ).filter((member) => member.status === "active");
    const window = { startsAt: round.startsAt, endsAt: round.endsAt };
    const fixed: string[] = [];
    for (const member of members) {
      await ensureRoundConfirmation(ctx, round, member.personId, now);
      const confirmation = await ctx.db
        .query("reviewerRoundConfirmations")
        .withIndex("by_roundId_and_personId", (q) => q.eq("roundId", round._id).eq("personId", member.personId))
        .unique();
      if (!confirmation) continue;
      const covers =
        confirmation.status === "confirmed" &&
        confirmation.windows.some((w) => w.startsAt <= window.startsAt && w.endsAt >= window.endsAt);
      if (covers) continue;
      await ctx.db.patch(confirmation._id, {
        status: "confirmed",
        windows: [window],
        respondedAt: now,
        version: confirmation.version + 1,
        updatedAt: now,
      });
      fixed.push(member.personId);
    }
    return { seats: members.length, fixed: fixed.length, personIds: fixed };
  },
});

/**
 * A reserve who took a seat keeps only panel grants; the seeding left their
 * reserve grants active, which blocks returning them to the pool later.
 */
export const revokeAssignedReserveGrants = internalMutation({
  args: { roundId: v.id("reviewRounds"), actorEmail: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    const actorPersonId = await requireActor(ctx, round.eventId, args.actorEmail);
    const reserves = await ctx.db
      .query("reviewRoundReserves")
      .withIndex("by_round_person", (q) => q.eq("roundId", round._id))
      .take(600);
    let revoked = 0;
    for (const reserve of reserves) {
      if (reserve.status !== "assigned") continue;
      await revokeSourceGrants(ctx, {
        eventId: round.eventId,
        sourceType: "reserve_assignment",
        sourceId: reserve._id,
        revokedByPersonId: actorPersonId,
        reason: "Reserve took a panel seat; reserve grants retired",
      });
      await advanceAccessVersion(ctx, reserve.eventAccessSubjectId, now);
      revoked += 1;
    }
    return { assignedReserves: revoked };
  },
});

/** Hall check-in data lags the floor; drop the round's minimum-present rule so calls go through. */
export const setMinimumPresent = internalMutation({
  args: { roundId: v.id("reviewRounds"), minimum: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("The round does not exist.");
    if (!Number.isInteger(args.minimum) || args.minimum < 0) throw new Error("Choose a whole number.");
    const previous = round.minimumPresentParticipants;
    await ctx.db.patch(round._id, { minimumPresentParticipants: args.minimum, version: round.version + 1 });
    return { previous, now: args.minimum, version: round.version + 1 };
  },
});

/** Teams confirmed by direct patch never got the attendance-availability projection; create it. */
export const initializeTeamAvailability = internalMutation({
  args: { teamCodes: v.array(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const events = await ctx.db.query("events").take(2);
    const event = events[0];
    if (!event || events.length !== 1) throw new Error("Expected exactly one event.");
    const done: string[] = [];
    const missing: string[] = [];
    for (const raw of args.teamCodes) {
      const code = raw.trim().toUpperCase();
      const team = await ctx.db
        .query("teams")
        .withIndex("by_event_code", (q) => q.eq("eventId", event._id).eq("publicCode", code))
        .unique();
      if (!team) {
        missing.push(code);
        continue;
      }
      await initializeAttendanceTeamAvailability(ctx, {
        eventId: event._id,
        teamId: team._id,
        activeMemberCount: Math.max(1, team.activeMemberCount),
        now,
      });
      done.push(team.name);
    }
    return { done, missing };
  },
});

