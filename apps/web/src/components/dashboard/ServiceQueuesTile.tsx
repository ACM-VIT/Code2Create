import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@code2create/backend/api";
import { useDeadlineReached } from "../../lib/useDeadlineReached";

import { readableError } from "../../lib/errors";
import { LiveNumber } from "../LiveNumber";
import { Tile, TileEyebrow } from "./Tile";
import type { Slot } from "./dashboardLayout";
import { tileBody } from "./tileClasses";

export type ServiceQueueKind = "outing_permission";
export type ServiceQueueView = Omit<FunctionReturnType<typeof api.serviceQueues.current>[number], "requestId" | "opensAt" | "closesAt">;
export type ServiceQueuesTileModel = {
  available: boolean;
  pending: boolean;
  services: readonly ServiceQueueView[];
  setServiceQueue: (kind: ServiceQueueKind, joined: boolean) => Promise<void>;
};

/** The lane draws this many places; a longer line spills into a "+n". */
const QUEUE_LANE_CAPACITY = 15;

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
  if (service.status === "waiting") {
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
  const selfIndex = service.status === "waiting" && service.position !== null ? service.position - 1 : null;
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

function OutingQueue({ service, busy, pending, onChange }: {
  service: ServiceQueueView;
  busy: boolean;
  pending: boolean;
  onChange: (joined: boolean) => void;
}) {
  const deadline = service.status === "permitted" ? service.permissionExpiresAt : service.returnBy;
  const deadlineReached = useDeadlineReached(service.serverNow, deadline ?? undefined);
  const status = deadlineReached && service.status === "permitted" ? "expired"
    : deadlineReached && service.status === "out" ? "overdue" : service.status;
  const cancellable = status === "waiting" || status === "permitted";
  const title = status === "permitted" ? "You can go for 15 minutes"
    : status === "out" ? "Your outing is in progress"
    : status === "overdue" ? "Your 15 minutes are up"
    : status === "waiting" ? `You’re number ${service.position} in the queue`
    : status === "expired" ? "Your permission expired"
    : "Need a washroom break?";
  const detail = status === "permitted" ? "Show your ID to staff on the way out. Your 15 minutes start at the exit scan."
    : status === "out" ? "Return within 15 minutes to avoid an automated reminder call. Have your ID scanned on return."
    : status === "overdue" ? "Please return and have your ID scanned. Your slot stays occupied until then."
    : status === "waiting" ? "All outing slots are occupied. Keep this page open; it will tell you when you can go."
    : status === "unconfigured" ? "Staff are setting up outing capacity."
    : status === "offsite" ? "Have your check-in or return scanned before requesting an outing."
    : status === "expired" ? "You did not leave in time. Request another 15-minute outing when you’re ready."
    : "Request a 15-minute outing. If a slot is free, you can go immediately.";
  const clockLabel = deadline !== null && (status === "permitted" || status === "out")
    ? `${status === "permitted" ? "Leave before" : "Return by"} ${new Date(deadline).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : null;
  return (
    <section className="queue flex flex-1 flex-col justify-between gap-2" aria-label="Washroom outing">
      <div role="status" aria-live="polite" aria-atomic="true">
        <span className="queue-title block text-[14px] font-medium text-fg/90">{title}</span>
        <p className="outing-description m-0 mt-1 text-[11px] leading-snug text-fg/65">{detail}</p>
        {clockLabel ? <p className="m-0 mt-1 text-[12px] text-rose-light">{clockLabel}</p> : null}
        {status === "out" ? <p className="outing-call-hint m-0 mt-1 text-[10px] text-fg/65">Automated call if overdue.</p> : null}
      </div>
      {status === "waiting" ? <QueueLane service={service} /> : null}
      <div className="flex items-center justify-between gap-2">
        <span className="outing-capacity text-[10.5px] text-fg/50">
          {service.capacity !== null ? `${service.occupiedCount}/${service.capacity} slots occupied` : "Capacity not set"}
        </span>
        {cancellable || service.canRequest || pending ? (
          <button type="button" disabled={busy} aria-busy={busy}
            onClick={() => onChange(!cancellable)}
            className="queue-action h-8 shrink-0 rounded-full border border-rose/40 bg-wash/20 px-3 text-[12px] font-semibold text-fg/80 transition-colors hover:border-rose-light hover:text-fg disabled:opacity-60">
            {busy ? "…" : pending ? "Retry" : cancellable ? "Cancel request" : "Request outing"}
          </button>
        ) : null}
      </div>
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
      <div className={`${tileBody} queue-body outing-body !gap-2`}>
        <div className="outing-eyebrow"><TileEyebrow>washroom outing</TileEyebrow></div>
        {outingQueue ? (
          <OutingQueue
            service={outingQueue}
            pending={model.pending}
            busy={busyKind === outingQueue.kind}
            onChange={(joined) => void changeServiceQueue(outingQueue.kind, joined)}
          />
        ) : !model.available ? (
          <p className="m-0 text-[13px] leading-snug text-fg/65">
            Loading outing permission…
          </p>
        ) : (
          <p className="m-0 text-[13px] leading-snug text-fg/65">Outing requests are closed right now.</p>
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
