import { ConvexError } from "convex/values";
import { z } from "zod";

import type { YouTubeVideo } from "../values";
import { readBoundedJsonResponse } from "./boundedHttpBody";

export const maximumYouTubeSearchResults = 10;
const maximumResponseBytes = 256 * 1_024;
const requestTimeoutMs = 8_000;
const apiOrigin = "https://www.googleapis.com/youtube/v3";

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;

function youtubeApiKey() {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) {
    throw new ConvexError({
      code: "YOUTUBE_NOT_CONFIGURED",
      message: "YouTube search is not configured for this deployment.",
    });
  }
  return key;
}

// YouTube occasionally pads a video search with an item whose id is empty.
const searchResponse = z.object({
  items: z
    .array(z.object({ id: z.object({ videoId: z.string().regex(videoIdPattern).optional() }) }))
    .max(50),
});

const videosResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string().regex(videoIdPattern),
        snippet: z.object({
          title: z.string(),
          channelTitle: z.string(),
          thumbnails: z
            .object({
              medium: z.object({ url: z.string().url() }).optional(),
              default: z.object({ url: z.string().url() }).optional(),
            })
            .optional(),
        }),
        contentDetails: z.object({
          duration: z.string(),
          contentRating: z.object({ ytRating: z.string().optional() }).optional(),
        }),
        status: z.object({ embeddable: z.boolean() }),
      }),
    )
    .max(50),
});

const quotaFailure = z.object({
  error: z.object({
    errors: z.array(z.object({ reason: z.string() })).optional(),
  }),
});

/** Accepts a bare video id or any of the usual YouTube URL shapes. */
export function youtubeVideoId(value: string) {
  const trimmed = value.trim();
  if (videoIdPattern.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, "");
  const candidate =
    host === "youtu.be"
      ? url.pathname.slice(1)
      : host === "youtube.com" || host === "music.youtube.com"
        ? (url.searchParams.get("v") ??
          url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] ??
          "")
        : "";
  return videoIdPattern.test(candidate) ? candidate : null;
}

/** ISO 8601 durations as YouTube writes them: PT3M42S, PT1H2M, P1DT2H. */
export function youtubeDurationSeconds(value: string) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}

async function youtubeGet(path: string, parameters: Record<string, string>) {
  const url = new URL(`${apiOrigin}/${path}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  url.searchParams.set("key", youtubeApiKey());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch {
    throw new ConvexError({
      code: "YOUTUBE_UNAVAILABLE",
      message: "YouTube did not answer in time. Try again in a moment.",
    });
  } finally {
    clearTimeout(timer);
  }
  const body = await readBoundedJsonResponse(response, maximumResponseBytes).catch(() => null);
  if (response.ok) return body;
  const failure = quotaFailure.safeParse(body);
  const reasons = failure.success ? (failure.data.error.errors ?? []).map((e) => e.reason) : [];
  if (reasons.includes("quotaExceeded") || reasons.includes("dailyLimitExceeded")) {
    throw new ConvexError({
      code: "YOUTUBE_QUOTA",
      message: "YouTube search has hit today's limit. Paste a video link instead.",
    });
  }
  throw new ConvexError({
    code: "YOUTUBE_UNAVAILABLE",
    message: `YouTube search failed (${response.status}).`,
  });
}

function clip(value: string, maximum: number) {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

/** Looks up up to fifty videos by id, in the order given. Costs one quota unit. */
export async function lookupYouTubeVideos(videoIds: readonly string[]): Promise<YouTubeVideo[]> {
  if (videoIds.length === 0) return [];
  const body = await youtubeGet("videos", {
    part: "snippet,contentDetails,status",
    id: videoIds.slice(0, 50).join(","),
    fields:
      "items(id,snippet(title,channelTitle,thumbnails(medium(url),default(url))),contentDetails(duration,contentRating(ytRating)),status(embeddable))",
  });
  const parsed = videosResponse.safeParse(body);
  if (!parsed.success) {
    throw new ConvexError({
      code: "YOUTUBE_UNAVAILABLE",
      message: "YouTube returned an unexpected video listing.",
    });
  }
  const byId = new Map(parsed.data.items.map((item) => [item.id, item]));
  const videos: YouTubeVideo[] = [];
  for (const videoId of videoIds) {
    const item = byId.get(videoId);
    if (!item) continue;
    const durationSeconds = youtubeDurationSeconds(item.contentDetails.duration);
    if (durationSeconds === null) continue;
    const thumbnailUrl =
      item.snippet.thumbnails?.medium?.url ?? item.snippet.thumbnails?.default?.url;
    videos.push({
      videoId,
      title: clip(item.snippet.title, 120),
      channelTitle: clip(item.snippet.channelTitle, 120),
      durationSeconds,
      ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
      ageRestricted: item.contentDetails.contentRating?.ytRating === "ytAgeRestricted",
      embeddable: item.status.embeddable,
    });
  }
  return videos;
}

/** One search costs about a hundred quota units, so callers cache the result. */
export async function searchYouTubeVideos(query: string): Promise<YouTubeVideo[]> {
  const body = await youtubeGet("search", {
    part: "id",
    type: "video",
    videoEmbeddable: "true",
    safeSearch: "moderate",
    maxResults: String(maximumYouTubeSearchResults),
    q: query,
    fields: "items(id(videoId))",
  });
  const parsed = searchResponse.safeParse(body);
  if (!parsed.success) {
    throw new ConvexError({
      code: "YOUTUBE_UNAVAILABLE",
      message: "YouTube returned an unexpected search listing.",
    });
  }
  return lookupYouTubeVideos(
    parsed.data.items.flatMap((item) => (item.id.videoId ? [item.id.videoId] : [])),
  );
}
