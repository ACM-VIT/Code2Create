import { api } from "@code2create/backend/api";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";

import type { EventPhaseView } from "../components/dashboard/EventTile";
import { timeLabel } from "../components/dashboard/format";
import { LiveNumber } from "../components/LiveNumber";
import { OutlineHeading } from "../components/portal/OutlineHeading";
import { PortalScene } from "../components/portal/PortalScene";
import { eventSlug } from "../lib/config";
import { thumbnailUrl } from "../lib/music";
import type { PublicState } from "../types";

export type VenueDisplay = FunctionReturnType<typeof api.venueDisplay.state>;

export type VenueEvent = {
  timezone: string;
  phases: readonly EventPhaseView[];
};

const twoDigits = { minimumIntegerDigits: 2, useGrouping: false } as const;

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** The venue screen, wired to the live event. Reachable at /display without a sign-in. */
export function DisplayScreen({ publicState }: { publicState: PublicState }) {
  const display = useQuery(api.venueDisplay.state, { eventSlug });
  const now = useNow();
  const event = publicState.event;
  return (
    <DisplayView
      event={{
        timezone: event?.timezone ?? "UTC",
        phases: (event?.phases ?? []).map((phase) => ({
          key: phase.phaseKey,
          name: phase.displayName,
          startsAt: phase.startsAt,
          endsAt: phase.endsAt,
        })),
      }}
      display={display ?? null}
      now={now}
    />
  );
}

