import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { activeSynesthesiaWindow } from "./lib/synesthesia";

/**
 * What the venue's big screens show, readable without a sign-in: the track on
 * the speakers and what follows it, and which team each review panel is
 * seeing or calling. Only track titles and team names leave the building here.
 */

const panelCallUps = v.object({
  name: v.string(),
  inReview: v.array(v.string()),
  called: v.array(v.string()),
  upNext: v.array(v.string()),
});

async function teamNames(ctx: QueryCtx, states: Doc<"teamRoundStates">[]) {
  const teams = await Promise.all(states.map((state) => ctx.db.get(state.teamId)));
  return teams.flatMap((team) => (team ? [team.name] : []));
}

async function panelStates(
  ctx: QueryCtx,
  panelId: Id<"reviewPanels">,
  state: Doc<"teamRoundStates">["state"],
  limit: number,
) {
  return ctx.db
    .query("teamRoundStates")
    .withIndex("by_panel_state_priority_queued", (index) =>
      index.eq("panelId", panelId).eq("state", state),
    )
    .take(limit);
}

/** The open round's panels with the team at the table, the team called, and who is next. */
async function reviewCallUps(ctx: QueryCtx, eventId: Id<"events">) {
  const round = await ctx.db
    .query("reviewRounds")
    .withIndex("by_event_status_start", (index) => index.eq("eventId", eventId).eq("status", "open"))
    .first();
  if (!round) return null;
  const panels = (
    await ctx.db
      .query("reviewPanels")
      .filter((q) => q.eq(q.field("roundId"), round._id))
      .collect()
  )
    .filter((panel) => panel.status !== "closed")
    .sort((left, right) => left.stableKey.localeCompare(right.stableKey, undefined, { numeric: true }));
  return {
    roundName: round.name,
    panels: await Promise.all(
      panels.map(async (panel) => {
        const [inReview, atTable, called, queued] = await Promise.all([
          panelStates(ctx, panel._id, "in_review", 2),
          panelStates(ctx, panel._id, "at_table", 2),
          panelStates(ctx, panel._id, "called", 3),
          panelStates(ctx, panel._id, "queued", 2),
        ]);
        return {
          name: panel.name,
          inReview: await teamNames(ctx, [...inReview, ...atTable]),
          called: await teamNames(ctx, called),
          upNext: await teamNames(ctx, queued),
        };
      }),
    ),
  };
}

export const state = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    serverNow: v.number(),
    music: v.union(
      v.null(),
      v.object({
        windowName: v.string(),
        playbackPaused: v.boolean(),
        nowPlaying: v.union(
          v.null(),
          v.object({
            title: v.string(),
            artist: v.string(),
            videoId: v.union(v.null(), v.string()),
            durationSeconds: v.number(),
            playbackStartedAt: v.optional(v.number()),
          }),
        ),
        upNext: v.array(v.string()),
      }),
    ),
    review: v.union(v.null(), v.object({ roundName: v.string(), panels: v.array(panelCallUps) })),
  }),
  handler: async (ctx, args) => {
    const serverNow = Date.now();
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", args.eventSlug))
      .unique();
    if (!event || event.status !== "live") return { serverNow, music: null, review: null };

    const window = await activeSynesthesiaWindow(ctx, event._id, serverNow);
    let music = null;
    if (window) {
      const [playing, queued, approved] = await Promise.all([
        ctx.db
          .query("songRequests")
          .withIndex("by_window_state_created", (index) =>
            index.eq("windowId", window._id).eq("state", "playing"),
          )
          .first(),
        ctx.db
          .query("songRequests")
          .withIndex("by_window_state_created", (index) =>
            index.eq("windowId", window._id).eq("state", "queued"),
          )
          .take(3),
        ctx.db
          .query("songRequests")
          .withIndex("by_window_state_created", (index) =>
            index.eq("windowId", window._id).eq("state", "approved"),
          )
          .take(3),
      ]);
      music = {
        windowName: window.name,
        playbackPaused: window.playbackPaused,
        nowPlaying: playing
          ? {
              title: playing.title,
              artist: playing.artist,
              videoId: playing.provider === "youtube" ? playing.providerTrackId : null,
              durationSeconds: playing.durationSeconds,
              ...(playing.playbackStartedAt !== undefined
                ? { playbackStartedAt: playing.playbackStartedAt }
                : {}),
            }
          : null,
        upNext: [...queued, ...approved].slice(0, 3).map((request) => request.title),
      };
    }

    return { serverNow, music, review: await reviewCallUps(ctx, event._id) };
  },
});
