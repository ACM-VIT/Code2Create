import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { findCurrentPerson, requireCurrentPerson, requireEventSubject, requireMembership } from "./lib/identity";
import { requirePermission } from "./lib/permissions";
import { estimateQueueWindow } from "./lib/queueEstimate";
import { activeRoundPause } from "./lib/reviewRoundPauses";

type ReadCtx = QueryCtx | MutationCtx;

async function currentTeam(
  ctx: ReadCtx,
  eventId: Id<"events">,
  membershipId: Id<"eventMemberships">,
) {
  const teamMember = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", eventId)
        .eq("membershipId", membershipId)
        .eq("status", "active"),
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
      round: v.object({
        id: v.id("reviewRounds"),
        name: v.string(),
        startsAt: v.number(),
        endsAt: v.number(),
        isPaused: v.boolean(),
      }),
      state: v.string(),
      panel: v.union(
        v.null(),
        v.object({ id: v.id("reviewPanels"), name: v.string(), tableLabel: v.string() }),
      ),
      teamsAhead: v.optional(v.number()),
      estimate: v.union(
        v.null(),
        v.object({
          lowerMinutes: v.number(),
          upperMinutes: v.number(),
          basis: v.union(v.literal("configured"), v.literal("observed")),
          sampleSize: v.number(),
          calculatedAt: v.number(),
        }),
      ),
      review: v.union(
        v.null(),
        v.object({
          id: v.id("reviewSessions"),
          status: v.string(),
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
    const rounds = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id))
      .collect();
    const openRounds = rounds
      .filter((round) => round.status === "open")
      .sort((left, right) => left.sequence - right.sequence);
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
      .collect();
    const session = sessions.find((candidate) => isLiveReview(candidate.status)) ?? null;
    const [assignments, presences] = session
      ? await Promise.all([
          ctx.db
            .query("reviewAssignments")
            .withIndex("by_session_person", (index) =>
              index.eq("reviewSessionId", session._id),
            )
            .collect(),
          ctx.db
            .query("reviewPresence")
            .withIndex("by_session_reviewer", (index) =>
              index.eq("reviewSessionId", session._id),
            )
            .collect(),
        ])
      : [[], []];
    let teamsAhead: number | undefined;
    let estimate: ReturnType<typeof estimateQueueWindow> | null = null;
    if (selectedState?.state === "queued" && selectedState.panelId) {
      const panelId = selectedState.panelId;
      const queue = await ctx.db
        .query("teamRoundStates")
        .withIndex("by_panel_state_priority_queued", (index) =>
          index.eq("panelId", panelId).eq("state", "queued"),
        )
        .collect();
      const ordered = queue.sort(
        (left, right) =>
          right.priority - left.priority ||
          (left.queuedAt ?? left.updatedAt) - (right.queuedAt ?? right.updatedAt) ||
          left._id.localeCompare(right._id),
      );
      const position = ordered.findIndex((state) => state._id === selectedState._id);
      if (position >= 0) {
        teamsAhead = position;
        const now = Date.now();
        const [awaitingPresence, activeReview, overdueReview, completedReviews] =
          await Promise.all([
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
        estimate = roundPause
          ? null
          : estimateQueueWindow({
              now,
              configuredDurationSeconds: selectedRound.reviewDurationSeconds,
              teamsAhead,
              ...(livePanelReview?.plannedEndAt !== undefined
                ? { activeReviewPlannedEndAt: livePanelReview.plannedEndAt }
                : livePanelReview
                  ? {
                      activeReviewPlannedEndAt:
                        now + selectedRound.reviewDurationSeconds * 1_000,
                    }
                  : {}),
              completedDurationsSeconds: completedReviews.flatMap((review) =>
                review.startedAt !== undefined && review.completedAt !== undefined
                  ? [(review.completedAt - review.startedAt) / 1_000]
                  : [],
              ),
            });
      }
    }
    return {
      teamId: teamContext.team._id,
      teamName: teamContext.team.name,
      round: {
        id: selectedRound._id,
        name: selectedRound.name,
        startsAt: selectedRound.startsAt,
        endsAt: selectedRound.endsAt,
        isPaused: roundPause !== null,
      },
      state: selectedState?.state ?? "unassigned",
      panel:
        panel && panel.eventId === event._id
          ? { id: panel._id, name: panel.name, tableLabel: panel.tableLabel }
          : null,
      ...(teamsAhead !== undefined ? { teamsAhead } : {}),
      estimate: estimate
        ? { ...estimate, calculatedAt: Date.now() }
        : null,
      review: session
        ? {
            id: session._id,
            status: session.status,
            reviewerPresenceCount: presences.length,
            reviewerCount: assignments.filter((assignment) => assignment.status === "assigned").length,
            canShowTeamQr: session.status === "awaiting_presence",
          }
        : null,
    };
  },
});

export const mintTeamQr = mutation({
  args: { eventSlug: v.string(), reviewSessionId: v.id("reviewSessions") },
  returns: v.object({
    payload: v.string(),
    manualCode: v.string(),
    expiresAt: v.number(),
    teamName: v.string(),
    roundName: v.string(),
    tableLabel: v.string(),
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
    const [round, panel, existingTokens] = await Promise.all([
      ctx.db.get(session.roundId),
      ctx.db.get(session.panelId),
      ctx.db
        .query("reviewTeamQrTokens")
        .withIndex("by_session_state", (index) =>
          index.eq("reviewSessionId", session._id),
        )
        .collect(),
    ]);
    if (!round || !panel || round.eventId !== event._id || panel.eventId !== event._id) {
      throw new Error("Review QR context is incomplete.");
    }
    const now = Date.now();
    for (const token of existingTokens.filter((candidate) => candidate.state === "active")) {
      await ctx.db.patch(token._id, { state: "superseded" });
    }
    const payload = `c2c-review-v1.${randomToken()}`;
    const manualCode = randomManualCode();
    const expiresAt = now + 2 * 60 * 1_000;
    const tokenVersion =
      existingTokens.reduce((maximum, token) => Math.max(maximum, token.tokenVersion), 0) + 1;
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
      payload,
      manualCode,
      expiresAt,
      teamName: teamContext.team.name,
      roundName: round.name,
      tableLabel: panel.tableLabel,
    };
  },
});
