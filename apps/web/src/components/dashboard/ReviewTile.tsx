import type { ReviewSessionStatus, TeamRoundState } from "@code2create/domain";
import { useEffect, useState, type ReactNode } from "react";

import { readableError } from "../../lib/errors";
import { queueWaitRange } from "../../lib/time";
import { LiveNumber } from "../LiveNumber";
import { Flower } from "../portal/FlowerAvatar";
import { PortalButton } from "../portal/PortalButton";
import { QrTree } from "../portal/QrTree";
import type { TeamReviewCodeRequest } from "./ReviewCode";
import { Tile, TileEyebrow } from "./Tile";
import type { Slot } from "./dashboardLayout";
import { hiddenWhenShort } from "./tileClasses";

export type ReviewTileModel = {
  round: string;
  state: TeamRoundState;
  paused: boolean;
  upNext: boolean;
  panel: string | null;
  rank: number | null;
  notice: string | null;
  estimate: { earliestAt: number; latestAt: number; basis: "configured" | "observed" } | null;
  now: number;
  session: { status: ReviewSessionStatus; present: number; total: number } | null;
  showCode: TeamReviewCodeRequest | null;
};

/** One line per state; a second line only where the team has to do something. */
function reviewCopy(state: TeamRoundState, panel: string | null): { title: string; detail: string | null } {
  const table = panel ? `${panel}’s table` : "your panel’s table";
  switch (state) {
    case "unassigned":
      return { title: "Your review is being arranged", detail: null };
    case "queued":
      return { title: "You’re in line", detail: null };
    case "called":
      return { title: "Your panel is ready for you", detail: `Head to ${table}.` };
    case "at_table":
      return { title: "You’re at the table", detail: null };
    case "in_review":
      return { title: "Review in progress", detail: null };
    case "completed":
      return { title: "Review complete", detail: null };
    case "held":
      return { title: "Your review is on hold", detail: "Check with the review desk." };
    case "missed":
      return { title: "You missed your call", detail: "Contact the review desk to rejoin." };
    case "skipped":
      return { title: "Review skipped", detail: null };
    case "withdrawn":
      return { title: "Your review was withdrawn", detail: null };
  }
}

/** The panel's reviewers around the table, lit as they check in. */
function RingGlyph({
  total,
  present,
  dim,
  centre,
}: {
  total: number;
  present: number;
  /** No session yet: the reviewers are placeholders, evenly faded. */
  dim: boolean;
  centre: ReactNode;
}) {
  return (
    <div className="relative h-full w-full">
      <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full overflow-visible motion-safe:animate-sway" aria-hidden>
        <circle cx="100" cy="100" r="66" fill="none" className="stroke-rose/30" strokeWidth=".8" strokeDasharray="2 5" />
        {Array.from({ length: total }, (_, index) => {
          const angle = ((index * 360) / total - 90) * (Math.PI / 180);
          const x = 100 + 66 * Math.cos(angle);
          const y = 100 + 66 * Math.sin(angle);
          const here = index < present;
          return (
            <g
              key={index}
              transform={`translate(${x} ${y})`}
              className={`transition-opacity duration-700 ${dim ? "opacity-60" : here ? "opacity-100" : "opacity-25"}`}
            >
              <circle r="19" fill="var(--color-avatar)" className={here && !dim ? "stroke-rose-light" : "stroke-rose/45"} strokeWidth="1" />
              <g transform="translate(-13 -13)">
                <Flower seed={`reviewer-${index}`} variant={index} size={26} />
              </g>
            </g>
          );
        })}
      </svg>
      <div aria-hidden className="absolute inset-0 flex items-center justify-center">
        {centre}
      </div>
    </div>
  );
}

type TeamReviewCode = Awaited<ReturnType<TeamReviewCodeRequest["mint"]>> & { receivedAt: number };

function useSecondsLeft(code: TeamReviewCode | null) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!code) return;
    const timer = window.setInterval(() => setNow(performance.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [code]);
  if (!code) return 0;
  const elapsed = Math.max(0, now - code.receivedAt);
  return Math.max(0, Math.ceil((code.expiresAt - code.serverNow - elapsed) / 1_000));
}

/**
 * A tap requests a scannable code; subsequent taps toggle its tree form.
 * Viewing another teammate's dashboard must not replace the shared token.
 */