function Progress({
  startedAt,
  durationSeconds,
  now,
}: {
  startedAt: number | undefined;
  durationSeconds: number;
  now: number;
}) {
  const ratio =
    startedAt === undefined || durationSeconds <= 0
      ? 0
      : Math.min(1, (now - startedAt) / 1_000 / durationSeconds);
  return (
    <div className="h-[0.2vw] w-full overflow-hidden rounded-full bg-fg/15">
      <div
        className="h-full rounded-full bg-rose-light transition-[width] duration-1000 ease-linear"
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}

/**
 * The venue screen: the event's mark and wordmark, the running phase with
 * its countdown, and what is on the speakers. Sized in viewport units so a
 * 1080p wall and a 4K one read the same from across the hall. Chill mode's
 * ball hangs over this screen too, since that layer sits above every route.
 */
export function DisplayView({
  event,
  display,
  now,
}: {
  event: VenueEvent;
  display: VenueDisplay | null;
  now: number;
}) {
  const current = event.phases.find((phase) => phase.startsAt <= now && now < phase.endsAt) ?? null;
  const next = event.phases.find((phase) => phase.startsAt > now) ?? null;
  const target = current ? current.endsAt : (next?.startsAt ?? null);
  const remaining = target === null ? 0 : Math.max(0, target - now);
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor(remaining / 60_000) % 60;
  const seconds = Math.floor(remaining / 1_000) % 60;
  const headline = current ? current.name : next ? next.name : "That’s a wrap";
  const music = display?.music ?? null;
  const playing = music?.nowPlaying ?? null;
  const review = display?.review ?? null;

  if (review && review.panels.length > 0) {
    // The round's own end time rules the wall; the phase schedule can lag desk changes.
    return (
      <PanelWall
        event={event}
        review={review}
        headline={review.roundName}
        target={review.endsAt}
        remaining={Math.max(0, review.endsAt - now)}
        now={now}
        music={music}
      />
    );
  }

  return (
    <PortalScene tree="both" logo="none" fill>
      <div className="relative flex h-full w-full cursor-none flex-col items-center justify-center text-center">
        <p className="absolute top-0 right-0 m-0 font-display text-[2vw] font-light tabular-nums text-fg/70">
          {timeLabel(now, event.timezone)}
        </p>

        <img
          src="/assets/logo.svg"
          alt=""
          className="mb-[1.6vw] w-[6vw] drop-shadow-[0_0_28px_var(--logo-glow)]"
        />
        <h1 className="m-0 mb-[2.4vw] flex justify-center">
          <img
            src="/assets/wordmark.svg"
            alt="Code2Create"
            className="h-[7.5vw] w-auto [filter:var(--wordmark-filter)]"
          />
        </h1>

        {/* The phase name in outline letters, sized to its length so any name fits. */}
        <div className="display-headline" style={{ ["--letters" as string]: headline.length }}>
          <OutlineHeading word={headline} />
        </div>
        {target !== null ? (
          <>
            <p className="m-0 mt-[1vw] font-display text-[6.4vw] font-light leading-none tracking-[-.03em] tabular-nums text-fg text-shadow-[0_6px_50px_var(--scene-text-glow)]">
              <LiveNumber value={hours} />
              <span className="text-[2.4vw] text-fg/55">h </span>
              <LiveNumber value={minutes} format={twoDigits} />
              <span className="text-[2.4vw] text-fg/55">m </span>
              <LiveNumber value={seconds} format={twoDigits} />
              <span className="text-[2.4vw] text-fg/55">s</span>
            </p>
            <p className="m-0 mt-[1.2vw] text-[1.5vw] text-fg/55">
              {current
                ? `until ${timeLabel(current.endsAt, event.timezone)}`
                : `starts at ${timeLabel(next?.startsAt ?? now, event.timezone)}`}
              {current && next ? <span className="text-fg/40"> · then {next.name}</span> : null}
            </p>
          </>
        ) : (
          <p className="m-0 mt-[1.2vw] text-[1.6vw] text-fg/55">thank you for building with us</p>
        )}


        {music ? (
          <div className="absolute bottom-0 left-0 flex max-w-[46vw] items-center gap-[1.2vw] text-left">
            <span className="size-[5.4vw] shrink-0 overflow-hidden rounded-[0.7vw] bg-avatar">
              {playing?.videoId ? (
                <img
                  src={thumbnailUrl(playing.videoId, "mq")}
                  alt=""
                  className="size-full object-cover"
                />
              ) : null}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-[0.6vw]">
              <p className="m-0 text-[1.05vw] text-rose-light">
                {music.playbackPaused ? "paused by the desk" : "on the speakers"}
              </p>
              <p className="m-0 line-clamp-2 font-display text-[1.7vw] leading-tight text-fg">
                {playing ? playing.title : "Nothing playing yet."}
              </p>
              {playing ? (
                <Progress
                  startedAt={playing.playbackStartedAt}
                  durationSeconds={playing.durationSeconds}
                  now={now}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </PortalScene>
  );
}

type PanelView = NonNullable<VenueDisplay["review"]>["panels"][number];

/**
 * While a round is open the wall is about the panels: the countdown shrinks
 * to one line and each panel shows, in letters readable from the back of the
 * hall, who is at its table, who has been called, and who is next.
 */
function PanelWall({
  event,
  review,
  headline,
  target,
  remaining,
  now,
  music,
}: {
  event: VenueEvent;
  review: NonNullable<VenueDisplay["review"]>;
  headline: string;
  target: number | null;
  remaining: number;
  now: number;
  music: NonNullable<VenueDisplay>["music"];
}) {
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor(remaining / 60_000) % 60;
  const seconds = Math.floor(remaining / 1_000) % 60;
  const playing = music?.nowPlaying ?? null;
  return (
    <PortalScene tree="both" logo="none" fill>
      <div className="relative flex h-full w-full cursor-none flex-col px-[3vw] py-[2vw] text-left">
        <header className="flex items-center justify-between gap-[2vw]">
          <img
            src="/assets/wordmark.svg"
            alt="Code2Create"
            className="h-[3.2vw] w-auto shrink-0 [filter:var(--wordmark-filter)]"
          />
          <p className="m-0 min-w-0 flex-1 truncate text-center font-display text-[1.7vw] font-light text-fg/80">
            <span className="text-fg">{headline}</span>
            {target !== null ? (
              <>
                <span className="text-fg/45"> · </span>
                <span className="tabular-nums">
                  <LiveNumber value={hours} />h <LiveNumber value={minutes} format={twoDigits} />m{" "}
                  <LiveNumber value={seconds} format={twoDigits} />s
                </span>
                <span className="text-fg/45"> until {timeLabel(target, event.timezone)}</span>
              </>
            ) : null}
          </p>
          <p className="m-0 shrink-0 font-display text-[1.7vw] font-light tabular-nums text-fg/70">
            {timeLabel(now, event.timezone)}
          </p>
        </header>

        <p className="m-0 mt-[1.4vw] mb-[0.8vw] text-[1.4vw] text-rose-light">
          {review.roundName} · which team goes where
        </p>
        <div className="grid flex-1 grid-cols-3 grid-rows-3 gap-[1.2vw]">
          {review.panels.map((panel) => (
            <PanelCard key={panel.name} panel={panel} />
          ))}
        </div>

        {music && playing ? (
          <p className="m-0 mt-[1vw] truncate text-[1.1vw] text-fg/55">
            <span className="text-rose-light">{music.playbackPaused ? "paused" : "on the speakers"}</span>
            {" · "}
            {playing.title}
          </p>
        ) : null}
      </div>
    </PortalScene>
  );
}

/** One panel, large: the team at the table leads, then who was called and who is next. */
function PanelCard({ panel }: { panel: PanelView }) {
  const atTable = panel.inReview[0] ?? null;
  const called = panel.called[0] ?? null;
  const next = panel.upNext.find((name) => name !== called) ?? null;
  return (
    <div className="flex min-w-0 flex-col justify-between rounded-[0.8vw] bg-fg/[0.06] px-[1.4vw] py-[1vw]">
      <p className="m-0 text-[1.25vw] text-rose-light">{panel.name}</p>
      <p className="m-0 line-clamp-2 font-display text-[2.3vw] leading-tight text-fg">
        {atTable ?? (called ? called : "Free")}
        {!atTable && called ? (
          <span className="block text-[1.2vw] text-rose-light">come to the table</span>
        ) : null}
      </p>
      <div className="flex flex-col gap-[0.2vw] leading-snug">
        {atTable && called ? (
          <p className="m-0 truncate text-[1.25vw] text-rose-light">called · {called}</p>
        ) : null}
        <p className="m-0 truncate text-[1.7vw] text-fg/70">
          {next ? (
            <>
              <span className="text-fg/45">next · </span>
              <span className="text-fg">{next}</span>
            </>
          ) : (
            "queue empty"
          )}
        </p>
      </div>
    </div>
  );
}
