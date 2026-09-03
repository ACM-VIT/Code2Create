import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds } from "./lib/permissions";
import {
  activeSynesthesiaWindow,
  catalogTrackFields,
  requireSynesthesiaParticipant,
  synesthesiaParticipantContext,
  unclassifiedEnergyTag,
  youtubeProvider,
} from "./lib/synesthesia";
import { lookupYouTubeVideos, searchYouTubeVideos, youtubeVideoId } from "./lib/youtubeCatalog";
import { createSongRequest, participantWindowForWrite } from "./synesthesiaParticipant";
import { youtubeVideo, type YouTubeVideo } from "./values";

/** A phrase is fetched from YouTube at most this often, across everyone. */
const searchCacheTtlMs = 30 * 60_000;
/** The catalog accepts this duration range; anything else is not requestable. */
const minimumTrackSeconds = 30;
const maximumTrackSeconds = 1_800;

const windowRules = v.object({
  maxTrackDurationSeconds: v.number(),
  allowExplicit: v.boolean(),
});
type WindowRules = { maxTrackDurationSeconds: number; allowExplicit: boolean };
// Actions here call queries in this same module, so their results are typed by
// hand to keep the generated API types from looping back on themselves.
type SearchContext = { allowed: boolean; rules: WindowRules | null; cached: YouTubeVideo[] | null };
type RequestResult = { requestId: Id<"songRequests">; created: boolean };

function searchQueryKey(query: string) {
  const key = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (key.length < 2 || key.length > 80) {
    throw new ConvexError({
      code: "INVALID_SEARCH",
      message: "Search with two to eighty characters.",
    });
  }
  return key;
}

function videoIsRequestable(video: YouTubeVideo, rules: WindowRules | null) {
  return (
    video.embeddable &&
    video.durationSeconds >= minimumTrackSeconds &&
    video.durationSeconds <= maximumTrackSeconds &&
    (rules === null ||
      (video.durationSeconds <= rules.maxTrackDurationSeconds &&
        (!video.ageRestricted || rules.allowExplicit)))
  );
}

/**
 * Who is searching decides the filter: the music desk sees everything YouTube
 * returns, a participant only what the running window would accept.
 */
export const searchContext = internalQuery({
  args: { eventSlug: v.string(), queryKey: v.string() },
  returns: v.object({
    allowed: v.boolean(),
    rules: v.union(v.null(), windowRules),
    cached: v.union(v.null(), v.array(youtubeVideo)),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const staffGrants = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.catalog.manage",
      scopeType: "event",
    });
    let rules: WindowRules | null = null;
    if (staffGrants.length === 0) {
      const context = await synesthesiaParticipantContext(ctx, args.eventSlug);
      if (!context.eligible || context.accessState?.state === "suspended") {
        return { allowed: false, rules: null, cached: null };
      }
      const window = await activeSynesthesiaWindow(ctx, event._id, Date.now());
      if (!window || !window.requestsOpen) return { allowed: false, rules: null, cached: null };
      rules = {
        maxTrackDurationSeconds: window.maxTrackDurationSeconds,
        allowExplicit: window.allowExplicit,
      };
    }
    const cached = await ctx.db
      .query("synesthesiaSearchCache")
      .withIndex("by_provider_query", (index) =>
        index.eq("provider", youtubeProvider).eq("queryKey", args.queryKey),
      )
      .unique();
    const fresh = cached !== null && cached.fetchedAt > Date.now() - searchCacheTtlMs;
    return { allowed: true, rules, cached: fresh ? cached.results : null };
  },
});

export const storeSearchResults = internalMutation({
  args: { queryKey: v.string(), results: v.array(youtubeVideo), fetchedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("synesthesiaSearchCache")
      .withIndex("by_provider_query", (index) =>
        index.eq("provider", youtubeProvider).eq("queryKey", args.queryKey),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { results: args.results, fetchedAt: args.fetchedAt });
    } else {
      await ctx.db.insert("synesthesiaSearchCache", {
        provider: youtubeProvider,
        queryKey: args.queryKey,
        results: args.results,
        fetchedAt: args.fetchedAt,
      });
    }
    return null;
  },
});

export const search = action({
  args: { eventSlug: v.string(), query: v.string() },
  returns: v.array(youtubeVideo),
  handler: async (ctx, args): Promise<YouTubeVideo[]> => {
    const queryKey = searchQueryKey(args.query);
    const context: SearchContext = await ctx.runQuery(internal.synesthesiaYouTube.searchContext, {
      eventSlug: args.eventSlug,
      queryKey,
    });
    if (!context.allowed) return [];
    let results = context.cached;
    if (results === null) {
      results = await searchYouTubeVideos(queryKey);
      await ctx.runMutation(internal.synesthesiaYouTube.storeSearchResults, {
        queryKey,
        results,
        fetchedAt: Date.now(),
      });
    }
    return results.filter((video) => videoIsRequestable(video, context.rules));
  },
});

