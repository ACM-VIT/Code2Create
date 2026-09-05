import type { ReviewSessionStatus, TeamRoundState } from "@code2create/domain";
import { useState } from "react";

import { queueWaitRange } from "../../lib/time";
import { LiveNumber } from "../LiveNumber";
import { Flower } from "../portal/FlowerAvatar";
import { ReviewCode, type TeamReviewCodeRequest } from "./ReviewCode";
import { Tile, TileEyebrow } from "./Tile";
import type { Slot } from "./dashboardLayout";

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

const reviewCopy: Record<TeamRoundState, { title: string; detail: string | null }> = {
  unassigned: { title: "Your review is being arranged", detail: "The review desk will assign your team a panel." },
  queued: { title: "You’re in line", detail: null },
  called: { title: "Your panel is on its way", detail: "Keep your team at your table and have your demo ready." },
  at_table: { title: "Your panel is here", detail: "Once everyone has checked in, your reviewers will start the discussion." },
  in_review: { title: "Review in progress", detail: "Walk your panel through what you built. This is your time to show it." },
  completed: { title: "Review complete", detail: "Thanks for sharing your work. Your panel has finished scoring." },
  held: { title: "Your review is on hold", detail: "Check with the review desk before leaving your table." },
  missed: { title: "Let’s get you back in line", detail: "Your team missed its call. Contact the review desk to rejoin." },
  withdrawn: { title: "Your review was withdrawn", detail: "Contact the review desk if this was unexpected." },
};

