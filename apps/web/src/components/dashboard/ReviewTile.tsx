import { LiveNumber } from "../LiveNumber";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { readableError } from "../../lib/errors";
import { QrTree } from "../portal/QrTree";
import { Tile, TileEyebrow } from "./Tile";
import type { Slot } from "./dashboardLayout";
import { tileBody } from "./tileClasses";

export type TeamReviewCode = {
  payload: string;
  manualCode: string;
  expiresAt: number;
  serverNow: number;
};

export type ServiceQueueKind = "outing_permission";

export type ServiceQueueView = {
  kind: ServiceQueueKind;
  joined: boolean;
  position: number | null;
  waitingCount: number;
};

export type ReviewTileModel = {
  available: boolean;
  queue: {
    round: string;
    status: string;
    active: boolean;
    /** The team's one-based position while queued. */
    rank: number | null;
    detail: string | null;
    wait: ReactNode;
    reviewers: { present: number; total: number } | null;
  } | null;
  /** Mints the team's review code; present only while reviewers are due. */
  showCode: { sessionId: string; mint: () => Promise<TeamReviewCode> } | null;
  services: readonly ServiceQueueView[];
  setServiceQueue: (kind: ServiceQueueKind, joined: boolean) => Promise<void>;
};

function QueuePetal({
  self = false,
  open = false,
  leading = false,
}: {
  self?: boolean;
  open?: boolean;
  leading?: boolean;
}) {
  return (
    <span
      className={`queue-petal relative z-10 flex h-6 w-4 shrink-0 items-center justify-center ${
        self ? "queue-petal-self text-rose-light" : "text-rose/60"
      } ${open ? "queue-petal-open" : ""} ${leading ? "queue-petal-leading" : ""}`}
    >
      <svg viewBox="0 0 16 24" className="h-full w-full overflow-visible" aria-hidden>
        <path
          d="M8 20.5C3.2 17.1 1.9 12.2 3.8 7.8 4.9 5.3 7 3.5 10.4 2.2c1 3.6.9 7-.4 10.1-1 2.5-2.4 4.3-2 8.2Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth=".8"
          strokeLinejoin="round"
        />
        <path
          d="M9.9 5.4C7.9 9.7 7.2 14.1 8 20.5"
          fill="none"
          stroke="var(--color-wash)"
          strokeWidth=".65"
          strokeLinecap="round"
          opacity=".48"
        />
      </svg>
    </span>
  );
}

function QueueDestination({ label, review }: { label: string; review: boolean }) {
  return (
    <span className="relative z-10 flex h-7 w-10 shrink-0 items-center justify-center text-fg/45">
      <span
        className={`queue-destination-mark relative block h-7 w-3 ${
          review ? "text-rose-light/70" : "text-rose/55"
        }`}
        aria-hidden
      >
        <span className="queue-destination-pin absolute top-1/2 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-light" />
      </span>
      <span className="absolute top-full mt-1 font-mono text-[7.5px] tracking-[.14em] uppercase">{label}</span>
    </span>
  );
}

function QueueTrail({
  ahead,
  joined,
  review = false,
}: {
  ahead: number;
  joined: boolean;
  review?: boolean;
}) {
  const visibleAhead = Math.min(ahead, 3);
  const hiddenAhead = Math.max(0, ahead - visibleAhead);
  const ariaLabel = joined
    ? ahead === 0
      ? `You are next at the ${review ? "review table" : "permission desk"}`
      : `${ahead} ${review ? "teams" : "people"} ahead of you`
    : ahead === 0
      ? "The queue is empty; join to be next"
      : `${ahead} ${ahead === 1 ? "person is" : "people are"} currently waiting`;

  return (
    <div className="queue-trail relative mt-1 min-h-14 flex-1" role="img" aria-label={ariaLabel}>
      <svg
        viewBox="0 0 260 56"
        preserveAspectRatio="none"
        className="queue-trail-line pointer-events-none absolute top-1/2 left-5 h-12 w-[calc(100%_-_38px)] -translate-y-1/2 overflow-visible"
        aria-hidden
      >
        <path
          d="M0 28C52 19 91 33 134 27s84-5 126 1"
          fill="none"
          stroke="currentColor"
          strokeWidth=".8"
          className="text-rose/35"
        />
        <path
          d="M0 28C52 19 91 33 134 27s84-5 126 1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeDasharray="32 228"
          strokeLinecap="round"
          className="queue-trail-glint text-rose-light/70"
        />
      </svg>
      <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-between gap-1">
        <QueueDestination label={review ? "panel" : "desk"} review={review} />
        {hiddenAhead > 0 ? (
          <span className="relative z-10 rounded-full border border-rose/25 bg-wash/65 px-1.5 py-0.5 font-mono text-[7.5px] text-fg/50 backdrop-blur-sm">
            +{hiddenAhead}
          </span>
        ) : null}
        {Array.from({ length: visibleAhead }, (_, index) => (
          <span key={index} className={`queue-waypoint queue-waypoint-${index + 1}`}>
            <QueuePetal leading={index === 0} />
          </span>
        ))}
        <span className="relative z-10 flex h-7 w-9 shrink-0 items-center justify-center text-fg/50">
          <QueuePetal self={joined} open={!joined} />
          <span className="absolute top-full mt-0.5 font-mono text-[7.5px] tracking-[.12em] uppercase">{joined ? "you" : "open"}</span>
        </span>
      </div>
    </div>
  );
}