export const requestContext = internalQuery({
  args: {
    eventSlug: v.string(),
    windowId: v.id("synesthesiaWindows"),
    videoId: v.string(),
  },
  returns: v.object({ known: v.boolean() }),
  handler: async (ctx, args) => {
    const context = await requireSynesthesiaParticipant(ctx, args.eventSlug);
    const window = await participantWindowForWrite(ctx, context.event._id, args.windowId);
    if (!window.requestsOpen) {
      throw new ConvexError({
        code: "REQUESTS_CLOSED",
        message: "New requests are closed for this window.",
      });
    }
    const track = await ctx.db
      .query("synesthesiaCatalogTracks")
      .withIndex("by_event_provider_track", (index) =>
        index
          .eq("eventId", context.event._id)
          .eq("provider", youtubeProvider)
          .eq("providerTrackId", args.videoId),
      )
      .unique();
    return { known: track !== null };
  },
});

/**
 * Files a request for a YouTube video the action already verified, adding the
 * video to the event catalog the first time anyone asks for it.
 */
export const requestVerifiedVideo = internalMutation({
  args: {
    eventSlug: v.string(),
    windowId: v.id("synesthesiaWindows"),
    videoId: v.string(),
    video: v.optional(youtubeVideo),
    note: v.optional(v.string()),
    clientOperationId: v.string(),
  },
  returns: v.object({ requestId: v.id("songRequests"), created: v.boolean() }),
  handler: async (ctx, args) => {
    const context = await requireSynesthesiaParticipant(ctx, args.eventSlug);
    let track = await ctx.db
      .query("synesthesiaCatalogTracks")
      .withIndex("by_event_provider_track", (index) =>
        index
          .eq("eventId", context.event._id)
          .eq("provider", youtubeProvider)
          .eq("providerTrackId", args.videoId),
      )
      .unique();
    if (!track) {
      const video = args.video;
      if (!video || video.videoId !== args.videoId) {
        throw new Error("A new YouTube request arrived without its verified video.");
      }
      const now = Date.now();
      const trackId = await ctx.db.insert("synesthesiaCatalogTracks", {
        eventId: context.event._id,
        provider: youtubeProvider,
        providerTrackId: video.videoId,
        ...catalogTrackFields({
          title: video.title,
          artist: video.channelTitle,
          durationSeconds: video.durationSeconds,
          isExplicit: video.ageRestricted,
          energyTag: unclassifiedEnergyTag,
        }),
        status: "active",
        version: 1,
        createdByPersonId: context.person._id,
        updatedByPersonId: context.person._id,
        createdAt: now,
        updatedAt: now,
      });
      track = await ctx.db.get("synesthesiaCatalogTracks", trackId);
      if (!track) throw new Error("The catalog track did not persist.");
    }
    return createSongRequest(ctx, {
      context,
      windowId: args.windowId,
      track,
      note: args.note,
      clientOperationId: args.clientOperationId,
    });
  },
});

export const requestVideo = action({
  args: {
    eventSlug: v.string(),
    windowId: v.id("synesthesiaWindows"),
    /** A video id or any YouTube link. */
    video: v.string(),
    note: v.optional(v.string()),
    clientOperationId: v.string(),
  },
  returns: v.object({ requestId: v.id("songRequests"), created: v.boolean() }),
  handler: async (ctx, args): Promise<RequestResult> => {
    const videoId = youtubeVideoId(args.video);
    if (!videoId) {
      throw new ConvexError({
        code: "INVALID_VIDEO",
        message: "Paste a YouTube link or pick a search result.",
      });
    }
    const context: { known: boolean } = await ctx.runQuery(
      internal.synesthesiaYouTube.requestContext,
      { eventSlug: args.eventSlug, windowId: args.windowId, videoId },
    );
    let video: YouTubeVideo | undefined;
    if (!context.known) {
      [video] = await lookupYouTubeVideos([videoId]);
      if (!video || !videoIsRequestable(video, null)) {
        throw new ConvexError({
          code: "TRACK_NOT_ALLOWED",
          message:
            "That video cannot be played here: it must be embeddable and between 30 seconds and 30 minutes.",
        });
      }
    }
    const result: RequestResult = await ctx.runMutation(
      internal.synesthesiaYouTube.requestVerifiedVideo,
      {
        eventSlug: args.eventSlug,
        windowId: args.windowId,
        videoId,
        ...(video !== undefined ? { video } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
        clientOperationId: args.clientOperationId,
      },
    );
    return result;
  },
});
