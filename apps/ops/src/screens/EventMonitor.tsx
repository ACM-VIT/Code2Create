import { LiveNumber } from "../components/LiveNumber";
import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { Icon, type IconName } from "../components/Icon";
import { OperationsAttention } from "../components/OperationsAttention";
import { LoadingLabel, SkeletonCard, SkeletonList } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { formatClockTime, formatCompactDateTime } from "../lib/dateTime";
import { readableError } from "../lib/errors";

const attentionCoveredSignalKeys = ["panels_needing_reviewer", "overdue_reviews"];
type HealthOverviewData = FunctionReturnType<typeof api.operationsHealth.overview>;

export function EventMonitor({ canManageAttention }: { canManageAttention: boolean }) {
  const health = useQuery(api.operationsHealth.overview, { eventSlug });
  const requestRefresh = useMutation(api.operationsHealth.requestRefresh);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await requestRefresh({ eventSlug });
    } catch (caught) {
      setRefreshError(readableError(caught));
    } finally {
      setRefreshing(false);
    }
  };

  if (health === undefined) {
    return (
      <section className="health-shell">
        <LoadingLabel>Loading the event monitor</LoadingLabel>
        <SkeletonCard lines={3} />
        <SkeletonList rows={5} />
      </section>
    );
  }

  const snapshot = health.state === "ready" ? health.snapshot : null;
  const systemSignals =
    snapshot?.signals.filter(
      (signal) => !attentionCoveredSignalKeys.some((covered) => covered === signal.key),
    ) ?? [];

  return (
    <section className="health-shell">
      <header className="health-heading">
        <div>
          <p className="eyebrow">{snapshot?.event.name ?? "Live operations"}</p>
          <h1>Event monitor</h1>
        </div>
        <HealthState health={health} onRefresh={refresh} refreshing={refreshing} />
      </header>

      <OperationsAttention canManageAttention={canManageAttention} compact={false} />

      <section className="attention-section" aria-labelledby="system-checks-heading">
        <div className="section-heading">
          <h2 id="system-checks-heading">System checks</h2>
          {systemSignals.length > 0 ? <span><LiveNumber value={systemSignals.length} /> open</span> : null}
        </div>
        {refreshError ? <p className="notice">{refreshError}</p> : null}
        {health.state !== "ready" ? (
          <div className="health-empty">
            <strong>
              {health.state === "missing" ? "No check has run yet." : "These checks are from earlier."}
            </strong>
            <span>
              {health.state === "missing"
                ? "Check now to see event-wide issues."
                : `Last complete check: ${formatCompactDateTime(health.lastGeneratedAt)}.`}
            </span>
          </div>
        ) : systemSignals.length === 0 ? (
          <div className="health-empty">
            <strong>No system issue needs action.</strong>
          </div>
        ) : (
          <div className="health-list">
            {systemSignals.map((signal) => (
              <article className={`list-row ${signal.severity}`} key={signal.key}>
                <span className={`row-glyph ${signal.severity}`}>
                  <Icon name={severityIcon(signal.severity)} />
                </span>
                <div className="row-text">
                  <strong>{signal.title}</strong>
                  <small>
                    {signal.detail} {signal.owner} handles this
                    {signal.oldestAt !== undefined
                      ? ` · oldest ${formatCompactDateTime(signal.oldestAt)}`
                      : ""}
                    .
                  </small>
                </div>
                <span className="row-count">
                  <LiveNumber value={signal.count} />
                  {signal.atLeast ? "+" : ""}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function HealthState({
  health,
  onRefresh,
  refreshing,
}: {
  health: HealthOverviewData;
  onRefresh: () => Promise<void>;
  refreshing: boolean;
}) {
  const checkNow = (
    <button
      className="text-button"
      disabled={refreshing}
      onClick={() => void onRefresh()}
      type="button"
    >
      {refreshing ? "Checking…" : "Check now"}
    </button>
  );
  if (health.state !== "ready") {
    return (
      <div className="health-current watch">
        <span>System health</span>
        <strong>{health.state === "missing" ? "Not checked yet" : "Checked earlier"}</strong>
        <small>
          {health.state === "missing"
            ? "Run the first check"
            : `Checked ${formatClockTime(health.lastGeneratedAt)}`}
        </small>
        {checkNow}
      </div>
    );
  }
  return (
    <div className={`health-current ${health.snapshot.summary.status}`}>
      <span>System health</span>
      <strong>{statusLabel(health.snapshot.summary.status)}</strong>
      <small>Checked {formatClockTime(health.snapshot.generatedAt)}</small>
      {checkNow}
    </div>
  );
}

function statusLabel(value: "healthy" | "watch" | "attention" | "critical") {
  if (value === "healthy") return "Clear";
  if (value === "watch") return "Watch";
  if (value === "attention") return "Needs attention";
  return "Critical";
}

function severityIcon(value: "watch" | "attention" | "critical"): IconName {
  if (value === "critical") return "alert";
  if (value === "attention") return "clock";
  return "pause";
}
