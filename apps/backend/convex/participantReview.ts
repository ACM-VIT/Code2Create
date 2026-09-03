import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { teamRoundTableLabel } from "./lib/floor";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { estimateQueueWindow } from "./lib/queueEstimate";
import { participantQueuePosition } from "./lib/reviewQueueProjection";
import {
  maximumReviewRoundsPerEvent,
  maximumReviewersPerPanel,
  maximumReviewSessionsPerTeamRound,
} from "./lib/reviewLimits";
import { activeRoundPause } from "./lib/reviewRoundPauses";
import { reviewSessionStatus, teamRoundState } from "./values";

type ReadCtx = QueryCtx | MutationCtx;
type ParticipantQueueEstimate = {
  earliestAt: number;
  latestAt: number;
  sampleSize: number;
  basis: "configured" | "observed";
};

async function currentTeam(
  ctx: ReadCtx,
  eventId: Id<"events">,
  membershipId: Id<"eventMemberships">,
) {
  const teamMember = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index.eq("eventId", eventId).eq("membershipId", membershipId).eq("status", "active"),
    )
    .unique();
  if (!teamMember) return null;
  const team = await ctx.db.get(teamMember.teamId);
  if (!team || team.eventId !== eventId) return null;
  return { team, teamMember };
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

function randomManualCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const compact = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
}

