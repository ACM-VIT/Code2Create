import { LiveNumber, LiveDuration } from "../LiveNumber";
import { useEffect, useRef, useState, type SubmitEvent } from "react";

import { readableError } from "../../lib/errors";
import { useSceneryPlayer } from "../../lib/useYouTubePlayer";
import { PortalButton } from "../portal/PortalButton";
import { Tile, TileEyebrow } from "./Tile";
import { clampWhenShort, tileBody } from "./tileClasses";
import type { Slot } from "./dashboardLayout";
import { useReducedMotion } from "./useReducedMotion";

export type MusicRequestState =
  | "pending"
  | "approved"
  | "queued"
  | "playing"
  | "played"
  | "skipped"
  | "rejected"
  | "hidden";

export type MusicRequestView = {
  id: string;
  videoId: string | null;
  title: string;
  artist: string;
  durationSeconds: number;
  state: MusicRequestState;
  voteCount: number;
  hasVoted: boolean;
  canVote: boolean;
  isMine: boolean;
  publicReason?: string;
  /** Server time the desk marked it playing; drives the progress bar. */
  playbackStartedAt?: number;
};

export type MusicSearchResult = {
  videoId: string;
  title: string;
  channelTitle: string;
  durationSeconds: number;
  thumbnailUrl?: string;
};

export type MusicTileModel = {
  eligible: boolean;
  suspended: boolean;
  window: {
    name: string;
    endsAt: number;
    requestsOpen: boolean;
    votingOpen: boolean;
    playbackPaused: boolean;
    requestsUsed: number;
    requestsAllowed: number;
    votesUsed: number;
    votesAllowed: number;
  } | null;
  nowPlaying: MusicRequestView | null;
  /** Everything else visible in the window, in play order. */
  queue: readonly MusicRequestView[];
  search: (query: string) => Promise<readonly MusicSearchResult[]>;
  /** A video id, a search result's id, or a pasted link. */
  request: (video: string) => Promise<{ created: boolean }>;
  toggleVote: (request: MusicRequestView) => Promise<void>;
};

const stateLabels: Record<MusicRequestState, string> = {
  pending: "waiting for the desk",
  approved: "approved",
  queued: "queued",
  playing: "playing",
  played: "played",
  skipped: "skipped",
  rejected: "not added",
  hidden: "hidden",
};

