import { useEffect, useRef, useState, type ReactNode } from "react";

import type { MusicRequestView, MusicSearchResult } from "../components/dashboard/MusicTile";
import { LiveDuration, LiveNumber } from "../components/LiveNumber";
import { Turntable } from "../components/music/Turntable";
import { MusicReport } from "../components/music/MusicReport";
import { OutlineHeading } from "../components/portal/OutlineHeading";
import { PortalScene } from "../components/portal/PortalScene";
import { RoomNav } from "../components/portal/RoomNav";
import {
  TeamCluster,
  type ClusterMember,
  type ClusterTeam,
} from "../components/portal/TeamCluster";
import { readableError } from "../lib/errors";
import { durationLabel, looksLikeYouTubeLink, musicStateLabels, thumbnailUrl } from "../lib/music";
import { useMusicModel, type MusicRoomModel } from "../lib/useMusicModel";

type SceneProps = {
  team: ClusterTeam;
  members: readonly ClusterMember[];
  teamEditable: boolean;
  onSignOut: () => void;
};

/** Synesthesia, wired to the live event. */
export function SynesthesiaScreen(props: SceneProps) {
  const model = useMusicModel();
  return <MusicRoom {...props} model={model} />;
}

/**
 * The music room, named for Octave, the 2021 edition's music site, which put
 * "You choose what plays" over a now-playing card and a queue with a big "+"
 * search box; this is that page on the hanami scene: a record for the track on
 * the speakers and the queue on a glass sheet. The turntable can still be
 * explored between music windows, with the arm parked and the motor stopped.
 */
export function MusicRoom({
  team,
  members,
  teamEditable,
  onSignOut,
  model,
}: SceneProps & { model: MusicRoomModel }) {
  return (
    <div className="music-room">
    <PortalScene
      tree="right"
      onSignOut={onSignOut}
      header={<TeamCluster team={team} members={members} editable={teamEditable} />}
      nav={<RoomNav current="music" />}
      backdrop={model.loaded && model.eligible ? (
        <Turntable track={model.nowPlaying} paused={model.window?.playbackPaused ?? false} />
      ) : undefined}
    >
      <div className="music-room-content relative flex w-full flex-1 flex-col text-left">
        <header className="music-room-heading flex flex-col gap-3">
          <OutlineHeading word="octave" />
        </header>

        {!model.loaded ? (
          <p role="status" className="m-0 text-[13px] text-fg/55">
            Tuning in…
          </p>
        ) : !model.eligible ? (
          <p className="m-0 text-[13px] text-fg/60">Music opens for accepted teams during the event.</p>
        ) : (
          <div className="music-room-layout">
            <div className="music-room-track pointer-events-auto"><NowPlaying model={model} /></div>
            <aside className="music-room-queue pointer-events-auto"><QueueSheet model={model} /></aside>
          </div>
        )}
      </div>
    </PortalScene>
    </div>
  );
}

/** Seconds into the current track, ticking once a second while it plays. */
function useElapsed(playing: MusicRequestView) {
  const startedAt = playing.playbackStartedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (startedAt === undefined) return null;
  return Math.min(playing.durationSeconds, Math.max(0, (now - startedAt) / 1_000));
}

function PlaybackProgress({ playing }: { playing: MusicRequestView }) {
  const elapsed = useElapsed(playing);
  const ratio =
    elapsed === null || playing.durationSeconds <= 0
      ? 0
      : Math.min(1, elapsed / playing.durationSeconds);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-px w-full overflow-hidden bg-fg/15">
        <div
          className="h-full bg-rose-light transition-[width] duration-1000 ease-linear"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <div className="flex justify-between text-[11px] tabular-nums text-fg/50">
        <span>{elapsed === null ? "–:––" : <LiveDuration seconds={elapsed} />}</span>
        <span>{durationLabel(playing.durationSeconds)}</span>
      </div>
    </div>
  );
}

function NowPlaying({ model }: { model: MusicRoomModel }) {
  const playing = model.nowPlaying;
  const paused = model.window?.playbackPaused ?? false;
  const title = playing ? playing.title : "Nothing on the speakers yet.";
  return (
    <section aria-label="Now playing" className="flex flex-col items-start gap-5">
      <div className="w-full min-w-0">
        {playing || paused ? <p className="m-0 mb-2 flex items-center gap-2 text-[10px] tracking-[.13em] text-fg/50 uppercase">
          <span className={`size-1.5 rounded-full ${playing && !paused ? "bg-rose-light shadow-[0_0_10px_var(--color-rose)]" : "bg-fg/25"}`} />
          {paused ? "paused by the desk" : "On the speakers"}
          {model.window ? <span className="text-fg/35">/ {model.window.name}</span> : null}
        </p> : null}
        <h2
          aria-live="polite"
          className="m-0 line-clamp-2 font-display text-[21px] font-normal leading-tight tracking-[-.01em] text-fg sm:text-[24px]"
          title={playing?.title}
        >
          {title}
        </h2>
        {playing ? <p className="m-0 mt-1 text-[12px] text-fg/50">{playing.artist}</p> : null}
        {playing ? (
          <div className="mt-3">
            <PlaybackProgress playing={playing} />
          </div>
        ) : null}
      </div>
      {playing ? (
        <div className="w-full">
          <MusicReport key={playing.id} request={playing} report={model.report} />
        </div>
      ) : null}
      {model.window ? (
        <p className="m-0 text-[11.5px] tabular-nums text-fg/50">
          <LiveNumber value={model.window.requestsUsed} /> of {model.window.requestsAllowed} requests ·{" "}
          <LiveNumber value={model.window.votesUsed} /> votes · One vote per song
        </p>
      ) : null}
    </section>
  );
}

