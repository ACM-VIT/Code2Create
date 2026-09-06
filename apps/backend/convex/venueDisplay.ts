import { v } from "convex/values";

import { query } from "./_generated/server";
import { activeSynesthesiaWindow } from "./lib/synesthesia";

/**
 * What the venue's big screens show, readable without a sign-in: the track on
 * the speakers and what follows it. Only track titles leave the building here.
 */

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
  }),
  handler: async (ctx, args) => {
    const serverNow = Date.now();
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", args.eventSlug))
      .unique();
    if (!event || event.status !== "live") return { serverNow, music: null };

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

    return { serverNow, music };
  },
});