function ServiceQueueCard({
  service,
  busy,
  onChange,
}: {
  service: ServiceQueueView;
  busy: boolean;
  onChange: (joined: boolean) => void;
}) {
  const ahead = service.joined ? Math.max(0, (service.position ?? 1) - 1) : service.waitingCount;
  const detail = service.joined
    ? ahead === 0
      ? "You're next"
      : <><LiveNumber value={ahead} /> {ahead === 1 ? "person" : "people"} ahead</>
    : service.waitingCount === 0
      ? "Be first in line"
      : <><LiveNumber value={service.waitingCount} /> waiting now</>;
  const displayPosition = service.joined ? (service.position ?? 1) : service.waitingCount;
  return (
    <section className={`queue-card relative flex min-w-0 flex-col overflow-hidden rounded-[14px] border px-3 py-2.5 ${service.joined ? "border-rose-light/40 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--color-rose-light)_10%,transparent),transparent_58%)]" : "border-rose/20 bg-wash/12"}`}>
      <span aria-hidden className="queue-rank-watermark pointer-events-none absolute -right-1 -bottom-5 font-display text-[68px] leading-none text-rose-light/[.045]">
        {String(displayPosition).padStart(2, "0")}
      </span>
      <div className="relative z-10 flex min-w-0 items-start justify-between gap-1.5">
        <span className="min-w-0">
          <span className="block truncate text-[10.5px] font-medium text-fg/90">Outing permission</span>
          <span className="queue-card-meta block truncate text-[9.5px] text-fg/45">{detail}</span>
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange(!service.joined)}
          aria-label={`${service.joined ? "Leave" : "Join"} outing permission queue`}
          className={`queue-action h-6 shrink-0 rounded-full border px-2.5 font-mono text-[8px] tracking-[.08em] uppercase transition-[border-color,background-color,color,transform] hover:border-rose-light hover:text-fg active:scale-[.97] disabled:cursor-wait disabled:opacity-50 ${service.joined ? "border-rose-light/40 bg-rose-light/10 text-rose-light" : "border-rose/35 bg-wash/30 text-fg/70"}`}
        >
          {busy ? "updating…" : service.joined ? "leave" : "join"}
        </button>
      </div>
      <QueueTrail ahead={ahead} joined={service.joined} />
    </section>
  );
}