/** The team's review has its own home; service queues stay in their own tile. */
export function ReviewTile({ slot, model }: { slot: Slot; model: ReviewTileModel }) {
  const [codeSessionId, setCodeSessionId] = useState<string | null>(null);
  const scoring = model.session?.status === "scoring";
  const paused = model.paused && model.state === "queued";
  const upNext = model.upNext && model.state === "queued" && !paused;
  const copy = scoring
    ? { title: "Your part is done", detail: "Your panel is finishing their scorecards. No more presenting needed." }
    : paused
      ? { title: "Reviews are paused", detail: "Your place is saved. Stay nearby; this card will update when reviews resume." }
      : upNext
        ? { title: "You’re up next", detail: "Bring your team together at your table and get your demo ready." }
        : reviewCopy[model.state];
  const waiting = model.state === "queued" && !paused;
  const estimate = waiting && model.estimate ? queueWaitRange(model.estimate, model.now) : null;
  const checkingIn = model.session?.status === "awaiting_presence";
  const petals = model.session?.total ?? 5;
  const checkedIn = model.session?.present ?? 0;
  const position = model.state === "queued" ? model.rank : null;
  const showCode = model.showCode;
  const detail = checkingIn && !showCode
    ? "Ask a teammate to show the review code when your panel arrives."
    : model.notice ?? copy.detail;
  const emblemLabel = paused ? "on pause" : position !== null ? "your place" : checkingIn ? "checked in" : scoring ? "scoring" : model.state === "in_review" ? "in review" : "your review";

  return (
    <Tile slot={slot}>
      <section aria-label="Project review" className="flex min-h-full flex-col justify-between gap-3.5 p-[18px] @min-[600px]:gap-4 @min-[600px]:p-6">
        <header className="flex min-w-0 items-baseline justify-between gap-4">
          <TileEyebrow>review</TileEyebrow>
          <span className="truncate text-[11px] text-fg/50" title={model.round}>{model.round}</span>
        </header>

        <div className="grid flex-1 grid-cols-[minmax(0,1fr)_110px] items-center gap-2 @min-[360px]:grid-cols-[minmax(0,1fr)_150px] @min-[560px]:grid-cols-[minmax(0,1fr)_180px] @min-[560px]:gap-6">
          <div className="min-w-0 py-2">
            <h2 aria-live="polite" aria-atomic="true" className="m-0 max-w-[18ch] font-display text-[23px] font-normal leading-[1.18] tracking-[-.025em] text-balance text-fg @min-[600px]:text-[32px]">{copy.title}</h2>
            {waiting ? (
              <div className="mt-3">
                <p className="m-0 font-display text-[23px] leading-tight tracking-[-.025em] text-rose-light @min-[560px]:text-[30px]">
                  {estimate ? <>{estimate.lower === 0 ? <span className="mr-1 text-[12px] tracking-normal">within</span> : null}<LiveNumber value={estimate.lower === 0 ? estimate.upper : estimate.lower} />{estimate.lower > 0 ? <>–<LiveNumber value={estimate.upper} /></> : null}<span className="ml-1 text-[13px] tracking-normal">min</span></> : <span className="text-[14px] tracking-normal">{model.estimate ? "Taking a little longer" : "Estimating your wait"}</span>}
                </p>
                <p className="m-0 mt-1 text-[10px] text-fg/50">{model.estimate?.basis === "observed" ? "Based on the panel’s pace" : "Estimated wait"}</p>
              </div>
            ) : showCode && checkingIn ? (
              <button type="button" onClick={() => setCodeSessionId(showCode.sessionId)} className="mt-4 w-fit cursor-pointer rounded-full border border-rose/60 bg-transparent px-3.5 py-2.5 text-[11px] font-medium text-fg/85 transition-colors hover:border-rose-light hover:text-rose-light focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-rose-light @min-[560px]:px-5 @min-[560px]:text-[12px]">
                Show review code <span aria-hidden className="ml-1">↗</span>
              </button>
            ) : null}
            {detail ? <p className="m-0 mt-4 max-w-[40ch] text-[11px] leading-relaxed text-fg/60">{detail}</p> : null}
          </div>

          <div className="relative mx-auto aspect-square w-full max-w-[180px]" role="img" aria-label={position !== null ? `Your place in the review queue: ${position}` : checkingIn ? `${checkedIn} of ${petals} reviewers checked in` : emblemLabel}>
            <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full overflow-visible motion-safe:animate-sway" aria-hidden>
              <circle cx="100" cy="100" r="66" fill="none" className="stroke-rose/30" strokeWidth=".8" strokeDasharray="2 5" />
              {Array.from({ length: petals }, (_, index) => {
                const angle = (index * 360 / petals - 90) * Math.PI / 180;
                const x = 100 + 66 * Math.cos(angle);
                const y = 100 + 66 * Math.sin(angle);
                const present = index < checkedIn;
                return (
                  <g key={index} transform={`translate(${x} ${y})`} className={`transition-opacity duration-700 ${model.session ? present ? "opacity-100" : "opacity-25" : "opacity-70"}`}>
                    <circle r="19" fill="var(--color-avatar)" className={present ? "stroke-rose-light" : "stroke-rose/45"} strokeWidth="1" />
                    <g transform="translate(-13 -13)"><Flower seed={`reviewer-${index}`} variant={index} size={26} /></g>
                  </g>
                );
              })}
            </svg>
            <div aria-hidden className="absolute inset-0 flex flex-col items-center justify-center pt-1">
              {paused ? <span className="font-display text-[26px] font-light tracking-[.1em] text-rose-light @min-[560px]:text-[38px]">Ⅱ</span> : position !== null ? (
                <span className="font-display text-[30px] font-light leading-none tracking-[-.05em] text-rose-light @min-[360px]:text-[40px] @min-[560px]:text-[50px]"><LiveNumber value={position} format={{ minimumIntegerDigits: 2, useGrouping: false }} /></span>
              ) : checkingIn ? <span className="font-display text-[23px] font-light leading-none text-rose-light @min-[360px]:text-[30px] @min-[560px]:text-[38px]"><LiveNumber value={checkedIn} /><span className="ml-0.5 text-[12px] text-fg/45 @min-[560px]:text-[18px]">/{petals}</span></span> : <Flower seed="review" lead className="size-7 @min-[360px]:size-10 @min-[560px]:size-12" />}
            </div>
            <span aria-hidden className="absolute inset-x-0 bottom-0 text-center text-[9px] text-fg/55 @min-[560px]:text-[11px]">{emblemLabel}{model.panel ? <> · {model.panel}</> : null}</span>
          </div>
        </div>

      </section>
      {model.showCode && codeSessionId === model.showCode.sessionId && checkingIn ? <ReviewCode key={model.showCode.sessionId} round={model.round} request={model.showCode} onClose={() => setCodeSessionId(null)} /> : null}
    </Tile>
  );
}
