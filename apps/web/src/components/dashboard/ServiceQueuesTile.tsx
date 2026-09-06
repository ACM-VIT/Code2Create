import { useState, type ReactNode } from "react";

import { readableError } from "../../lib/errors";
import { LiveNumber } from "../LiveNumber";
import { Tile, TileEyebrow } from "./Tile";
import type { Slot } from "./dashboardLayout";
import { hiddenWhenShort, tileBody } from "./tileClasses";

export type ServiceQueueKind = "outing_permission";
export type ServiceQueueView = {
  kind: ServiceQueueKind;
  joined: boolean;
  position: number | null;
  waitingCount: number;
};
export type ServiceQueuesTileModel = {
  available: boolean;
  services: readonly ServiceQueueView[];
  setServiceQueue: (kind: ServiceQueueKind, joined: boolean) => Promise<void>;
};

/** The lane draws this many places; a longer line spills into a "+n". */
export const QUEUE_LANE_CAPACITY = 15;

function SakuraBlossom() {
  return (
    <svg viewBox="0 0 32 32" className="h-full w-full overflow-visible" aria-hidden>
      <circle
        className="queue-ring"
        cx="16"
        cy="16"
        r="15"
        fill="none"
        stroke="currentColor"
        strokeWidth=".9"
        strokeDasharray="2 3.2"
      />
      <g fill="currentColor" stroke="currentColor" strokeWidth=".55" strokeLinejoin="round">
        <path d="M16 15.5C12.8 13.8 10.4 10.4 11.2 7.4 11.8 5.1 13.7 3.4 16 2.6c2.3.8 4.2 2.5 4.8 4.8.8 3-1.6 6.4-4.8 8.1Z" />
        <path d="M17 16.1c.6-3.6 2.9-7.1 6-7.3 2.4-.2 4.6 1.1 6 3.1-.1 2.5-1.2 4.7-3.3 5.9-2.7 1.6-6.6.6-8.7-1.7Z" />
        <path d="M16.6 17.1c3.6-.5 7.5.7 8.6 3.6.9 2.2.3 4.7-1.2 6.6-2.4.7-4.8.3-6.6-1.3-2.4-2.1-2.5-6.1-.8-8.9Z" />
        <path d="M15.4 17.1c1.7 2.8 1.6 6.8-.8 8.9-1.8 1.6-4.2 2-6.6 1.3-1.5-1.9-2.1-4.4-1.2-6.6 1.1-2.9 5-4.1 8.6-3.6Z" />
        <path d="M15 16.1c-2.1 2.3-6 3.3-8.7 1.7-2.1-1.2-3.2-3.4-3.3-5.9 1.4-2 3.6-3.3 6-3.1 3.1.2 5.4 3.7 6 7.3Z" />
      </g>
      <circle cx="16" cy="16" r="2.15" fill="var(--color-wash)" opacity=".68" />
      <circle cx="16" cy="16" r=".9" fill="currentColor" />
    </svg>
  );
}

function laneLabel(service: ServiceQueueView) {
  if (service.joined) {
    const position = service.position ?? 1;
    return position === 1
      ? "You are first in the outing permission queue"
      : `You are number ${position} of ${service.waitingCount} in the outing permission queue`;
  }
  if (service.waitingCount === 0) return "The outing permission queue is empty";
  return `${service.waitingCount} ${service.waitingCount === 1 ? "person is" : "people are"} waiting for outing permission`;
}

/**
 * Fifteen places in a row. A place is free, taken, or yours; every change is
 * a CSS transition on transform, opacity and colour, staggered by index so a
 * line that shifts reads as people moving up. Nothing animates while the
 * card is idle, and no filters run under the tile's blur.
 */
