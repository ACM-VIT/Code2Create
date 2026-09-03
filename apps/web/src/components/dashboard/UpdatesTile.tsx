import { useState } from "react";

import { PortalButton } from "../portal/PortalButton";
import { Reveal, Tile, TileEyebrow, dayTimeLabel } from "./Tile";

export type CheckpointState = "locked" | "upcoming" | "open" | "late" | "closed" | "submitted";

export type CheckpointView = {
  key: string;
  name: string;
  state: CheckpointState;
  opensAt: number;
  dueAt: number;
};

export type UpdatesTileModel = {
  available: boolean;
  checkpoints: readonly CheckpointView[];
  timezone: string;
  /** Opens the update form. */
  write: () => void;
};

const stateLabels: Record<CheckpointState, string> = {
  locked: "locked",
  upcoming: "upcoming",
  open: "open",
  late: "late",
  closed: "closed",
  submitted: "submitted",
};

function whenLine(checkpoint: CheckpointView, timezone: string) {
  if (checkpoint.state === "open" || checkpoint.state === "late")
    return `due ${dayTimeLabel(checkpoint.dueAt, timezone)}`;
  if (checkpoint.state === "upcoming" || checkpoint.state === "locked")
    return `opens ${dayTimeLabel(checkpoint.opensAt, timezone)}`;
  return stateLabels[checkpoint.state];
}

/** The updates tile: the checkpoint that matters now; a tap lists them all. */
export function UpdatesTile({ model }: { model: UpdatesTileModel }) {
  const [open, setOpen] = useState(false);
  const { checkpoints, timezone } = model;
  const primary =
    checkpoints.find((checkpoint) => checkpoint.state === "open" || checkpoint.state === "late") ??
    checkpoints.find(
      (checkpoint) => checkpoint.state === "upcoming" || checkpoint.state === "locked",
    ) ??
    checkpoints.at(-1) ??
    null;
  const writable = primary !== null && (primary.state === "open" || primary.state === "late");

  return (
    <Tile area="updates" open={open} onToggle={() => setOpen((value) => !value)}>
      <div className="flex flex-1 flex-col justify-between gap-3 p-[18px]">
        <div className="flex items-baseline justify-between gap-3">
          <TileEyebrow>updates</TileEyebrow>
          {primary ? (
            <span className="text-[11px] text-fg/50">{stateLabels[primary.state]}</span>
          ) : null}
        </div>
        {!model.available || checkpoints.length === 0 ? (
          <p className="m-0 text-[13px] leading-snug text-fg/65">
            {model.available
              ? "Team updates open once the schedule is set."
              : "Team updates open once your place is confirmed."}
          </p>
        ) : open ? (
          <Reveal key="list" className="flex flex-col">
            {checkpoints.map((checkpoint) => (
              <div
                key={checkpoint.key}
                className="flex justify-between gap-3 border-b border-rose/20 py-1.5 text-[12.5px] last:border-b-0"
              >
                <span
                  className={
                    checkpoint === primary
                      ? "text-rose-light"
                      : checkpoint.state === "submitted" || checkpoint.state === "closed"
                        ? "text-fg/45"
                        : "text-fg/80"
                  }
                >
                  {checkpoint.name}
                  {checkpoint.state === "submitted" ? " ✓" : ""}
                </span>
                <span className="text-fg/45">{whenLine(checkpoint, timezone)}</span>
              </div>
            ))}
            {writable ? (
              <div className="mt-3">
                <PortalButton size="sm" variant="solid" onClick={model.write}>
                  Write the update
                </PortalButton>
              </div>
            ) : null}
          </Reveal>
        ) : (
          <Reveal key="primary" className="flex flex-col gap-1">
            <p className="m-0 font-display text-[19px] leading-tight text-shadow-[0_6px_30px_var(--scene-text-glow)]">
              {primary!.name}
            </p>
            <p className="m-0 text-[12.5px] text-fg/65">{whenLine(primary!, timezone)}</p>
          </Reveal>
        )}
      </div>
    </Tile>
  );
}
