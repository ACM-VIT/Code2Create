import { LiveNumber } from "../LiveNumber";
import { useState } from "react";

import { dayTimeLabel, timeLabel } from "./format";
import { Reveal, Tile, TileEyebrow } from "./Tile";
import { hiddenWhenShort, tileBody } from "./tileClasses";
import type { Slot } from "./dashboardLayout";

export type EventPhaseView = { key: string; name: string; startsAt: number; endsAt: number };

export type EventTileModel = {
  phases: readonly EventPhaseView[];
  now: number;
  timezone: string;
};

function remainingLabel(until: number, now: number) {
  const minutes = Math.max(0, Math.round((until - now) / 60_000));
  if (minutes < 1) return "ending now";
  if (minutes < 60) return <>ends in <LiveNumber value={minutes} /> min</>;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? <>ends in <LiveNumber value={hours} />h</> : <>ends in <LiveNumber value={hours} />h <LiveNumber value={rest} />m</>;
}

/**
 * The event tile: the phase that is running, how far along it is, and what
 * comes next. A tap turns the summary into the full schedule in place.
 */
export function EventTile({ slot, model }: {
  slot: Slot; model: EventTileModel }) {
  const [open, setOpen] = useState(false);
  const { phases, now, timezone } = model;
  const current = phases.find((phase) => phase.startsAt <= now && now < phase.endsAt) ?? null;
  const next = phases.find((phase) => phase.startsAt > now) ?? null;
  const ratio = current
    ? Math.min(1, (now - current.startsAt) / (current.endsAt - current.startsAt))
    : 0;

  return (
    <Tile slot={slot} open={open} onToggle={() => setOpen((value) => !value)}>
      <div className={tileBody}>
        <div className="flex items-baseline justify-between gap-3">
          <TileEyebrow>event</TileEyebrow>
          {current ? (
            <span className="text-[11px] text-fg/50">
              {remainingLabel(current.endsAt, now)}
            </span>
          ) : null}
        </div>
        {open ? (
          <Reveal key="schedule" className="flex min-h-0 flex-col">
            {phases.map((phase) => {
              const running = phase === current;
              const past = phase.endsAt <= now;
              return (
                <div
                  key={phase.key}
                  className="flex justify-between gap-3 border-b border-rose/20 py-1.5 text-[12.5px] last:border-b-0"
                >
                  <span
                    className={running ? "text-rose-light" : past ? "text-fg/45" : "text-fg/80"}
                  >
                    {phase.name}
                    {past ? " ✓" : ""}
                  </span>
                  <span className={running ? "text-rose-light" : "text-fg/45"}>
                    {dayTimeLabel(phase.startsAt, timezone)}
                  </span>
                </div>
              );
            })}
          </Reveal>
        ) : (
          <Reveal key="summary" className="flex flex-col gap-2.5">
            <div>
              <p className="m-0 font-display text-[22px] leading-tight text-shadow-[0_6px_30px_var(--scene-text-glow)] lg:text-[26px]">
                {current ? current.name : next ? "Between phases" : "Event wrapped"}
              </p>
              <p className={`m-0 text-[12.5px] text-fg/65 ${hiddenWhenShort}`}>
                {next
                  ? `${next.name} at ${timeLabel(next.startsAt, timezone)}`
                  : current
                    ? "The last phase."
                    : "Thanks for building with us."}
              </p>
            </div>
            {current ? (
              <div className={`h-[3px] w-full overflow-hidden rounded-full bg-fg/15 ${hiddenWhenShort}`}>
                <div
                  className="h-full rounded-full bg-rose-light shadow-[0_0_12px_var(--glow-rose)]"
                  style={{ width: `${ratio * 100}%` }}
                />
              </div>
            ) : null}
          </Reveal>
        )}
      </div>
    </Tile>
  );
}
