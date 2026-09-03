import { useState } from "react";

import { Reveal, Tile, TileEyebrow, dayTimeLabel, timeLabel } from "./Tile";

export type EventPhaseView = { key: string; name: string; startsAt: number; endsAt: number };

export type EventTileModel = {
  phases: readonly EventPhaseView[];
  now: number;
  timezone: string;
};

/**
 * The event tile: the phase that is running, how far along it is, and what
 * comes next. A tap turns the summary into the full schedule in place.
 */
export function EventTile({ model }: { model: EventTileModel }) {
  const [open, setOpen] = useState(false);
  const { phases, now, timezone } = model;
  const current = phases.find((phase) => phase.startsAt <= now && now < phase.endsAt) ?? null;
  const next = phases.find((phase) => phase.startsAt > now) ?? null;
  const ratio = current
    ? Math.min(1, (now - current.startsAt) / (current.endsAt - current.startsAt))
    : 0;

  return (
    <Tile area="status" open={open} onToggle={() => setOpen((value) => !value)}>
      <div className="flex flex-1 flex-col justify-between gap-3 p-[18px]">
        <div className="flex items-baseline justify-between gap-3">
          <TileEyebrow>event</TileEyebrow>
          {current ? (
            <span className="text-[11px] text-fg/50">
              ends {timeLabel(current.endsAt, timezone)}
            </span>
          ) : null}
        </div>
        {open ? (
          <Reveal key="schedule" className="flex flex-col">
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
              <p className="m-0 text-[12.5px] text-fg/65">
                {next
                  ? `${next.name} at ${timeLabel(next.startsAt, timezone)}`
                  : current
                    ? "The last phase."
                    : "Thanks for building with us."}
              </p>
            </div>
            {current ? (
              <div className="h-[3px] w-full overflow-hidden rounded-full bg-fg/15">
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