function tokenDigest(value: string) {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

function isLiveReview(status: Doc<"reviewSessions">["status"]) {
  return ["awaiting_presence", "active", "overdue"].includes(status);
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      teamId: v.id("teams"),
      teamName: v.string(),
      serverNow: v.number(),
      round: v.object({
        id: v.id("reviewRounds"),
        name: v.string(),
        startsAt: v.number(),
        endsAt: v.number(),
        isPaused: v.boolean(),
      }),
      state: teamRoundState,
      panel: v.union(v.null(), v.object({ id: v.id("reviewPanels"), name: v.string() })),
      // The team's own table for this round, which is where the panel comes.
      tableLabel: v.optional(v.string()),
      teamsAhead: v.optional(v.number()),
      estimate: v.union(
        v.null(),
        v.object({
          earliestAt: v.number(),
          latestAt: v.number(),
          basis: v.union(v.literal("configured"), v.literal("observed")),
          sampleSize: v.number(),
        }),
      ),
      review: v.union(
        v.null(),
        v.object({
          id: v.id("reviewSessions"),
          status: reviewSessionStatus,
          reviewerPresenceCount: v.number(),
          reviewerCount: v.number(),
          canShowTeamQr: v.boolean(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const person = await findCurrentPerson(ctx);
    if (!person) return null;
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!membership) return null;
    const teamContext = await currentTeam(ctx, event._id, membership._id);
    if (!teamContext) return null;
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "queue.participant.read",
      scopeType: "team",
      scopeId: teamContext.team._id,
    });
    const serverNow = Date.now();
    const rounds = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (index) =>
        index.eq("eventId", event._id).eq("status", "open"),
      )
      .take(maximumReviewRoundsPerEvent + 1);
    if (rounds.length > maximumReviewRoundsPerEvent) {
      throw new Error("An event exceeds the published review-round limit.");
    }
    const openRounds = rounds.sort((left, right) => left.sequence - right.sequence);
    let selectedRound: Doc<"reviewRounds"> | null = null;
    let selectedState: Doc<"teamRoundStates"> | null = null;
    for (const round of openRounds) {
      const state = await ctx.db
        .query("teamRoundStates")
        .withIndex("by_round_team", (index) =>
          index.eq("roundId", round._id).eq("teamId", teamContext.team._id),
        )
        .unique();
      if (!state || state.state !== "completed") {
        selectedRound = round;
        selectedState = state;
        break;
      }
    }
    if (!selectedRound) return null;
    const roundPause = await activeRoundPause(ctx, selectedRound._id);
    const panel = selectedState?.panelId ? await ctx.db.get(selectedState.panelId) : null;
    const sessions = await ctx.db
      .query("reviewSessions")
      .withIndex("by_round_team_status", (index) =>
        index.eq("roundId", selectedRound._id).eq("teamId", teamContext.team._id),
      )
      .take(maximumReviewSessionsPerTeamRound + 1);
    if (sessions.length > maximumReviewSessionsPerTeamRound) {
      throw new Error("A team exceeds the review-attempt limit for this round.");
    }
    const session = sessions.find((candidate) => isLiveReview(candidate.status)) ?? null;
    let assignments: Doc<"reviewAssignments">[] = [];
    let presences: Doc<"reviewPresence">[] = [];
    let canMintTeamQr = false;
    if (session) {
      const [loadedAssignments, loadedPresences, teamQrGrantIds] = await Promise.all([
        ctx.db
          .query("reviewAssignments")
          .withIndex("by_session_person", (index) => index.eq("reviewSessionId", session._id))
          .take(maximumReviewersPerPanel + 1),
        ctx.db
          .query("reviewPresence")
          .withIndex("by_session_reviewer", (index) => index.eq("reviewSessionId", session._id))
          .take(maximumReviewersPerPanel + 1),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "review.team_qr.mint",
          scopeType: "team",
          scopeId: teamContext.team._id,
        }),
      ]);
      assignments = loadedAssignments;
      presences = loadedPresences;
      canMintTeamQr = teamQrGrantIds.length > 0;
    }
    if (
      assignments.length > maximumReviewersPerPanel ||
      presences.length > maximumReviewersPerPanel
    ) {
      throw new Error("A review exceeds the published reviewer limit.");
    }
    let teamsAhead: number | undefined;
    let estimate: ParticipantQueueEstimate | null = null;
    if (selectedState?.state === "queued") {
      const panelId = selectedState.panelId;
      if (panelId === undefined) {
        throw new Error("A queued team must have a panel and queue time.");
      }
      teamsAhead = await participantQueuePosition(ctx, selectedState);
      const [awaitingPresence, activeReview, overdueReview, completedReviews] = await Promise.all([
        ctx.db
          .query("reviewSessions")
          .withIndex("by_panel_status", (index) =>
            index.eq("panelId", panelId).eq("status", "awaiting_presence"),
          )
          .first(),
        ctx.db
          .query("reviewSessions")
          .withIndex("by_panel_status", (index) =>
            index.eq("panelId", panelId).eq("status", "active"),
          )
          .first(),
        ctx.db
          .query("reviewSessions")
          .withIndex("by_panel_status", (index) =>
            index.eq("panelId", panelId).eq("status", "overdue"),
          )
          .first(),
        ctx.db
          .query("reviewSessions")
          .withIndex("by_panel_status", (index) =>
            index.eq("panelId", panelId).eq("status", "completed"),
          )
          .order("desc")
          .take(9),
      ]);
      const livePanelReview = activeReview ?? overdueReview ?? awaitingPresence;
      const estimatedWindow = roundPause
        ? null
        : estimateQueueWindow({
            now: serverNow,
            configuredDurationSeconds: selectedRound.reviewDurationSeconds,
            teamsAhead,
            ...(livePanelReview?.plannedEndAt !== undefined
              ? { activeReviewPlannedEndAt: livePanelReview.plannedEndAt }
              : livePanelReview
                ? {
                    activeReviewPlannedEndAt:
                      serverNow + selectedRound.reviewDurationSeconds * 1_000,
                  }
                : {}),
            completedDurationsSeconds: completedReviews.flatMap((review) =>
              review.startedAt !== undefined && review.completedAt !== undefined
                ? [(review.completedAt - review.startedAt) / 1_000]
                : [],
            ),
          });
      estimate = estimatedWindow
        ? {
            earliestAt: serverNow + estimatedWindow.lowerMinutes * 60_000,
            latestAt: serverNow + estimatedWindow.upperMinutes * 60_000,
            basis: estimatedWindow.basis,
            sampleSize: estimatedWindow.sampleSize,
          }
        : null;
    }
    return {
      teamId: teamContext.team._id,
      teamName: teamContext.team.name,
      serverNow,
      round: {
        id: selectedRound._id,
        name: selectedRound.name,
        startsAt: selectedRound.startsAt,
        endsAt: selectedRound.endsAt,
        isPaused: roundPause !== null,
      },
      state: selectedState?.state ?? "unassigned",
      panel: panel && panel.eventId === event._id ? { id: panel._id, name: panel.name } : null,
      ...(selectedState?.tableLabel !== undefined ? { tableLabel: selectedState.tableLabel } : {}),
      ...(teamsAhead !== undefined ? { teamsAhead } : {}),
      estimate,
      review: session
        ? {
            id: session._id,
            status: session.status,
            reviewerPresenceCount: presences.length,
            reviewerCount: assignments.filter((assignment) => assignment.status === "assigned")
              .length,
            canShowTeamQr: session.status === "awaiting_presence" && canMintTeamQr,
          }
        : null,
    };
  },
});

