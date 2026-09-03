import { api } from "@code2create/backend/api";
import { usePaginatedQuery } from "convex/react";
import { useState } from "react";
import { Link } from "react-router-dom";

import {
  AgentControlPlane,
  AutonomyQueuedWorkList,
  AutonomyRunInspection,
  AutonomyRunList,
  AutonomyRunNow,
  ManualBriefHistory,
} from "../components/intelligence";
import { LoadingLabel, SkeletonCard, SkeletonList } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { formatRelativeTime } from "../lib/dateTime";
import { type AutonomyStatus, autonomyStatusSummary } from "../lib/operationsAutonomyPresentation";

const autonomyPageSize = 12;

/** The engine room: autonomous reviews with their traces, brief runs, and the deployed agents. */
export function IntelligenceActivity({
  autonomy,
  canConfigure,
  canGenerate,
}: {
  autonomy: AutonomyStatus | undefined;
  canConfigure: boolean;
  canGenerate: boolean;
}) {
  const runHistory = usePaginatedQuery(
    api.operationsAutonomy.history,
    { eventSlug },
    { initialNumItems: autonomyPageSize },
  );
  const queuedWork = usePaginatedQuery(
    api.operationsAutonomy.queuedWork,
    { eventSlug },
    { initialNumItems: autonomyPageSize },
  );
  const [selectedRunId, setSelectedRunId] = useState<string>();

  const loading =
    autonomy === undefined ||
    runHistory.status === "LoadingFirstPage" ||
    queuedWork.status === "LoadingFirstPage";
  const activeRun = autonomy?.activeRun ?? null;
  const runs =
    activeRun === null || runHistory.results.some((run) => run.runId === activeRun.runId)
      ? runHistory.results
      : [activeRun, ...runHistory.results];
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? activeRun ?? runs[0];

  return (
    <div className="grid content-start gap-7">
      <section aria-labelledby="autonomous-review-heading" className="attention-section">
        <div className="section-heading">
          <h2 id="autonomous-review-heading">Autonomous review</h2>
          {autonomy === undefined ? null : (
            <span>
              {autonomy.policy.mode === "recommend" ? "Observes and proposes" : "Observes only"}
              {" · policy version "}
              {autonomy.policy.policyVersion}
            </span>
          )}
        </div>
        {loading || autonomy === undefined ? (
          <>
            <LoadingLabel>Loading autonomous review activity</LoadingLabel>
            <SkeletonCard lines={2} />
            <SkeletonList rows={3} />
          </>
        ) : (
          <div className="grid gap-3">
            <AutonomyStatusCard
              autonomy={autonomy}
              canConfigure={canConfigure}
              canGenerate={canGenerate}
              onStarted={setSelectedRunId}
            />
            <AutonomyRunList
              onSelect={setSelectedRunId}
              runs={runs}
              selectedRunId={selectedRun?.runId}
            />
            {runHistory.status === "CanLoadMore" ? (
              <button
                className="secondary"
                onClick={() => runHistory.loadMore(autonomyPageSize)}
                type="button"
              >
                Load older runs
              </button>
            ) : null}
            {runHistory.status === "LoadingMore" ? (
              <LoadingLabel>Loading older runs</LoadingLabel>
            ) : null}
            {selectedRun === undefined ? null : <AutonomyRunInspection run={selectedRun} />}
          </div>
        )}
      </section>

      {queuedWork.results.length === 0 ? null : (
        <section aria-labelledby="queued-work-heading" className="attention-section">
          <div className="section-heading">
            <h2 id="queued-work-heading">Queued checks</h2>
            <span>{autonomy?.scheduler.queuedWorkCount ?? queuedWork.results.length}</span>
          </div>
          <AutonomyQueuedWorkList items={queuedWork.results} />
          {queuedWork.status === "CanLoadMore" ? (
            <button
              className="secondary mt-3"
              onClick={() => queuedWork.loadMore(autonomyPageSize)}
              type="button"
            >
              Load more queued checks
            </button>
          ) : null}
        </section>
      )}

      <ManualBriefHistory />

      <AgentControlPlane />
    </div>
  );
}

function AutonomyStatusCard({
  autonomy,
  canConfigure,
  canGenerate,
  onStarted,
}: {
  autonomy: AutonomyStatus;
  canConfigure: boolean;
  canGenerate: boolean;
  onStarted: (runId: string) => void;
}) {
  const summary = autonomyStatusSummary(autonomy, (at) => formatRelativeTime(at));
  const dot =
    summary.tone === "live"
      ? "bg-green shadow-[0_0_0_4px_rgb(143_185_159/0.12)]"
      : summary.tone === "ready"
        ? "bg-green/70"
        : "bg-ink-3";
  const stopped = !autonomy.policy.enabled || autonomy.scheduler.lifecycle === "disabled";
  const note = !autonomy.available
    ? "Runs while applications are open or the event is live."
    : stopped
      ? "Stopped. Publish an enabled policy in event setup to resume."
      : autonomy.scheduler.queuedWorkCount > 0
        ? `${autonomy.scheduler.queuedWorkCount} queued ${autonomy.scheduler.queuedWorkCount === 1 ? "check" : "checks"} will run in order.`
        : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl bg-surface px-4 py-3.5">
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${dot}`} />
        <div className="min-w-0">
          <strong className="block text-[13px] font-medium text-ink">
            {summary.label}
            <span className="font-normal text-ink-3"> · {summary.detail}</span>
          </strong>
          {note === null && !canConfigure ? null : (
            <span className="mt-0.5 block text-[12px] leading-5 text-ink-3">
              {note}
              {note !== null && canConfigure ? " " : ""}
              {canConfigure ? (
                <Link
                  className="text-ink-2 no-underline hover:text-ink"
                  to="/configuration/intelligence"
                >
                  Change the policy →
                </Link>
              ) : null}
            </span>
          )}
        </div>
      </div>
      {canGenerate ? <AutonomyRunNow autonomy={autonomy} onStarted={onStarted} /> : null}
    </div>
  );
}