function QueueLane({ service }: { service: ServiceQueueView }) {
  const selfIndex = service.joined && service.position !== null ? service.position - 1 : null;
  const taken = Math.min(QUEUE_LANE_CAPACITY, service.waitingCount);
  const overflow = Math.max(0, service.waitingCount - QUEUE_LANE_CAPACITY);
  const selfBeyondLane = selfIndex !== null && selfIndex >= QUEUE_LANE_CAPACITY;
  return (
    <div className="flex min-w-0 items-center gap-2" role="img" aria-label={laneLabel(service)}>
      <div className="queue-lane" aria-hidden>
        {Array.from({ length: QUEUE_LANE_CAPACITY }, (_, index) => {
          const state = index === selfIndex ? "self" : index < taken ? "taken" : "free";
          return (
            <span
              key={index}
              className={`queue-place queue-place-${state}`}
              style={{ ["--i" as string]: index }}
            >
              <SakuraBlossom />
            </span>
          );
        })}
      </div>
      {overflow > 0 ? (
        <span
          aria-hidden
          className={`shrink-0 text-[10.5px] tabular-nums ${selfBeyondLane ? "text-rose-light" : "text-fg/50"}`}
        >
          +<LiveNumber value={overflow} />
        </span>
      ) : null}
    </div>
  );
}

function Stat({ children, value }: { children: ReactNode; value: number }) {
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="font-display text-[15px] leading-none text-rose-light">
        <LiveNumber value={value} />
      </span>
      <span>{children}</span>
    </span>
  );
}

function OutingQueue({
  service,
  busy,
  onChange,
}: {
  service: ServiceQueueView;
  busy: boolean;
  onChange: (joined: boolean) => void;
}) {
  const position = service.joined ? (service.position ?? 1) : null;
  const ahead = position !== null ? position - 1 : service.waitingCount;
  const detail =
    position !== null ? (
      ahead === 0 ? (
        "You're next"
      ) : (
        <>
          <LiveNumber value={ahead} /> ahead of you
        </>
      )
    ) : service.waitingCount === 0 ? (
      "Be first in line"
    ) : (
      <>
        <LiveNumber value={service.waitingCount} /> waiting now
      </>
    );
  return (
    <section className="queue flex flex-1 flex-col justify-between gap-2" aria-label="Outing permission queue">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="queue-title block truncate text-[12px] font-medium text-fg/90">
            Outing permission
          </span>
          <span className="queue-meta block truncate text-[10.5px] text-fg/50">{detail}</span>
        </span>
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => onChange(!service.joined)}
          aria-label={`${service.joined ? "Leave" : "Join"} the outing permission queue`}
          className={`queue-action h-8 min-w-[62px] shrink-0 rounded-full border px-3.5 text-[12.5px] font-semibold transition-[border-color,background-color,color,transform] hover:border-rose-light hover:text-fg active:scale-[.97] disabled:cursor-wait disabled:opacity-60 ${
            service.joined
              ? "border-rose-light/50 bg-rose-light/10 text-rose-light"
              : "border-rose/40 bg-wash/20 text-fg/80"
          }`}
        >
          {busy ? "…" : service.joined ? "Leave" : "Join"}
        </button>
      </div>
      <QueueLane service={service} />
      <p
        className={`${hiddenWhenShort} m-0 flex items-baseline justify-between gap-3 text-[10.5px] text-fg/50`}
      >
        {position !== null ? (
          <Stat value={position}>your place</Stat>
        ) : (
          <Stat value={service.waitingCount + 1}>next place</Stat>
        )}
        <span className="tabular-nums">
          <LiveNumber value={service.waitingCount} /> in line
        </span>
      </p>
    </section>
  );
}

export function ServiceQueuesTile({ slot, model }: { slot: Slot; model: ServiceQueuesTileModel }) {
  const [busyKind, setBusyKind] = useState<ServiceQueueKind | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const outingQueue =
    model.services.find((service) => service.kind === "outing_permission") ?? null;
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
      <div className={`${tileBody} queue-body !gap-2`}>
        <TileEyebrow>request queue</TileEyebrow>
        {outingQueue ? (
          <OutingQueue
            service={outingQueue}
            busy={busyKind === outingQueue.kind}
            onChange={(joined) => void changeServiceQueue(outingQueue.kind, joined)}
          />
        ) : !model.available ? (
          <p className="m-0 text-[13px] leading-snug text-fg/65">
            Queues open once your place is confirmed.
          </p>
        ) : (
          <p className="m-0 text-[13px] leading-snug text-fg/65">No queues are open right now.</p>
        )}
        {serviceError ? (
          <p role="alert" className="m-0 text-[11px] text-rose-light">
            {serviceError}
          </p>
        ) : null}
      </div>
    </Tile>
  );
}
