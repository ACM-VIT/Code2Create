import { useEffect, useRef, useState } from "react";

import { readableError } from "../../lib/errors";
import { QrTree } from "../portal/QrTree";
import { Reveal, Tile, TileEyebrow } from "./Tile";
import type { Slot } from "./dashboardLayout";
import { hiddenWhenShort, tileBody } from "./tileClasses";

export type TeamReviewCode = {
  payload: string;
  manualCode: string;
  expiresAt: number;
  serverNow: number;
};

export type ReviewTileModel = {
  available: boolean;
  queue: {
    round: string;
    /** The participant-facing state label. */
    state: string;
    /** Teams ahead, the panel, the table: one short line. */
    detail: string | null;
    wait: string | null;
    reviewers: { present: number; total: number } | null;
  } | null;
  /** Mints the team's review code; present only while reviewers are due. */
  showCode: { sessionId: string; mint: () => Promise<TeamReviewCode> } | null;
};

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
 * The review tile: where the team stands in the round. While reviewers are
 * due it becomes the team's code; otherwise a tap shows the wait and who has
 * checked in.
 */
export function ReviewTile({ slot, model }: { slot: Slot; model: ReviewTileModel }) {
  const [open, setOpen] = useState(false);
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
  const hasMore = queue !== null && (queue.wait !== null || queue.reviewers !== null);

  return (
    <Tile slot={slot} open={open && hasMore} onToggle={() => setOpen((value) => !value)}>
      <div className={tileBody}>
        <div className="flex items-baseline justify-between gap-3">
          <TileEyebrow>review</TileEyebrow>
          {queue ? <span className="truncate text-[11px] text-fg/50">{queue.round}</span> : null}
        </div>
        {!model.available ? (
          <p className="m-0 text-[13px] leading-snug text-fg/65">Reviews open once your place is confirmed.</p>
        ) : queue === null ? (
          <p className="m-0 text-[13px] leading-snug text-fg/65">No review round is open. This card fills in when one starts.</p>
        ) : (
          <Reveal key={open ? "facts" : "summary"} className="flex min-h-0 flex-col gap-1 overflow-y-auto [scrollbar-width:thin]">
            <p className="m-0 font-display text-[19px] leading-tight text-shadow-[0_6px_30px_var(--scene-text-glow)]">{queue.state}</p>
            {queue.detail ? <p className={`m-0 text-[12.5px] text-fg/65 ${hiddenWhenShort}`}>{queue.detail}</p> : null}
            {open && queue.wait ? <p className="m-0 text-[12.5px] text-fg/65">{queue.wait}</p> : null}
            {open && queue.reviewers ? (
              <p className="m-0 text-[12.5px] text-fg/65">
                {queue.reviewers.present} of {queue.reviewers.total} reviewers checked in
              </p>
            ) : null}
          </Reveal>
        )}
      </div>
    </Tile>
  );
}
