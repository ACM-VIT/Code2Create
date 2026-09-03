import { api } from "@code2create/backend/api";
import { usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import { eventSlug } from "../../lib/config";
import { formatClockTime, formatCompactDateTime } from "../../lib/dateTime";
import { Icon, type IconName } from "../Icon";
import { LoadingLabel, SkeletonList } from "../Skeleton";

type BriefRun = FunctionReturnType<
  typeof api.intelligenceObservability.briefHistory
>["page"][number];
const briefPageSize = 12;

export function ManualBriefHistory() {
  const history = usePaginatedQuery(
    api.intelligenceObservability.briefHistory,
    { eventSlug },
    { initialNumItems: briefPageSize },
  );

  return (
    <section aria-labelledby="brief-runs-heading" className="attention-section">
      <div className="section-heading">
        <h2 id="brief-runs-heading">Brief runs</h2>
        {history.status === "LoadingFirstPage" || history.results.length === 0 ? null : (
          <span>{history.results.length} loaded · newest first</span>
        )}
      </div>
      {history.status === "LoadingFirstPage" ? (
        <>
          <LoadingLabel>Loading brief runs</LoadingLabel>
          <SkeletonList rows={3} />
        </>
      ) : history.results.length === 0 ? (
        <div className="health-empty">
          <strong>No brief has run yet.</strong>
        </div>
      ) : (
        <div className="health-list">
          {history.results.map((run) => (
            <article
              className={`list-row${run.state === "failed" ? " critical" : ""}`}
              key={run.id}
            >
              <span className={`row-glyph ${runGlyphTone(run)}`}>
                <Icon name={runIcon(run)} />
              </span>
              <div className="row-text">
                <strong>{run.headline ?? runStateLabel(run.state)}</strong>
                <small>{runMeta(run)}</small>
              </div>
              <span className="state-label">{runStateLabel(run.state)}</span>
            </article>
          ))}
        </div>
      )}
      {history.status === "CanLoadMore" ? (
        <button
          className="secondary mt-3"
          onClick={() => history.loadMore(briefPageSize)}
          type="button"
        >
          Load older manual briefs
        </button>
      ) : null}
      {history.status === "LoadingMore" ? <LoadingLabel>Loading older briefs</LoadingLabel> : null}
    </section>
  );
}

function runMeta(run: BriefRun) {
  const parts = [`Requested ${formatCompactDateTime(run.requestedAt)}`];
  if (run.workerAcceptedAt !== undefined)
    parts.push(`started ${formatClockTime(run.workerAcceptedAt)}`);
  if (run.completedAt !== undefined) parts.push(`finished ${formatClockTime(run.completedAt)}`);
  if (run.failureCode !== undefined) parts.push(failureLabel(run.failureCode));
  return parts.join(" · ");
}

function runStateLabel(state: BriefRun["state"]) {
  if (state === "pending") return "Queued";
  if (state === "dispatching") return "Starting";
  if (state === "accepted") return "Running";
  if (state === "succeeded") return "Done";
  return "Failed";
}

function runIcon(run: BriefRun): IconName {
  if (run.state === "succeeded") return "check";
  if (run.state === "failed") return "alert";
  return "clock";
}

function runGlyphTone(run: BriefRun) {
  if (run.state === "failed") return "critical";
  if (run.state === "succeeded") return "watch";
  return "attention";
}

function failureLabel(code: NonNullable<BriefRun["failureCode"]>) {
  if (code === "dispatch_failed") return "the agent could not start";
  if (code === "agent_timed_out") return "the agent took too long";
  if (code === "model_did_not_publish") return "the agent finished without a brief";
  return "the agent response could not be saved";
}
