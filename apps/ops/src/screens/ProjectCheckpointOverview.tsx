import { api } from "@code2create/backend/api";
import { usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";

import { LoadingLabel, SkeletonList, SkeletonStats } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { formatCompactDateTime } from "../lib/dateTime";

type CheckpointKey = "ideation" | "intermediate_update" | "final_update";
type Availability = "awaiting_confirmation" | "upcoming" | "open" | "late" | "closed" | "submitted";
type CheckpointView = "outstanding" | "submitted" | "all";

const availabilityLabels: Record<Availability, string> = {
  awaiting_confirmation: "Has not confirmed its place",
  upcoming: "Not open yet",
  open: "Can still submit",
  late: "Late, can still submit",
  closed: "Missed the window",
  submitted: "Submitted",
};

export function ProjectCheckpointOverview() {
  const eventState = useQuery(api.projectCheckpoints.eventState, { eventSlug });
  const [checkpointKey, setCheckpointKey] = useState<CheckpointKey>("ideation");
  const [view, setView] = useState<CheckpointView>("outstanding");
  const [search, setSearch] = useState("");
  const teams = usePaginatedQuery(
    api.projectCheckpoints.teams,
    eventState?.configured ? { eventSlug, checkpointKey } : "skip",
    { initialNumItems: 40 },
  );
  const summary = useQuery(
    api.projectCheckpoints.operationsCheckpointSummary,
    eventState?.configured ? { eventSlug, checkpointKey } : "skip",
  );

  if (eventState === undefined) {
    return (
      <section className="integration-health-shell">
        <LoadingLabel>Loading team updates</LoadingLabel>
        <SkeletonStats columns={4} />
        <SkeletonList rows={5} />
      </section>
    );
  }

  const checkpoint = eventState.checkpoints.find(
    (candidate) => candidate.checkpointKey === checkpointKey,
  );
  const rows = [...teams.results].sort((left, right) => {
    const leftDone = left.submittedAt !== undefined;
    const rightDone = right.submittedAt !== undefined;
    if (leftDone !== rightDone) return leftDone ? 1 : -1;
    return left.teamName.localeCompare(right.teamName);
  });
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleRows = rows.filter((team) => {
    if (view === "outstanding" && team.submittedAt !== undefined) return false;
    if (view === "submitted" && team.submittedAt === undefined) return false;
    return (
      normalizedSearch.length === 0 || team.teamName.toLocaleLowerCase().includes(normalizedSearch)
    );
  });
  const completion =
    summary && summary.totalTeamCount > 0
      ? Math.round((summary.submittedCount / summary.totalTeamCount) * 100)
      : 0;
  return (
    <section className="integration-health-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Team progress</p>
          <h1>Team updates</h1>
          <p className="muted">What each team says it has built so far.</p>
        </div>
      </div>

      {!eventState.configured ? (
        <p className="notice">
          Publish both the event phases and checkpoint plan to open this view.
        </p>
      ) : (
        <>
          <nav className="stage-filter" aria-label="Project checkpoints">
            {eventState.checkpoints.map((candidate) => (
              <button
                aria-current={candidate.checkpointKey === checkpointKey}
                className={
                  candidate.checkpointKey === checkpointKey ? "stage-chip active" : "stage-chip"
                }
                key={candidate.checkpointKey}
                type="button"
                onClick={() => {
                  setCheckpointKey(candidate.checkpointKey);
                  setView("outstanding");
                  setSearch("");
                }}
              >
                {candidate.displayName}
              </button>
            ))}
          </nav>

          {checkpoint ? (
            <div className="checkpoint-progress">
              <div className="checkpoint-progress-copy">
                <span>Submission progress</span>
                <strong>
                  {summary === undefined
                    ? "Loading teams…"
                    : `${summary.submittedCount} of ${summary.totalTeamCount} submitted`}
                </strong>
              </div>
              <div
                aria-label={`${completion}% submitted`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={completion}
                className="checkpoint-progress-track"
                role="progressbar"
              >
                <span style={{ width: `${completion}%` }} />
              </div>
              <dl className="checkpoint-progress-window">
                <Stat label="Due" value={formatCompactDateTime(checkpoint.dueAt)} />
                <Stat label="Closes" value={formatCompactDateTime(checkpoint.closesAt)} />
              </dl>
            </div>
          ) : null}

          <div className="checkpoint-toolbar">
            <div className="configuration-tabs" role="tablist" aria-label="Status">
              <CheckpointViewButton
                active={view === "outstanding"}
                count={summary?.outstandingCount}
                label="Still to submit"
                onClick={() => setView("outstanding")}
              />
              <CheckpointViewButton
                active={view === "submitted"}
                count={summary?.submittedCount}
                label="Submitted"
                onClick={() => setView("submitted")}
              />
              <CheckpointViewButton
                active={view === "all"}
                count={summary?.totalTeamCount}
                label="Every team"
                onClick={() => setView("all")}
              />
            </div>
            <label className="compact-search">
              <span className="visually-hidden">Find a team</span>
              <input
                type="search"
                placeholder="Find a team"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>

          {teams.status === "LoadingFirstPage" ? <SkeletonList rows={5} /> : null}
          <div className="checkpoint-operations-list">
            {visibleRows.map((team) => (
              <article className="checkpoint-operations-row" key={team.teamId}>
                <div>
                  <strong>{team.teamName}</strong>
                  <span>{availabilityLabels[team.availability]}</span>
                </div>
                <div className="checkpoint-operations-answer">
                  {team.updateText ? (
                    <p>{team.updateText}</p>
                  ) : (
                    <p className="muted">Nothing written yet.</p>
                  )}
                  {team.followUpAnswer ? <small>{team.followUpAnswer}</small> : null}
                </div>
                <small>
                  {team.submittedAt
                    ? `Submitted ${formatCompactDateTime(team.submittedAt)}${team.timing === "late" ? " · late" : ""}`
                    : team.draftVersion
                      ? "Draft saved, not submitted"
                      : "Not started"}
                </small>
              </article>
            ))}

            {visibleRows.length === 0 && teams.status !== "LoadingFirstPage" ? (
              <p className="muted">
                {summary?.totalTeamCount === 0
                  ? "No teams are available for this update."
                  : normalizedSearch.length > 0
                    ? `No team matches “${search.trim()}”.`
                    : view === "outstanding"
                      ? "Every loaded team has submitted this update."
                      : view === "submitted"
                        ? "No loaded team has submitted this update yet."
                        : "No team rows have been loaded."}
              </p>
            ) : null}
          </div>
          {teams.status === "CanLoadMore" ? (
            <button className="secondary" type="button" onClick={() => teams.loadMore(40)}>
              Load more
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function CheckpointViewButton({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number | undefined;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-selected={active}
      className={active ? "active" : ""}
      role="tab"
      type="button"
      onClick={onClick}
    >
      {label}
      {count === undefined ? "" : ` · ${count}`}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
