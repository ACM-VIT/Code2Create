import type { MusicRequestState } from "../components/dashboard/MusicTile";

/** A pasted id or any YouTube address; anything else is a search phrase. */
export function looksLikeYouTubeLink(value: string) {
  return /^[A-Za-z0-9_-]{11}$/.test(value) || /youtu\.?be/i.test(value);
}

export function durationLabel(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export const musicStateLabels: Record<MusicRequestState, string> = {
  pending: "waiting for the desk",
  approved: "approved",
  queued: "queued",
  playing: "playing",
  played: "played",
  skipped: "skipped",
  rejected: "not added",
  hidden: "hidden",
};

/** YouTube's still frames: `default` 120×90, `mq` 320×180, `hq` 480×360. */
export function thumbnailUrl(videoId: string, size: "default" | "mq" | "hq" = "mq") {
  return `https://i.ytimg.com/vi/${videoId}/${size === "default" ? "default" : `${size}default`}.jpg`;
}