function ReviewCodeCard({
  slot,
  model,
  request,
}: {
  slot: Slot;
  model: ReviewTileModel;
  request: TeamReviewCodeRequest;
}) {
  const [code, setCode] = useState<TeamReviewCode | null>(null);
  const [flat, setFlat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secondsLeft = useSecondsLeft(code);
  const live = code && secondsLeft > 0 ? code : null;
  const copy = reviewCopy(model.state, model.panel);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const minted = await request.mint();
      setCode({ ...minted, receivedAt: performance.now() });
      setFlat(true);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const onToggle = () => {
    if (busy) return;
    if (live) setFlat((value) => !value);
    else void refresh();
  };

  const detail = copy.detail ?? model.notice ?? model.panel;
  const notice = model.notice !== detail ? model.notice : null;

  return (
    <Tile slot={slot} open={flat} onToggle={onToggle}>
      <div className="pointer-events-none flex min-h-0 flex-1 flex-col gap-3 p-[18px] @min-[600px]:grid @min-[600px]:grid-cols-[minmax(0,1fr)_minmax(200px,40%)] @min-[600px]:gap-6 @min-[600px]:p-6">
        <div className="flex min-w-0 shrink-0 flex-col gap-3 @min-[600px]:min-h-0 @min-[600px]:justify-between">
          <div className="flex items-baseline justify-between gap-3">
            <TileEyebrow>review</TileEyebrow>
            <span className="truncate text-[11px] text-fg/50">{model.round}</span>
          </div>
          <div>
            <h2
              aria-live="polite"
              className="m-0 max-w-[20ch] font-display text-[22px] font-normal leading-[1.15] tracking-[-.025em] text-balance text-fg @min-[600px]:text-[30px]"
            >
              {copy.title}
            </h2>
            {detail ? (
              <p className="m-0 mt-2 max-w-[44ch] text-[12px] leading-relaxed text-fg/60">{detail}</p>
            ) : null}
            {notice ? (
              <p className="m-0 mt-2 max-w-[44ch] text-[12px] leading-relaxed text-fg/60">{notice}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {error ? (
              <span className="text-[12.5px] text-rose-light">{error}</span>
            ) : live ? (
              <>
                <span className="inline-flex items-center rounded-full border border-petal-edge-soft bg-wash/40 px-3.5 py-1.5 font-mono text-[13px] tracking-[.14em] text-fg">
                  {live.manualCode}
                </span>
                <span aria-label={`Review code expires in ${secondsLeft} seconds`} className="text-[11.5px] tabular-nums text-fg/45">
                  <LiveNumber value={secondsLeft} />s left
                </span>
              </>
            ) : (
              <>
                <PortalButton size="xs" className="pointer-events-auto" onClick={onToggle} disabled={busy}>
                  {busy ? "Making your code…" : "Show review code"}
                </PortalButton>
                {code ? <span className="text-[11.5px] text-fg/45">The last one expired.</span> : null}
              </>
            )}
          </div>
        </div>
        <div className="relative min-h-[140px] flex-1 @min-[600px]:min-h-0">
          {live ? (
            <QrTree value={live.payload} size="fill" flat={flat} label="Team review code" />
          ) : (
            <div aria-hidden className="absolute inset-0 flex items-center justify-center">
              <Flower seed="review" className="size-14 opacity-30 @min-[600px]:size-20" />
            </div>
          )}
        </div>
      </div>
    </Tile>
  );
}

/**
 * The team's review has its own home; service queues stay in their own tile.
 * While reviewers are due the whole card becomes the team's review code.
 */
export function ReviewTile({ slot, model }: { slot: Slot; model: ReviewTileModel }) {
  if (model.showCode) {
    return (
      <ReviewCodeCard
        key={model.showCode.sessionId}
        slot={slot}
        model={model}
        request={model.showCode}
      />
    );
  }
  return <ReviewStatusTile slot={slot} model={model} />;
}

function ReviewStatusTile({ slot, model }: { slot: Slot; model: ReviewTileModel }) {
  const scoring = model.session?.status === "scoring";
  const paused = model.paused && model.state === "queued";
  const upNext = model.upNext && model.state === "queued" && !paused;
  const copy = scoring
    ? { title: "Your part is done", detail: null }
    : paused
      ? { title: "Reviews are paused", detail: null }
      : upNext
        ? { title: "You’re up next", detail: null }
        : reviewCopy(model.state, model.panel);
  const waiting = model.state === "queued" && !paused;
  const estimate = waiting && model.estimate ? queueWaitRange(model.estimate, model.now) : null;
  const checkingIn = model.session?.status === "awaiting_presence";
  const total = model.session?.total ?? 5;
  const present = model.session?.present ?? 0;
  const position = model.state === "queued" ? model.rank : null;
  const detail = checkingIn
    ? "Ask a teammate to show the review code."
    : (model.notice ?? copy.detail);
  const atTable = model.session !== null && (checkingIn || model.state === "in_review" || scoring);

  const meta: ReactNode[] = [];
  if (waiting) {
    meta.push(
      <span key="wait">
        {estimate ? (
          estimate.lower === 0 ? (
            <>
              within <LiveNumber value={estimate.upper} /> min
            </>
          ) : (
            <>
              <LiveNumber value={estimate.lower} />–<LiveNumber value={estimate.upper} /> min
            </>
          )
        ) : model.estimate ? (
          "taking a little longer"
        ) : (
          "estimating your wait"
        )}
      </span>,
    );
  }
  if (model.panel) meta.push(<span key="panel">{model.panel}</span>);

  const glyphLabel = paused
    ? "Reviews paused"
    : waiting && position !== null
      ? `Your place in the review line: ${position}`
      : atTable
        ? `${present} of ${total} reviewers at your table`
        : copy.title;

  return (
    <Tile slot={slot}>
      <section
        aria-label="Project review"
        className="flex min-h-full flex-col gap-3 p-[18px] @min-[600px]:gap-4 @min-[600px]:p-6"
      >
        <header className="flex min-w-0 items-baseline justify-between gap-4">
          <TileEyebrow>review</TileEyebrow>
          <span className="truncate text-[11px] text-fg/50" title={model.round}>
            {model.round}
          </span>
        </header>

        <div className="grid flex-1 grid-cols-1 items-center gap-3 @min-[420px]:grid-cols-[minmax(0,1fr)_128px] @min-[420px]:gap-6 @min-[600px]:grid-cols-[minmax(0,1fr)_168px]">
          <div className="min-w-0">
            <h2
              aria-live="polite"
              aria-atomic="true"
              className="m-0 max-w-[20ch] font-display text-[22px] font-normal leading-[1.15] tracking-[-.025em] text-balance text-fg @min-[600px]:text-[30px]"
            >
              {copy.title}
            </h2>
            {detail ? (
              <p className="m-0 mt-2 max-w-[44ch] text-[11.5px] leading-relaxed text-fg/60">{detail}</p>
            ) : null}
            {meta.length > 0 ? (
              <p className="m-0 mt-3 text-[11.5px] tabular-nums text-fg/55">
                {meta.map((item, index) => (
                  <span key={index}>
                    {index > 0 ? " · " : ""}
                    {item}
                  </span>
                ))}
              </p>
            ) : null}
          </div>

          <div
            className={`${hiddenWhenShort} relative mx-auto aspect-square w-full max-w-[168px]`}
            role="img"
            aria-label={glyphLabel}
          >
            <RingGlyph
              total={total}
              present={present}
              dim={model.session === null}
              centre={
                paused ? (
                  <span className="font-display text-[26px] font-light tracking-[.1em] text-rose-light @min-[600px]:text-[36px]">Ⅱ</span>
                ) : position !== null ? (
                  <span className="font-display text-[30px] font-light leading-none tracking-[-.05em] text-rose-light @min-[600px]:text-[44px]">
                    <LiveNumber value={position} format={{ minimumIntegerDigits: 2, useGrouping: false }} />
                  </span>
                ) : scoring ? (
                  <svg viewBox="0 0 24 24" className="size-8 text-rose-light" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m5 12.5 4.5 4.5L19 7" />
                  </svg>
                ) : checkingIn ? (
                  <span className="font-display text-[26px] font-light leading-none text-rose-light @min-[600px]:text-[34px]">
                    <LiveNumber value={present} />
                    <span className="ml-0.5 text-[12px] text-fg/45 @min-[600px]:text-[15px]">/{total}</span>
                  </span>
                ) : (
                  <Flower seed="review" lead={model.state === "in_review" || model.state === "completed"} className="size-8 @min-[600px]:size-11" />
                )
              }
            />
          </div>
        </div>
      </section>
    </Tile>
  );
}
