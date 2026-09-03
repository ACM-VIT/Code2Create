import { api } from "@code2create/backend/api";
import { eventBlockerPaths, eventStageGuidance } from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex/react";
import { Link } from "react-router-dom";

import { OperationsAttention } from "../components/OperationsAttention";
import { LoadingLabel, SkeletonCard, SkeletonList } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { formatClockTime } from "../lib/dateTime";

type Lifecycle = FunctionReturnType<typeof api.eventLifecycle.current>;

export function HealthOverview({
  availableBlockerPaths,
  canManageAttention,
  canReadLifecycle,
}: {
  availableBlockerPaths: readonly string[];
  canManageAttention: boolean;
  canReadLifecycle: boolean;
}) {
  const health = useQuery(api.operationsHealth.overview, { eventSlug });
  const lifecycle = useQuery(api.eventLifecycle.current, canReadLifecycle ? { eventSlug } : "skip");

  if (health === undefined || (canReadLifecycle && lifecycle === undefined)) {
    return (
      <section className="health-shell">
        <LoadingLabel>Loading the event overview</LoadingLabel>
        <SkeletonCard lines={2} />
        <SkeletonList rows={3} />
      </section>
    );
  }

  const snapshot = health.state === "ready" ? health.snapshot : null;
  const stage = lifecycle ? eventStageGuidance[lifecycle.status] : null;

  return (
    <section className="health-shell overview-shell">
      <header className="health-heading">
        <div>
          <p className="eyebrow">
            {snapshot?.event.name ?? "Code2Create 7.0"}
            {stage ? ` · ${stage.label}` : ""}
          </p>
          <h1>Overview</h1>
        </div>
        <Link className={`health-current ${healthTone(health)}`} to="/event-monitor">
          <span>System health</span>
          <strong>{healthLabel(health)}</strong>
          <small>{healthTime(health)}</small>
        </Link>
      </header>

      {lifecycle ? (
        <StageSummary lifecycle={lifecycle} availableBlockerPaths={availableBlockerPaths} />
      ) : null}

      <OperationsAttention canManageAttention={canManageAttention} compact />
    </section>
  );
}

function StageSummary({
  availableBlockerPaths,
  lifecycle,
}: {
  availableBlockerPaths: readonly string[];
  lifecycle: Lifecycle;
}) {
  const stage = eventStageGuidance[lifecycle.status];
  if (stage.nextStatus === null || stage.nextStep === null) return null;

  const nextTransition = lifecycle.transitions.find(
    (transition) => transition.targetStatus === stage.nextStatus,
  );
  const blockers = nextTransition?.blockers ?? [];
  const visibleBlockers = blockers.slice(0, 3);
  const remainingBlockers = blockers.length - visibleBlockers.length;

  return (
    <section className="stage-block" aria-labelledby="next-event-step">
      <div className="stage-block-heading">
        <div>
          <span>Next</span>
          <h2 id="next-event-step">{stage.nextStep}</h2>
        </div>
        {blockers.length > 0 ? <span>{blockers.length} blocked</span> : <span>Ready</span>}
      </div>
      {blockers.length === 0 ? (
        availableBlockerPaths.includes("/configuration") ? (
          <Link className="primary compact-link" to="/configuration">
            Continue
          </Link>
        ) : (
          <span className="muted">Ready for the event lead.</span>
        )
      ) : (
        <ul className="stage-blockers">
          {visibleBlockers.map((blocker) => {
            const path = eventBlockerPaths[blocker.key];
            const availablePath = path && availableBlockerPaths.includes(path) ? path : null;
            return (
              <li key={blocker.key}>
                {availablePath ? (
                  <Link to={availablePath}>
                    {blocker.label} <span>→</span>
                  </Link>
                ) : (
                  blocker.label
                )}
              </li>
            );
          })}
          {remainingBlockers > 0 ? (
            <li className="stage-more">
              {availableBlockerPaths.includes("/configuration") ? (
                <Link to="/configuration">
                  {remainingBlockers} more in event setup <span>→</span>
                </Link>
              ) : (
                `${remainingBlockers} more`
              )}
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function healthTone(health: FunctionReturnType<typeof api.operationsHealth.overview>) {
  return health.state === "ready" ? health.snapshot.summary.status : "watch";
}

function healthLabel(health: FunctionReturnType<typeof api.operationsHealth.overview>) {
  if (health.state === "missing") return "Starting";
  if (health.state === "stale") return "Delayed";
  if (health.snapshot.summary.status === "healthy") return "Clear";
  if (health.snapshot.summary.status === "watch") return "Watch";
  if (health.snapshot.summary.status === "attention") return "Needs attention";
  return "Critical";
}

function healthTime(health: FunctionReturnType<typeof api.operationsHealth.overview>) {
  if (health.state === "missing") return "Open monitor";
  if (health.state === "stale") return `Last complete ${formatClockTime(health.lastGeneratedAt)}`;
  return `Updated ${formatClockTime(health.snapshot.generatedAt)}`;
}
