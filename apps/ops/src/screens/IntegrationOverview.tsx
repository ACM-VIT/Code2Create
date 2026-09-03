import { api } from "@code2create/backend/api";
import {
  figmaPreviewStateLabels,
  githubRepositoryCoverageLabels,
  githubRepositorySyncStateLabels,
  githubRepositoryTopicStateLabels,
  integrationProviderHealthLabels,
  repositoryKindLabels,
  teamStatusLabels,
} from "@code2create/domain";
import { useAction, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/Icon";
import { LoadingLabel, SkeletonList } from "../components/Skeleton";

type IntegrationTeam = FunctionReturnType<typeof api.integrationOperations.teams>["page"][number];
type ProviderHealth = IntegrationTeam["github"]["health"];
type IntegrationView = "attention" | "all";
type CheckpointLink = FunctionReturnType<typeof api.figmaActions.openFullCheckpoint> & {
  clientNow: number;
};

function activityTime(value: number | undefined) {
  if (value === undefined) return null;
  return new Date(value).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function plural(count: number, singular: string, many: string) {
  return `${count} ${count === 1 ? singular : many}`;
}

function isDisconnected(team: IntegrationTeam) {
  return team.github.health === "not_connected" && team.figma.health === "not_connected";
}

function needsAttention(team: IntegrationTeam) {
  return team.github.health === "needs_attention" || team.figma.health === "needs_attention";
}

function teamRank(team: IntegrationTeam) {
  if (isDisconnected(team)) return 0;
  if (needsAttention(team)) return 1;
  return 2;
}

function providerTone(health: ProviderHealth) {
  if (health === "needs_attention") return "attention";
  if (health === "not_connected") return "unconnected";
  return "ready";
}

function ProviderCount({
  count,
  health,
  icon,
  name,
  unit,
  units,
}: {
  count: number;
  health: ProviderHealth;
  icon: IconName;
  name: string;
  unit: string;
  units: string;
}) {
  const state = integrationProviderHealthLabels[health];
  return (
    <span
      className={`integration-provider ${providerTone(health)}`}
      title={`${name}: ${plural(count, unit, units)}, ${state.toLowerCase()}`}
    >
      <Icon name={icon} />
      <span className="integration-provider-name">{name}</span>
      <span aria-label={plural(count, unit, units)}>{count}</span>
    </span>
  );
}

function teamNote(team: IntegrationTeam) {
  const notes: string[] = [];
  if (team.github.topicMissingCount > 0) {
    notes.push(
      `${plural(team.github.topicMissingCount, "repository", "repositories")} missing the event topic`,
    );
  }
  if (team.github.incompleteCount > 0) {
    notes.push(
      `${plural(team.github.incompleteCount, "repository", "repositories")} only partly counted`,
    );
  }
  if (team.figma.rateLimitedCount > 0) {
    notes.push(
      `${plural(team.figma.rateLimitedCount, "file", "files")} paused by Figma's rate limit`,
    );
  }
  if (team.figma.dirtyCount > 0) {
    notes.push(`${plural(team.figma.dirtyCount, "file", "files")} changed since the last capture`);
  }
  if (team.figma.incompleteCount > 0) {
    notes.push(`${plural(team.figma.incompleteCount, "file", "files")} only partly captured`);
  }
  if (notes.length > 0) return notes.join(" · ");
  if (needsAttention(team)) {
    return team.github.health === "needs_attention"
      ? "GitHub is not reading properly"
      : "Figma is not reading properly";
  }
  if (isDisconnected(team)) return "No repository and no design file";
  if (team.github.health === "not_connected") return "No repository";
  if (team.figma.health === "not_connected") return "No design file";
  const latest = activityTime(
    Math.max(team.github.lastActivityAt ?? 0, team.figma.lastActivityAt ?? 0) || undefined,
  );
  return latest === null ? null : `Last change ${latest}`;
}

export function IntegrationOverview() {
  const [chosen, setView] = useState<IntegrationView | null>(null);
  const [expandedTeamId, setExpandedTeamId] = useState<IntegrationTeam["teamId"] | null>(null);
  const [search, setSearch] = useState("");
  const { results, status, loadMore } = usePaginatedQuery(
    api.integrationOperations.teams,
    { eventSlug },
    { initialNumItems: 30 },
  );
  const summary = useQuery(api.integrationOperations.summary, { eventSlug });
  const outstanding =
    summary === undefined ? 0 : summary.disconnectedCount + summary.attentionCount;
  const view = chosen ?? (outstanding > 0 ? "attention" : "all");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visible = [
    ...(view === "attention" ? results.filter((team) => teamRank(team) < 2) : results),
  ]
    .filter(
      (team) =>
        normalizedSearch.length === 0 ||
        team.teamName.toLocaleLowerCase().includes(normalizedSearch),
    )
    .sort(
      (left, right) =>
        teamRank(left) - teamRank(right) || left.teamName.localeCompare(right.teamName),
    );

  return (
    <section className="integration-health-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Connected project work</p>
          <h1>Code and design</h1>
          <p className="muted">
            {summary === undefined
              ? "Loading connection health for every team you can read."
              : summary.totalTeamCount === 0
                ? "Repositories and design files each team connects, with how well they are reading."
                : summary.disconnectedCount > 0
                  ? summary.disconnectedCount === summary.totalTeamCount
                    ? `None of the ${summary.totalTeamCount} teams have connected code or design yet. Reviewers have no project work to open.`
                    : `${summary.disconnectedCount} of ${summary.totalTeamCount} teams have not connected code or design. Reviewers have no project work to open for those teams.`
                  : summary.attentionCount > 0
                    ? `Every team has connected something, but ${summary.attentionCount} ${summary.attentionCount === 1 ? "connection is" : "connections are"} not reading properly. Their recent work will look emptier than it is.`
                    : `All ${summary.totalTeamCount} teams have code or design connected and reading normally.`}
          </p>
        </div>
      </div>

      {summary !== undefined && outstanding > 0 && outstanding < summary.totalTeamCount ? (
        <div className="integration-toolbar">
          <div className="configuration-tabs" role="tablist" aria-label="Which teams to show">
            <button
              aria-selected={view === "attention"}
              className={view === "attention" ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => setView("attention")}
            >
              Needs a look · {outstanding}
            </button>
            <button
              aria-selected={view === "all"}
              className={view === "all" ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => setView("all")}
            >
              Every team · {summary.totalTeamCount}
            </button>
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
      ) : summary !== undefined && summary.totalTeamCount > 6 ? (
        <label className="compact-search integration-search-only">
          <span className="visually-hidden">Find a team</span>
          <input
            type="search"
            placeholder="Find a team"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      ) : null}

      {status === "LoadingFirstPage" ? (
        <>
          <LoadingLabel>Loading connected code and design</LoadingLabel>
          <SkeletonList rows={5} />
        </>
      ) : (
        <div className="integration-health-list">
          {visible.map((team) => {
            const note = teamNote(team);
            const connected = team.github.repositoryCount + team.figma.fileCount;
            const expanded = expandedTeamId === team.teamId;
            return (
              <article className="integration-health-row" key={team.teamId}>
                <span
                  className={`row-glyph ${isDisconnected(team) ? "critical" : needsAttention(team) ? "attention" : ""}`}
                >
                  <Icon name="users" />
                </span>
                <div className="row-text">
                  <strong>
                    {team.teamName}
                    {team.teamStatus === "confirmed" ? null : (
                      <span className="row-context"> · {teamStatusLabels[team.teamStatus]}</span>
                    )}
                  </strong>
                  {note === null ? null : <small>{note}</small>}
                </div>
                <div className="integration-row-side">
                  <ProviderCount
                    count={team.github.repositoryCount}
                    health={team.github.health}
                    icon="github"
                    name="GitHub"
                    unit="repository"
                    units="repositories"
                  />
                  <ProviderCount
                    count={team.figma.fileCount}
                    health={team.figma.health}
                    icon="figma"
                    name="Figma"
                    unit="file"
                    units="files"
                  />
                  {connected > 0 ? (
                    <button
                      aria-expanded={expanded}
                      className="row-action"
                      type="button"
                      onClick={() =>
                        setExpandedTeamId((current) =>
                          current === team.teamId ? null : team.teamId,
                        )
                      }
                    >
                      {expanded ? "Hide" : "Open"}
                    </button>
                  ) : null}
                </div>
                {expanded ? <IntegrationDetails team={team} /> : null}
              </article>
            );
          })}
          {visible.length === 0 ? (
            <p className="empty">
              {summary?.totalTeamCount === 0
                ? "No teams are available in this workspace."
                : normalizedSearch.length > 0
                  ? `No team matches “${search.trim()}”.`
                  : view === "attention"
                    ? "No affected teams are in the rows loaded so far."
                    : "No team rows have been loaded."}
            </p>
          ) : null}
        </div>
      )}
      {status === "CanLoadMore" ? (
        <button className="secondary" type="button" onClick={() => loadMore(30)}>
          Load more teams
        </button>
      ) : null}
    </section>
  );
}

function IntegrationDetails({ team }: { team: IntegrationTeam }) {
  const details = useQuery(api.integrationOperations.details, {
    eventSlug,
    teamId: team.teamId,
  });
  const openFullCheckpoint = useAction(api.figmaActions.openFullCheckpoint);
  const [checkpointBusy, setCheckpointBusy] = useState<string | null>(null);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [checkpointLinks, setCheckpointLinks] = useState<Record<string, CheckpointLink>>({});
  const [checkpointClock, setCheckpointClock] = useState(() => performance.now());

  useEffect(() => {
    const nextExpiry = Object.values(checkpointLinks)
      .map((link) => link.clientNow + link.expiresAt - link.serverNow)
      .filter((expiresAt) => expiresAt > checkpointClock)
      .toSorted((left, right) => left - right)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => setCheckpointClock(performance.now()),
      Math.max(nextExpiry - performance.now(), 0) + 25,
    );
    return () => window.clearTimeout(timer);
  }, [checkpointClock, checkpointLinks]);

  if (details === undefined) {
    return (
      <>
        <LoadingLabel>Loading what this team connected</LoadingLabel>
        <SkeletonList rows={2} />
      </>
    );
  }

  return (
    <div className="integration-team-detail">
      {details.githubRepositories.length > 0 ? (
        <div>
          <h3>
            <Icon name="github" /> Repositories
          </h3>
          <ul className="integration-file-list">
            {details.githubRepositories.map((repository) => (
              <li key={repository.bindingId}>
                <div>
                  <a href={repository.url} target="_blank" rel="noreferrer">
                    {repository.fullName}
                  </a>
                  <small>
                    {repository.customKind ?? repositoryKindLabels[repository.kind]} ·{" "}
                    {repository.purpose}
                  </small>
                  <small>
                    {repository.trackedBranch}
                    {repository.rootPath ? ` / ${repository.rootPath}` : ""}
                    {repository.topicState === "present"
                      ? ""
                      : ` · ${githubRepositoryTopicStateLabels[repository.topicState]}`}
                    {repository.syncState === "ready"
                      ? ""
                      : ` · ${githubRepositorySyncStateLabels[repository.syncState]}`}
                  </small>
                  <small>
                    {plural(repository.commitCount, "commit", "commits")} ·{" "}
                    {plural(repository.pushCount, "push", "pushes")} · +{repository.additions} −
                    {repository.deletions} in {plural(repository.changedFiles, "file", "files")}
                  </small>
                  {repository.completeness === "complete" && !repository.compareTruncated ? null : (
                    <small>
                      {githubRepositoryCoverageLabels[repository.completeness]}
                      {repository.compareTruncated
                        ? ", and GitHub cut the list of changed files short"
                        : ""}
                    </small>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {details.figmaFiles.length > 0 ? (
        <div>
          <h3>
            <Icon name="figma" /> Design files
          </h3>
          <ul className="integration-file-list">
            {details.figmaFiles.map((file) => {
              const checkpoint = checkpointLinks[file.bindingId];
              const activeCheckpoint =
                checkpoint &&
                checkpoint.expiresAt > checkpoint.serverNow + checkpointClock - checkpoint.clientNow
                  ? checkpoint
                  : null;
              return (
                <li key={file.bindingId}>
                  <div>
                    <a href={file.url} target="_blank" rel="noreferrer">
                      {file.name}
                    </a>
                    <small>{file.role}</small>
                    <small>{figmaActivity(file.lastMetadataCheckAt, file.lastFullCaptureAt)}</small>
                    {file.contentDirty ? <small>Changed since the last capture</small> : null}
                    {file.metadataRateLimitRetryAt ? (
                      <small>
                        Paused by Figma's rate limit, retrying{" "}
                        {activityTime(file.metadataRateLimitRetryAt) ?? "soon"}
                      </small>
                    ) : null}
                    <small>
                      {file.preview.availableCount} of{" "}
                      {plural(file.preview.selectedNodeCount, "frame", "frames")}
                      {file.preview.state === "ready"
                        ? ""
                        : ` · ${figmaPreviewStateLabels[file.preview.state]}`}
                      {file.preview.truncated ? " · only the first frames were taken" : ""}
                    </small>
                  </div>
                  {details.canReadFigmaArtifacts && file.hasFullArtifact ? (
                    activeCheckpoint ? (
                      <a
                        className="text-button"
                        href={activeCheckpoint.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open checkpoint
                      </a>
                    ) : (
                      <button
                        className="text-button"
                        type="button"
                        disabled={checkpointBusy === file.bindingId}
                        onClick={() => {
                          setCheckpointBusy(file.bindingId);
                          setCheckpointError(null);
                          void openFullCheckpoint({ eventSlug, bindingId: file.bindingId })
                            .then((result) => {
                              const clientNow = performance.now();
                              setCheckpointLinks((current) => ({
                                ...current,
                                [file.bindingId]: { ...result, clientNow },
                              }));
                              setCheckpointClock(clientNow);
                            })
                            .catch((error: unknown) => setCheckpointError(readableError(error)))
                            .finally(() => setCheckpointBusy(null));
                        }}
                      >
                        {checkpointBusy === file.bindingId ? "Preparing…" : "Prepare checkpoint"}
                      </button>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {checkpointError ? (
        <p className="notice error" role="alert">
          {checkpointError}
        </p>
      ) : null}
    </div>
  );
}

function figmaActivity(lastCheckedAt: number | undefined, lastCapturedAt: number | undefined) {
  const checked = activityTime(lastCheckedAt);
  const captured = activityTime(lastCapturedAt);
  if (!checked && !captured) return "No activity yet";
  if (!checked) return `Captured ${captured}`;
  if (!captured) return `Checked ${checked}`;
  return `Checked ${checked} · captured ${captured}`;
}