function durationLabel(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.max(0, Math.floor(seconds % 60))).padStart(2, "0")}`;
}

function timeLabel(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function statusLine(model: MusicTileModel) {
  if (!model.eligible) return "Music opens for accepted teams during the event.";
  if (model.suspended) return "Your music actions are paused. You can still follow the queue.";
  if (model.window === null) return "No music window is open right now.";
  if (model.window.playbackPaused) return "Playback is paused by the desk.";
  return null;
}

/** A pasted id or any YouTube address; anything else is a search phrase. */
function looksLikeYouTubeLink(value: string) {
  return /^[A-Za-z0-9_-]{11}$/.test(value) || /youtu\.?be/i.test(value);
}

function canRequestIn(model: MusicTileModel) {
  return model.eligible && !model.suspended && model.window?.requestsOpen === true;
}

/** Seconds into the current track, ticking once a second while it plays. */
function useElapsed(playing: MusicRequestView | null) {
  const startedAt = playing?.playbackStartedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!playing || startedAt === undefined) return null;
  return Math.min(playing.durationSeconds, Math.max(0, (now - startedAt) / 1_000));
}

/**
 * The video behind the tile: muted and looping, cropped to cover and zoomed well
 * past the edges so YouTube's title bar and bottom bar stay outside the
 * card. YouTube also draws centre controls whenever the player starts, pauses,
 * or is resized, so the still frame veils the player until it has been
 * playing quietly for a moment. Under reduced motion, the still frame only.
 */
function VideoBackdrop({ videoId, still, resizeKey }: { videoId: string; still: boolean; resizeKey: string }) {
  const { container, state } = useSceneryPlayer({ videoId: still ? null : videoId });
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (state !== "playing") return;
    const timer = window.setTimeout(() => setSettled(true), 3_200);
    return () => window.clearTimeout(timer);
  }, [state, resizeKey]);
  const veiled = still || state !== "playing" || !settled;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden [container-type:size]">
      {!still ? (
        <div
          ref={container}
          className="absolute top-1/2 left-1/2 h-[max(160cqh,90cqw)] w-[max(160cqw,284cqh)] -translate-x-1/2 -translate-y-1/2 opacity-80 saturate-[.9] [&_iframe]:absolute [&_iframe]:inset-0 [&_iframe]:size-full"
        />
      ) : null}
      <img
        src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
        alt=""
        className={`absolute inset-0 size-full object-cover opacity-70 saturate-[.85] transition-opacity duration-700 ${veiled ? "" : "opacity-0"}`}
      />
      <div className="absolute inset-0 bg-[linear-gradient(to_top,var(--color-wash)_0%,color-mix(in_srgb,var(--color-wash)_55%,transparent)_42%,color-mix(in_srgb,var(--color-wash)_12%,transparent)_100%)]" />
    </div>
  );
}

/** A restrained ambient player state for the gaps between tracks. */
function QuietMusicBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <span className="music-idle-halo absolute top-1/2 left-1/2 size-28 rounded-full bg-rose-light/10 blur-3xl" />
      <span className="music-idle-note absolute top-1/2 left-1/2 flex size-16 items-center justify-center text-rose-light/35">
        <svg viewBox="0 0 48 62" className="h-full w-full overflow-visible">
          <path
            d="M20 43.5V13.2L40 8v29.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M20 14l20-5.2v7L20 21z" fill="currentColor" opacity=".5" />
          <ellipse cx="12.5" cy="46.5" rx="8.5" ry="6" transform="rotate(-14 12.5 46.5)" fill="currentColor" />
          <ellipse cx="32.5" cy="40.2" rx="8.5" ry="6" transform="rotate(-14 32.5 40.2)" fill="currentColor" />
        </svg>
      </span>
      <span className="music-idle-shadow absolute top-[calc(50%_+_38px)] left-1/2 h-1.5 w-12 rounded-full bg-rose/12 blur-md" />
    </div>
  );
}

function ProgressBar({
  elapsed,
  duration,
  thin = false,
}: {
  elapsed: number | null;
  duration: number;
  thin?: boolean;
}) {
  const ratio = elapsed === null || duration <= 0 ? 0 : Math.min(1, elapsed / duration);
  return (
    <div className={`w-full overflow-hidden bg-fg/15 ${thin ? "h-[3px]" : "h-1 rounded-full"}`}>
      <div
        className={`h-full bg-rose-light shadow-[0_0_12px_var(--glow-rose)] transition-[width] duration-1000 ease-linear ${thin ? "" : "rounded-full"}`}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}

function VoteButton({
  request,
  busy,
  onToggle,
}: {
  request: MusicRequestView;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy || !request.canVote}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      aria-pressed={request.hasVoted}
      aria-label={
        request.hasVoted ? `Remove your vote for ${request.title}` : `Vote for ${request.title}`
      }
      className={`flex h-7 min-w-11 items-center justify-center gap-1 rounded-full border px-2.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        request.hasVoted
          ? "border-rose-light bg-rose-light text-wash"
          : "border-rose/60 text-rose-light hover:border-rose-light"
      }`}
    >
      <svg viewBox="0 0 16 16" className="size-3" aria-hidden>
        <path
          d="M8 3.2c1.1-1.6 3.6-1.6 4.6.3.9 1.7 0 3.3-1.1 4.4L8 12.4 4.5 7.9c-1.1-1.1-2-2.7-1.1-4.4 1-1.9 3.5-1.9 4.6-.3z"
          fill={request.hasVoted ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.3"
        />
      </svg>
      <LiveNumber value={request.voteCount} />
    </button>
  );
}

/** A quiet pill button for the player's action row. */
function PlayerAction({
  active = false,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] font-semibold backdrop-blur-md transition-colors ${
        active
          ? "border-rose-light bg-rose-light text-wash"
          : "border-rose/55 bg-wash/45 text-fg/85 hover:border-rose-light hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

type SearchOutcome =
  | { query: string; list: readonly MusicSearchResult[] }
  | { query: string; failure: string };

type Panel = "queue" | "search";

function OpenMusic({ model }: { model: MusicTileModel }) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latestSearch = useRef(0);
  // Live updates hand in a fresh model every render; only the query should
  // start a new search, so the search function rides along in a ref.
  const searchRef = useRef(model.search);
  useEffect(() => {
    searchRef.current = model.search;
  }, [model.search]);
  const { window: musicWindow, nowPlaying } = model;
  const elapsed = useElapsed(nowPlaying);
  const canRequest = canRequestIn(model);
  const trimmed = query.trim();
  const activeQuery = canRequest && trimmed.length >= 2 ? trimmed : null;
  const searching = activeQuery !== null && outcome?.query !== activeQuery;
  const results =
    activeQuery !== null && outcome?.query === activeQuery && "list" in outcome
      ? outcome.list
      : null;
  const searchFailure =
    activeQuery !== null && outcome?.query === activeQuery && "failure" in outcome
      ? outcome.failure
      : null;
  const status = statusLine(model);

  useEffect(() => {
    if (activeQuery === null) return;
    const run = ++latestSearch.current;
    const timer = window.setTimeout(() => {
      void searchRef
        .current(activeQuery)
        .then((list) => {
          if (latestSearch.current === run) setOutcome({ query: activeQuery, list });
        })
        .catch((caught: unknown) => {
          if (latestSearch.current === run)
            setOutcome({ query: activeQuery, failure: readableError(caught) });
        });
    }, 420);
    return () => window.clearTimeout(timer);
  }, [activeQuery]);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  const request = (video: string, title: string) =>
    run(`request:${video}`, async () => {
      const result = await model.request(video);
      setNotice(
        result.created ? `${title} joined the queue.` : `${title} is already in the queue.`,
      );
      setQuery("");
      setPanel("queue");
    });

  const submitLink = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canRequest || !looksLikeYouTubeLink(trimmed)) return;
    void request(trimmed, "That link");
  };

  const message = error ?? notice;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* The player, over the video. */}
      <div className="flex min-h-0 flex-1 flex-col justify-between gap-4 p-5 pr-14">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <TileEyebrow>music</TileEyebrow>
          <span className="text-[12px] text-fg/55">
            {musicWindow ? `${musicWindow.name} · until ${timeLabel(musicWindow.endsAt)}` : "quiet"}
          </span>
        </div>

        <div className="flex min-w-0 flex-col gap-3.5">
          {nowPlaying ? (
            <div className="min-w-0">
              <p className="m-0 line-clamp-2 font-display text-2xl leading-tight text-shadow-[0_6px_30px_var(--scene-text-glow)] lg:text-[30px]">
                {nowPlaying.title}
              </p>
            </div>
          ) : (
            <p className="m-0 font-display text-xl text-fg/85">
              {status ?? "Nothing playing yet."}
            </p>
          )}

          {nowPlaying ? (
            <div className="flex flex-col gap-1.5">
              <ProgressBar elapsed={elapsed} duration={nowPlaying.durationSeconds} />
              <div className="flex justify-between text-[11px] text-fg/55">
                <span>{elapsed === null ? "–:––" : <LiveDuration seconds={elapsed} />}</span>
                <span>{durationLabel(nowPlaying.durationSeconds)}</span>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {nowPlaying ? (
              <VoteButton
                request={nowPlaying}
                busy={busy !== null}
                onToggle={() =>
                  void run(`vote:${nowPlaying.id}`, () => model.toggleVote(nowPlaying))
                }
              />
            ) : null}
            <PlayerAction onClick={() => setPanel("queue")}>
              queue
              <span className="text-fg/55"><LiveNumber value={model.queue.length} /></span>
            </PlayerAction>
            {canRequest ? (
              <PlayerAction onClick={() => setPanel("search")}>search</PlayerAction>
            ) : null}
            {message ? (
              <span
                role={error ? "alert" : "status"}
                className={`text-[12px] ${error ? "text-rose-light" : "text-fg/65"}`}
              >
                {message}
              </span>
            ) : status && nowPlaying ? (
              <span className="text-[12px] text-fg/55">{status}</span>
            ) : null}
          </div>
        </div>
      </div>

      {/* The sheet: queue or search, on its own opaque ground. */}
      {panel ? (
        <div className="absolute inset-0 z-10 flex translate-y-0 flex-col bg-wash/[.97] opacity-100 backdrop-blur-3xl motion-safe:transition-[transform,opacity] motion-safe:duration-[380ms] motion-safe:ease-[cubic-bezier(.22,1,.36,1)] starting:translate-y-6 starting:opacity-0">
          <div className="flex items-center gap-2 px-5 pt-4 pr-14 pb-3">
            <PlayerAction
              active={panel === "queue"}
              onClick={() => setPanel(panel === "queue" ? null : "queue")}
            >
              queue
              <span className={panel === "queue" ? "text-wash/70" : "text-fg/55"}>
                <LiveNumber value={model.queue.length} />
              </span>
            </PlayerAction>
            {canRequest ? (
              <PlayerAction
                active={panel === "search"}
                onClick={() => setPanel(panel === "search" ? null : "search")}
              >
                search
              </PlayerAction>
            ) : null}
            {musicWindow ? (
              <span className="ml-auto text-[11.5px] text-fg/45">
                <LiveNumber value={musicWindow.requestsUsed} />/{musicWindow.requestsAllowed} requests
              </span>
            ) : null}
          </div>

          {panel === "search" && canRequest && musicWindow ? (
            <form onSubmit={submitLink} className="relative px-5 pb-3">
              <input
                type="text"
                enterKeyHint="search"
                spellCheck={false}
                value={query}
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search YouTube or paste a link"
                maxLength={120}
                autoComplete="off"
                className="h-10 w-full rounded-[12px] border border-rose/50 bg-wash/60 px-3.5 pr-24 font-ui text-[14px] text-fg outline-none transition-colors placeholder:text-fg/40 focus:border-rose-light"
              />
              {searching ? (
                <span className="pointer-events-none absolute top-1/2 right-8 -translate-y-1/2 text-[11px] text-fg/45">
                  searching…
                </span>
              ) : null}
            </form>
          ) : null}

          <div className="min-h-0 flex-1 px-5 pb-3">
            {panel === "search" ? (
              searchFailure ? (
                <p className="m-0 text-[13px] text-rose-light">{searchFailure}</p>
              ) : results ? (
                results.length === 0 ? (
                  <p className="m-0 text-[13px] text-fg/55">
                    Nothing playable matches that. Try another phrase or paste a link.
                  </p>
                ) : (
                  <ul className="m-0 flex list-none flex-col p-0">
                    {results.map((video) => (
                      <li
                        key={video.videoId}
                        className="flex items-center gap-3 border-b border-rose/20 py-2 last:border-b-0"
                      >
                        {video.thumbnailUrl ? (
                          <img
                            src={video.thumbnailUrl}
                            alt=""
                            className="h-8 w-14 flex-none rounded-[6px] object-cover"
                          />
                        ) : (
                          <span className="h-8 w-14 flex-none rounded-[6px] bg-fg/10" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] text-fg">
                            {video.title}
                          </span>
                          <span className="block truncate text-[11.5px] text-fg/55">
                            {video.channelTitle} · {durationLabel(video.durationSeconds)}
                          </span>
                        </span>
                        <PortalButton
                          size="sm"
                          variant="solid"
                          disabled={busy !== null}
                          onClick={() => void request(video.videoId, video.title)}
                        >
                          {busy === `request:${video.videoId}` ? "Adding…" : "Request"}
                        </PortalButton>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <p className="m-0 text-[13px] text-fg/55">
                  {activeQuery !== null ? "" : "Type a title or artist, or paste a YouTube link."}
                </p>
              )
            ) : model.queue.length === 0 ? (
              <p className="m-0 text-[13px] text-fg/55">
                {canRequest
                  ? "The queue is empty. Search for something the room would like."
                  : "The queue is empty."}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {model.queue.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 border-b border-rose/20 py-2 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-fg">
                        {item.title}
                        {item.isMine ? (
                          <span className="ml-1.5 text-[11px] text-rose-light">yours</span>
                        ) : null}
                      </span>
                      <span className="block truncate text-[11.5px] text-fg/55">
                        {item.artist} · {durationLabel(item.durationSeconds)} ·{" "}
                        {stateLabels[item.state]}
                        {item.publicReason ? ` · ${item.publicReason}` : ""}
                      </span>
                    </span>
                    <VoteButton
                      request={item}
                      busy={busy !== null}
                      onToggle={() => void run(`vote:${item.id}`, () => model.toggleVote(item))}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {message ? (
            <p
              role={error ? "alert" : "status"}
              className={`m-0 px-5 pb-3 text-[12px] ${error ? "text-rose-light" : "text-fg/60"}`}
            >
              {message}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setPanel(null)}
            aria-label="Back to the player"
            className="group flex flex-col border-t border-rose/25 text-left transition-colors hover:bg-fg/5"
          >
            {nowPlaying ? (
              <ProgressBar elapsed={elapsed} duration={nowPlaying.durationSeconds} thin />
            ) : null}
            <span className="flex items-center gap-3 px-5 py-3">
              <span className="min-w-0 flex-1 truncate text-[13px] text-fg/85">
                {nowPlaying ? nowPlaying.title : "Nothing playing yet."}
              </span>
              <svg
                viewBox="0 0 16 16"
                className="size-3.5 flex-none text-fg/60 transition-colors group-hover:text-fg"
                aria-hidden
              >
                <path
                  d="M3 6l5 5 5-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The music tile: the room's player as one card. The video is the card's
 * ground; the player floats on it, and the queue and search open as a sheet.
 */
export function MusicTile({
  slot,
  model,
  focused,
  onFocus,
  onRelease,
}: {
  slot: Slot;
  model: MusicTileModel;
  focused: boolean;
  onFocus: () => void;
  onRelease: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const { nowPlaying } = model;
  const elapsed = useElapsed(nowPlaying);
  const status = statusLine(model);
  const waiting = model.queue.filter(
    (request) =>
      request.state === "pending" || request.state === "approved" || request.state === "queued",
  ).length;
  const backdrop = nowPlaying?.videoId ? (
    <VideoBackdrop videoId={nowPlaying.videoId} still={reducedMotion} resizeKey={focused ? "open" : "rest"} />
  ) : (
    <QuietMusicBackdrop />
  );

  return (
    <Tile
      slot={slot}
      expanded={focused}
      onToggle={onFocus}
      onRelease={onRelease}
      backdrop={backdrop}
    >
      {focused ? (
        <OpenMusic model={model} />
      ) : (
        <div className={tileBody}>
          <TileEyebrow>music</TileEyebrow>
          <div className="min-w-0">
            {nowPlaying ? (
              <>
                <p className={`m-0 line-clamp-2 font-display text-[19px] leading-tight text-shadow-[0_6px_30px_var(--scene-text-glow)] ${clampWhenShort}`}>
                  {nowPlaying.title}
                </p>
              </>
            ) : (
              <p className="m-0 text-[13px] leading-snug text-fg/65">
                {status ??
                  (waiting > 0 ? <><LiveNumber value={waiting} /> waiting in the queue</> : "Nothing playing yet.")}
              </p>
            )}
          </div>
          {nowPlaying ? (
            <div className="absolute inset-x-0 bottom-0">
              <ProgressBar elapsed={elapsed} duration={nowPlaying.durationSeconds} thin />
            </div>
          ) : null}
        </div>
      )}
    </Tile>
  );
}