export const teamQrState = query({
  args: {
    eventSlug: v.string(),
    tokenId: v.id("reviewTeamQrTokens"),
  },
  returns: v.union(
    v.null(),
    v.object({
      state: v.union(v.literal("active"), v.literal("superseded"), v.literal("expired")),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const membership = await requireMembership(ctx, event._id, person._id);
    const teamContext = await currentTeam(ctx, event._id, membership._id);
    if (!teamContext) return null;
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "queue.participant.read",
      scopeType: "team",
      scopeId: teamContext.team._id,
    });
    const token = await ctx.db.get(args.tokenId);
    if (!token || token.eventId !== event._id || token.teamId !== teamContext.team._id) {
      return null;
    }
    return { state: token.state, expiresAt: token.expiresAt };
  },
});

export const mintTeamQr = mutation({
  args: { eventSlug: v.string(), reviewSessionId: v.id("reviewSessions") },
  returns: v.object({
    tokenId: v.id("reviewTeamQrTokens"),
    payload: v.string(),
    manualCode: v.string(),
    expiresAt: v.number(),
    serverNow: v.number(),
    teamName: v.string(),
    roundName: v.string(),
    tableLabel: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const teamContext = await currentTeam(ctx, event._id, membership._id);
    const session = await ctx.db.get(args.reviewSessionId);
    if (
      !teamContext ||
      !session ||
      session.eventId !== event._id ||
      session.teamId !== teamContext.team._id ||
      session.status !== "awaiting_presence"
    ) {
      throw new ConvexError({
        code: "REVIEW_QR_UNAVAILABLE",
        message: "A team QR is available only while this team is waiting at its panel.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.team_qr.mint",
      scopeType: "team",
      scopeId: teamContext.team._id,
    });
    const [round, panel, activeToken, latestToken] = await Promise.all([
      ctx.db.get(session.roundId),
      ctx.db.get(session.panelId),
      ctx.db
        .query("reviewTeamQrTokens")
        .withIndex("by_session_state", (index) =>
          index.eq("reviewSessionId", session._id).eq("state", "active"),
        )
        .unique(),
      ctx.db
        .query("reviewTeamQrTokens")
        .withIndex("by_session_version", (index) => index.eq("reviewSessionId", session._id))
        .order("desc")
        .first(),
    ]);
    if (!round || !panel || round.eventId !== event._id || panel.eventId !== event._id) {
      throw new Error("Review QR context is incomplete.");
    }
    if (
      (activeToken !== null &&
        (activeToken.eventId !== event._id || activeToken.teamId !== teamContext.team._id)) ||
      (latestToken !== null &&
        (latestToken.eventId !== event._id || latestToken.teamId !== teamContext.team._id))
    ) {
      throw new Error("A review team QR belongs to the wrong event or team.");
    }
    const qrTableLabel = await teamRoundTableLabel(ctx, round._id, teamContext.team._id);
    const now = Date.now();
    if (activeToken !== null) {
      await ctx.db.patch(activeToken._id, {
        state: activeToken.expiresAt <= now ? "expired" : "superseded",
      });
    }
    const payload = `c2c-review-v1.${randomToken()}`;
    const manualCode = randomManualCode();
    const expiresAt = now + 2 * 60 * 1_000;
    const tokenVersion = (latestToken?.tokenVersion ?? 0) + 1;
    const tokenId = await ctx.db.insert("reviewTeamQrTokens", {
      eventId: event._id,
      reviewSessionId: session._id,
      teamId: teamContext.team._id,
      tokenDigest: tokenDigest(payload),
      manualCodeDigest: tokenDigest(manualCode.replaceAll("-", "")),
      tokenVersion,
      state: "active",
      expiresAt,
      issuedByMembershipId: membership._id,
      issuedAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.team_qr.mint",
      grantIds,
      scopeType: "team",
      scopeId: teamContext.team._id,
      action: "review.team_qr_issued",
      targetType: "review_team_qr",
      targetId: tokenId,
      nextSummary: JSON.stringify({ reviewSessionId: session._id, tokenVersion, expiresAt }),
      reason: "Team member opened the current reviewer-presence QR",
    });
    return {
      tokenId,
      payload,
      manualCode,
      expiresAt,
      serverNow: now,
      teamName: teamContext.team.name,
      roundName: round.name,
      ...(qrTableLabel !== undefined ? { tableLabel: qrTableLabel } : {}),
    };
  },
});
