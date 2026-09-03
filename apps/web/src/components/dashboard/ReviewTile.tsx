import { useEffect, useRef, useState } from "react";

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
    /** The participant-facing state label. */
    state: string;
    /** The team's one-based position while queued. */
    rank: number | null;
  } | null;
  /** Mints the team's review code; present only while reviewers are due. */
  showCode: { sessionId: string; mint: () => Promise<TeamReviewCode> } | null;
  services: readonly ServiceQueueView[];
  setServiceQueue: (kind: ServiceQueueKind, joined: boolean) => Promise<void>;
};

function ServiceQueueRow({
  service,
  busy,
  onChange,
}: {
  service: ServiceQueueView;
  busy: boolean;
  onChange: (joined: boolean) => void;
}) {
  const detail = service.joined
    ? service.position === 1
      ? "You're next"
      : `Position ${service.position ?? "—"}`
    : service.waitingCount === 0
      ? "No wait"
      : `${service.waitingCount} waiting`;
  return (
    <div className="service-queue-row flex min-w-0 items-center justify-between gap-2 border-t border-fg/10 pt-2 first:border-t-0 first:pt-0">
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] text-fg/90">Outing permission</span>
        <span className="service-queue-meta block truncate text-[10.5px] text-fg/45">{detail}</span>
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => onChange(!service.joined)}
        aria-label={`${service.joined ? "Leave" : "Join"} outing permission queue`}
        className="service-queue-action h-8 shrink-0 rounded-full border border-rose/50 px-3 text-[11px] text-fg/80 transition-colors hover:border-rose-light hover:text-fg disabled:cursor-wait disabled:opacity-50"
      >
        {busy ? "…" : service.joined ? "Leave" : "Join"}
      </button>
    </div>
  );
}

function ReviewQueueRow({ rank }: { rank: number }) {
  return (
    <div className="service-queue-row flex min-w-0 items-center border-t border-fg/10 pt-2 first:border-t-0 first:pt-0">
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] text-fg/90">Review queue</span>
        <span
          aria-label={`Review queue rank ${rank}`}
          className="block truncate text-[10.5px] text-fg/45"
        >
          Position {rank}
        </span>
      </span>
    </div>
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
            {live ? <span className="text-[11px] text-fg/45">{secondsLeft}s</span> : null}
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
  const reviewRank = queue?.rank ?? null;
  const hasQueueRows = model.services.length > 0 || reviewRank !== null;
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
          {reviewRank !== null && queue ? <span className="truncate text-[11px] text-fg/50">{queue.round}</span> : null}
        </div>
        {hasQueueRows ? (
          <div className="service-queue-list grid min-h-0 shrink-0 gap-2">
            {model.services.map((service) => (
              <ServiceQueueRow
                key={service.kind}
                service={service}
                busy={busyKind === service.kind}
                onChange={(joined) => void changeServiceQueue(service.kind, joined)}
              />
            ))}
            {reviewRank !== null ? <ReviewQueueRow rank={reviewRank} /> : null}
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
