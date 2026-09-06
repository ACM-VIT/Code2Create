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
