import { useLayoutEffect, useRef, useState } from "react";

import { readableError } from "../../lib/errors";
import { LiveNumber } from "../LiveNumber";
import { Tile, TileEyebrow } from "./Tile";
import type { Slot } from "./dashboardLayout";
import { tileBody } from "./tileClasses";

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

function SakuraBlossom() {
  return (
    <svg viewBox="0 0 32 32" className="h-full w-full overflow-visible" aria-hidden>
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

const queueNumberFormat = {
  useGrouping: false,
  minimumIntegerDigits: 2,
} satisfies Intl.NumberFormatOptions;

function QueueBlossom({ state }: { state: "base" | "self" }) {
  return (
    <span className={`outing-queue-blossom outing-queue-blossom-${state}`} aria-hidden>
      <SakuraBlossom />
    </span>
  );
}

function OutingQueueLoader({ service }: { service: ServiceQueueView }) {
  const previouslyJoined = useRef(service.joined);
  const [joining, setJoining] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const position = service.position ?? 1;
  const displayedNumber = service.joined ? position : service.waitingCount;
  const ariaLabel = service.joined
    ? position === 1
      ? "You are first in the outing permission queue"
      : `You are number ${position} in the outing permission queue`
    : service.waitingCount === 0
      ? "The outing permission queue is empty"
      : `${service.waitingCount} ${service.waitingCount === 1 ? "person is" : "people are"} waiting for outing permission`;

  useLayoutEffect(() => {
    const joinedNow = !previouslyJoined.current && service.joined;
    const leftNow = previouslyJoined.current && !service.joined;
    previouslyJoined.current = service.joined;
    if (joinedNow) {
      setLeaving(false);
      setJoining(true);
      const timer = window.setTimeout(() => setJoining(false), 1_650);
      return () => window.clearTimeout(timer);
    }
    if (leftNow) {
      setJoining(false);
      setLeaving(true);
      const timer = window.setTimeout(() => setLeaving(false), 900);
      return () => window.clearTimeout(timer);
    }
    setJoining(false);
    setLeaving(false);
  }, [service.joined]);

  const transitionClass = joining ? "is-joining" : leaving ? "is-leaving" : "";

  return (
    <div className={`outing-queue-loader relative flex flex-1 flex-col items-center justify-center gap-1 ${transitionClass}`} role="img" aria-label={ariaLabel}>
      <div className={`outing-queue-sequence relative w-full max-w-[310px] flex-1 ${transitionClass}`} aria-hidden>
        {Array.from({ length: 5 }, (_, index) => <QueueBlossom key={index} state="base" />)}
        {service.joined || leaving ? <QueueBlossom state="self" /> : null}
      </div>
      <span aria-hidden className="outing-queue-number pointer-events-none absolute -right-5 -bottom-5 font-display text-[68px] leading-none text-rose-light/[.055]">
        <LiveNumber value={displayedNumber} format={queueNumberFormat} />
      </span>
      <span className="outing-queue-position relative flex shrink-0 items-baseline gap-1.5 whitespace-nowrap font-ui text-[11px] font-medium tracking-[.01em] text-fg/65 transition-opacity duration-200">
        <span>{service.joined ? "Your place" : "Next place"}</span>
        <LiveNumber value={service.joined ? position : service.waitingCount + 1} />
      </span>
    </div>
  );
}

function OutingPermissionQueue({
  service,
  busy,
  onChange,
}: {
  service: ServiceQueueView;
  busy: boolean;
  onChange: (joined: boolean) => void;
}) {
  const ahead = service.joined ? Math.max(0, (service.position ?? 1) - 1) : service.waitingCount;
  const detail = service.joined
    ? ahead === 0
      ? "You're next"
      : <><LiveNumber value={ahead} /> {ahead === 1 ? "person" : "people"} ahead</>
    : service.waitingCount === 0
      ? "Be first in line"
      : <><LiveNumber value={service.waitingCount} /> waiting now</>;
  return (
    <section className="outing-queue flex flex-1 flex-col gap-1">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="outing-queue-title block truncate text-[12px] font-medium text-fg/90">Outing permission</span>
          <span className="outing-queue-meta block truncate text-[10px] text-fg/45">{detail}</span>
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange(!service.joined)}
          aria-label={`${service.joined ? "Leave" : "Join"} outing permission queue`}
          className={`outing-queue-action h-8 shrink-0 rounded-full border px-3.5 text-[12.5px] font-semibold backdrop-blur-md transition-[border-color,background-color,color,transform] hover:border-rose-light hover:text-fg active:scale-[.97] disabled:cursor-wait disabled:opacity-50 ${service.joined ? "border-rose-light/45 bg-rose-light/10 text-rose-light" : "border-rose/35 bg-wash/20 text-fg/80"}`}
        >
          {busy ? "Updating…" : service.joined ? "Leave" : "Join"}
        </button>
      </div>
      <OutingQueueLoader service={service} />
    </section>
  );
}

export function ServiceQueuesTile({ slot, model }: { slot: Slot; model: ServiceQueuesTileModel }) {
  const [busyKind, setBusyKind] = useState<ServiceQueueKind | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const outingQueue = model.services.find((service) => service.kind === "outing_permission") ?? null;
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
      <div className={`${tileBody} outing-queue-body !gap-2`}>
        <TileEyebrow>queues</TileEyebrow>
        {outingQueue ? (
          <OutingPermissionQueue
            service={outingQueue}
            busy={busyKind === outingQueue.kind}
            onChange={(joined) => void changeServiceQueue(outingQueue.kind, joined)}
          />
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