function Thumb({ videoId }: { videoId: string | null }) {
  return (
    <span className="size-10 shrink-0 overflow-hidden rounded-[6px] bg-avatar">
      {videoId ? (
        <img
          src={thumbnailUrl(videoId, "default")}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      ) : null}
    </span>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
      <path
        d="M8 3.2c1.1-1.6 3.6-1.6 4.6.3.9 1.7 0 3.3-1.1 4.4L8 12.4 4.5 7.9c-1.1-1.1-2-2.7-1.1-4.4 1-1.9 3.5-1.9 4.6-.3z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
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
      onClick={onToggle}
      aria-pressed={request.hasVoted}
      aria-label={
        request.hasVoted ? `Remove your vote for ${request.title}` : `Vote for ${request.title}`
      }
      className={`flex h-7 min-w-[48px] shrink-0 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        request.hasVoted
          ? "border-rose-light bg-rose-light text-wash"
          : "border-rose/55 text-rose-light hover:border-rose-light"
      }`}
    >
      <HeartIcon filled={request.hasVoted} />
      <LiveNumber value={request.voteCount} />
    </button>
  );
}

type SearchOutcome =
  | { query: string; list: readonly MusicSearchResult[] }
  | { query: string; failure: string };

function closedReason(model: MusicRoomModel) {
  if (model.suspended) return "Your music actions are paused";
  if (model.window === null) return "No music window is open";
  if (!model.window.requestsOpen) return "Requests are closed for now";
  return null;
}

/** What a queued row says under its title, if anything. */
function rowMeta(request: MusicRequestView): ReactNode {
  const parts: string[] = [];
  if (request.state !== "queued" && request.state !== "approved") {
    parts.push(musicStateLabels[request.state]);
  }
  if (request.isMine) parts.push("yours");
  return parts.length > 0 ? parts.join(" · ") : null;
}