function ReviewQueueCard({ queue }: { queue: NonNullable<ReviewTileModel["queue"]> }) {
  const { rank, status, detail, wait, reviewers } = queue;
  const title = rank === null ? "Project review" : "Review queue";
  const ahead = rank === null ? null : Math.max(0, rank - 1);

  return (
    <section className="queue-card queue-card-review relative flex min-w-0 flex-col overflow-hidden rounded-[14px] border border-rose-light/30 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--color-rose-light)_12%,transparent),transparent_60%)] px-3 py-2.5">
      {rank === null ? null : (
        <span aria-hidden className="queue-rank-watermark pointer-events-none absolute -right-1 -bottom-5 font-display text-[68px] leading-none text-rose-light/[.055]">
          {String(rank).padStart(2, "0")}
        </span>
      )}
      <div className="relative z-10 flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-[11.5px] font-medium text-fg/90">{title}</span>
          <span className="queue-card-meta block truncate text-[9.5px] text-fg/45">
            {status}{wait === null ? null : <> · {wait}</>}
          </span>
        </span>
        {rank === null ? null : (
          <span
            aria-label={`Review status ${status}, rank ${rank}`}
            className="shrink-0 font-mono text-[8px] tracking-[.1em] text-rose-light/80 uppercase"
          >
            position&nbsp; <LiveNumber value={rank} />
          </span>
        )}
      </div>
      {ahead === null ? null : <QueueTrail ahead={ahead} joined review />}
      {detail || reviewers ? (
        <div className="queue-card-context relative z-10 mt-auto flex min-w-0 flex-col text-[9px] leading-snug text-fg/45">
          {detail ? <span className="truncate">{detail}</span> : null}
          {reviewers ? (
            <span className="truncate">
              <LiveNumber value={reviewers.present} /> of <LiveNumber value={reviewers.total} /> reviewers checked in
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function useSecondsLeft(code: TeamReviewCode | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!code) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [code]);
  if (!code) return 0;
  return Math.max(0, Math.ceil((code.expiresAt - now) / 1_000));
}

/**
 * The card as the code: the tree fills it while reviewers are due, and a
 * tap on the card flattens the tree into the scannable code. It mints on
 * arrival and renews on tap once it has expired.
 */
function ReviewCodeCard({
  slot,
  round,
  request,
}: {
  slot: Slot;
  round: string;
  request: NonNullable<ReviewTileModel["showCode"]>;
}) {
  const [code, setCode] = useState<TeamReviewCode | null>(null);
  const [flat, setFlat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mint = useRef(request.mint);
  const secondsLeft = useSecondsLeft(code);
  const live = code && secondsLeft > 0 ? code : null;

  useEffect(() => {
    mint.current = request.mint;
  }, [request.mint]);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(await mint.current());
      setFlat(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    mint.current()
      .then((minted) => {
        if (!cancelled) setCode(minted);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(readableError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [request.sessionId]);

  const onToggle = () => {
    if (busy) return;
    if (live) setFlat((value) => !value);
    else void refresh();
  };

  return (
    <Tile slot={slot} open={flat} onToggle={onToggle}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {live ? (
          <div className="absolute inset-x-[18px] top-[46px] bottom-[44px]">
            <QrTree value={live.payload} size="fill" flat={flat} label="Team review code" />
          </div>
        ) : null}
        <div className="pointer-events-none relative z-10 flex flex-1 flex-col justify-between p-[18px]">
          <div className="flex items-baseline justify-between gap-3">
            <TileEyebrow>review</TileEyebrow>
            <span className="truncate text-[11px] text-fg/50">{round}</span>
          </div>
          <div className="flex items-end justify-between gap-3">
            {error ? (
              <span className="text-[12.5px] text-rose-light">{error}</span>
            ) : live ? (
              <span className="font-mono text-[13px] tracking-[.08em] text-fg">{live.manualCode}</span>
            ) : (
              <span className="text-[12.5px] text-fg/60">{busy ? "Making your code…" : code ? "Expired. Tap for a new one." : "Making your code…"}</span>
            )}
            {live ? <span className="text-[11px] text-fg/45"><LiveNumber value={secondsLeft} />s</span> : null}
          </div>
        </div>
      </div>
    </Tile>
  );
}

/**
 * The review tile: a read-only view of the team's position in the round.
 * While reviewers are due it becomes the team's review code.
 */
export function ReviewTile({ slot, model }: { slot: Slot; model: ReviewTileModel }) {
  const [busyKind, setBusyKind] = useState<ServiceQueueKind | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const queue = model.queue;
  if (queue && model.showCode) {
    return (
      <ReviewCodeCard
        key={model.showCode.sessionId}
        slot={slot}
        round={queue.round}
        request={model.showCode}
      />
    );
  }
  const hasQueueRows = model.services.length > 0 || queue !== null;
  const changeServiceQueue = async (kind: ServiceQueueKind, joined: boolean) => {
    setBusyKind(kind);
    setServiceError(null);
    try {
      await model.setServiceQueue(kind, joined);
    } catch (caught) {
      setServiceError(readableError(caught));
    } finally {
      setBusyKind(null);
    }
  };

  return (
    <Tile slot={slot}>
      <div className={`${tileBody} !gap-2`}>
        <div className="flex shrink-0 items-baseline justify-between gap-3">
          <TileEyebrow>queues</TileEyebrow>
          {queue ? <span className="truncate text-[11px] text-fg/50">{queue.round}</span> : null}
        </div>
        {hasQueueRows ? (
          <div className={`queue-card-list grid min-h-0 flex-1 gap-2 ${model.services.length > 0 && queue !== null ? "queue-card-list-paired" : ""}`}>
            {model.services.map((service) => (
              <ServiceQueueCard
                key={service.kind}
                service={service}
                busy={busyKind === service.kind}
                onChange={(joined) => void changeServiceQueue(service.kind, joined)}
              />
            ))}
            {queue ? <ReviewQueueCard queue={queue} /> : null}
          </div>
        ) : !model.available ? (
          <p className="m-0 text-[13px] leading-snug text-fg/65">Queues open once your place is confirmed.</p>
        ) : (
          <p className="m-0 text-[13px] leading-snug text-fg/65">No queues are open right now.</p>
        )}
        {serviceError ? <p role="status" className="m-0 text-[11px] text-rose-light">{serviceError}</p> : null}
      </div>
    </Tile>
  );
}