function QueueSheet({ model }: { model: MusicRoomModel }) {
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const latestSearch = useRef(0);
  // Live updates hand in a fresh model every render; only the query should
  // start a new search, so the search function rides along in a ref.
  const searchRef = useRef(model.search);
  useEffect(() => {
    searchRef.current = model.search;
  }, [model.search]);

  const closed = closedReason(model);
  const canRequest = model.eligible && closed === null;
  const trimmed = query.trim();
  const pastedLink = looksLikeYouTubeLink(trimmed);
  const activeQuery = canRequest && !pastedLink && trimmed.length >= 2 ? trimmed : null;
  const searching = activeQuery !== null && outcome?.query !== activeQuery;
  const results =
    activeQuery !== null && outcome?.query === activeQuery && "list" in outcome
      ? outcome.list
      : null;
  const searchFailure =
    activeQuery !== null && outcome?.query === activeQuery && "failure" in outcome
      ? outcome.failure
      : null;
  const showingSearch = activeQuery !== null || (canRequest && pastedLink);
  const queuedVideoIds = new Set(
    [model.nowPlaying, ...model.queue]
      .filter((request): request is MusicRequestView => request !== null)
      .map((request) => request.videoId),
  );

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
    setStatus(null);
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
      setStatus(result.created ? `${title} joined the queue.` : `${title} is already in the queue.`);
      setQuery("");
      setOutcome(null);
    });

  const submit = () => {
    if (!canRequest || busy !== null) return;
    if (pastedLink) {
      void request(trimmed, "Your link");
      return;
    }
    const first = results?.[0];
    if (first) void request(first.videoId, first.title);
  };

  const confirmPending = model.confirmPendingRequest;
  const count = model.queue.length;
  const notice =
    error ??
    status ??
    (model.window?.playbackPaused ? "Playback is paused by the desk." : null) ??
    (model.window && !model.window.votingOpen && !model.suspended ? "Voting is closed for now." : null);

  return (
    <section aria-label="Music queue" className="music-queue-sheet flex flex-col px-5 py-5 sm:px-6 sm:py-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="m-0 font-display text-[19px] font-normal text-fg">
          {showingSearch ? "Search" : "Queue"}
        </h2>
        {showingSearch ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="text-[12px] text-rose-light underline-offset-4 hover:underline"
          >
            back to the queue
          </button>
        ) : (
          <span className="text-[12px] tabular-nums text-fg/50">
            <LiveNumber value={count} /> {count === 1 ? "track" : "tracks"}
          </span>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        role="search"
        className="mt-4 flex overflow-hidden rounded-petal-xs border border-petal-edge-soft bg-wash/45 transition-colors focus-within:border-rose-light"
      >
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={!canRequest}
          maxLength={120}
          autoComplete="off"
          placeholder={canRequest ? "Add a song to the queue" : (closed ?? "")}
          aria-label="Search YouTube or paste a link"
          className="min-w-0 flex-1 bg-transparent px-4 py-2.5 text-[13.5px] text-fg placeholder:text-fg/45 focus:outline-none disabled:opacity-60 [&::-webkit-search-cancel-button]:hidden"
        />
        <button
          type="submit"
          disabled={!canRequest || busy !== null || (!pastedLink && !results?.length)}
          aria-label={pastedLink ? "Request this link" : "Request the first result"}
          className="flex w-11 shrink-0 items-center justify-center border-l border-petal-line font-display text-[24px] font-light leading-none text-rose-light transition-colors hover:bg-rose hover:text-wash disabled:text-fg/25 disabled:hover:bg-transparent disabled:hover:text-fg/25"
        >
          +
        </button>
      </form>

      {confirmPending ? (
        <p className="m-0 mt-3 flex flex-wrap items-baseline justify-between gap-x-4 text-[12px] text-fg/70">
          <span>Your last request didn’t get a reply.</span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run("confirm", async () => {
                const result = await confirmPending();
                setStatus(result.created ? "Your request joined the queue." : "It was already in the queue.");
              })
            }
            className="text-rose-light underline-offset-4 hover:underline disabled:opacity-50"
          >
            {busy === "confirm" ? "Confirming…" : "Confirm it"}
          </button>
        </p>
      ) : null}
      {notice ? (
        <p role={error ? "alert" : "status"} className={`m-0 mt-3 text-[12px] ${error ? "text-rose-light" : "text-fg/55"}`}>
          {notice}
        </p>
      ) : null}

      {showingSearch ? (
        pastedLink ? (
          <p className="m-0 mt-6 text-[13px] text-fg/55">
            Press <span className="text-rose-light">+</span> to request this link.
          </p>
        ) : searching ? (
          <p role="status" className="m-0 mt-6 text-[13px] text-fg/50">
            Searching…
          </p>
        ) : searchFailure ? (
          <p role="alert" className="m-0 mt-6 text-[13px] text-rose-light">
            {searchFailure}
          </p>
        ) : results && results.length === 0 ? (
          <p className="m-0 mt-6 text-[13px] text-fg/50">Nothing playable matched.</p>
        ) : (
          <ul className="m-0 mt-2 flex list-none flex-col divide-y divide-petal-line p-0">
            {(results ?? []).map((video) => {
              const queued = queuedVideoIds.has(video.videoId);
              return (
                <li key={video.videoId} className="flex items-center gap-3 py-2.5">
                  <Thumb videoId={video.videoId} />
                  <div className="min-w-0 flex-1">
                    <p className="m-0 truncate text-[13.5px] text-fg/90" title={video.title}>
                      {video.title}
                    </p>
                    <p className="m-0 mt-0.5 text-[11px] tabular-nums text-fg/50">
                      {durationLabel(video.durationSeconds)}
                    </p>
                  </div>
                  {queued ? (
                    <span className="shrink-0 text-[11px] text-fg/45">in the queue</span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void request(video.videoId, video.title)}
                      aria-label={`Request ${video.title}`}
                      className="flex size-7 shrink-0 items-center justify-center rounded-full border border-rose/55 font-display text-[18px] font-light leading-none text-rose-light transition-colors hover:bg-rose hover:text-wash disabled:opacity-45"
                    >
                      {busy === `request:${video.videoId}` ? "…" : "+"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )
      ) : count === 0 ? (
        <p className="m-0 mt-6 text-[13px] leading-relaxed text-fg/50">
          {canRequest
            ? "Nothing queued yet."
            : model.window
              ? "Nothing is queued right now."
              : "This page updates when a music window opens."}
        </p>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col divide-y divide-petal-line p-0">
          {model.queue.map((request) => {
            const meta = rowMeta(request);
            return (
              <li key={request.id} className="grid grid-cols-[40px_minmax(0,1fr)_auto_auto] items-center gap-x-3 py-2.5">
                <Thumb videoId={request.videoId} />
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-[13.5px] text-fg/90" title={request.title}>
                    {request.title}
                  </p>
                  {meta ? <p className="m-0 mt-0.5 truncate text-[11px] text-fg/50">{meta}</p> : null}
                </div>
                <VoteButton
                  request={request}
                  busy={busy === `vote:${request.id}`}
                  onToggle={() => void run(`vote:${request.id}`, () => model.toggleVote(request))}
                />
                <MusicReport request={request} report={model.report} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
