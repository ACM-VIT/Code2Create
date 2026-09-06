import { LiveNumber } from "../components/LiveNumber";
import { api } from "@code2create/backend/api";
import {
  githubRepositoryCoverageLabels,
  githubRepositorySyncStateLabels,
  integrationProviderHealthLabels,
  repositoryKindLabels,
  teamStatusLabels,
} from "@code2create/domain";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { eventSlug } from "../lib/config";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/Icon";
import { LoadingLabel, SkeletonList } from "../components/Skeleton";

type IntegrationData = FunctionReturnType<typeof api.integrationOperations.teams>;
type IntegrationTeam = IntegrationData["teams"][number];
type ProviderHealth = IntegrationTeam["github"]["health"];
type IntegrationView = "attention" | "disconnected" | "ready" | "all";
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
  return team.github.health === "not_connected" && !team.figmaFileUrl;
}

function needsAttention(team: IntegrationTeam) {
  return team.github.health === "needs_attention";
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
      <span aria-label={plural(count, unit, units)}><LiveNumber value={count} /></span>
    </span>
  );
}

function teamNote(team: IntegrationTeam) {
  const notes: string[] = [];
  if (team.github.incompleteCount > 0) {
    notes.push(
      `${plural(team.github.incompleteCount, "repository", "repositories")} only partly counted`,
    );
  }
  if (notes.length > 0) return notes.join(" · ");
  if (needsAttention(team)) return "GitHub is not reading properly";
  if (isDisconnected(team)) return "No repository and no design file";
  if (team.github.health === "not_connected") return "No repository";
  if (!team.figmaFileUrl) return "No design file";
  const latest = activityTime(
    team.github.lastActivityAt,
  );
  return latest === null ? null : `Last change ${latest}`;
}

export function IntegrationOverview() {
  const data = useQuery(api.integrationOperations.teams, { eventSlug });
  if (data === undefined) {
    return <section className="integration-health-shell">
      <LoadingLabel>Loading selected teams’ code and design</LoadingLabel>
      <SkeletonList rows={5} />
    </section>;
  }
  return <IntegrationOverviewContent data={data} />;
}

export function IntegrationOverviewContent({ data }: { data: IntegrationData }) {
  const [view, setView] = useState<IntegrationView>("all");
  const [expandedTeamId, setExpandedTeamId] = useState<IntegrationTeam["teamId"] | null>(null);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(30);
  const { teams, summary } = data;
  const outstanding = summary.disconnectedCount + summary.attentionCount;
  const readyCount = summary.totalTeamCount - outstanding;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const matching = teams.filter(team => {
    if (view === "attention" && teamRank(team) >= 2) return false;
    if (view === "disconnected" && !isDisconnected(team)) return false;
    if (view === "ready" && teamRank(team) !== 2) return false;
    return normalizedSearch.length === 0 ||
      team.teamName.toLocaleLowerCase().includes(normalizedSearch) ||
      team.teamCode.toLocaleLowerCase().includes(normalizedSearch);
  }).sort((left, right) =>
    teamRank(left) - teamRank(right) || left.teamName.localeCompare(right.teamName),
  );
  const visible = matching.slice(0, visibleCount);
  const hasFilters = view !== "all" || normalizedSearch.length > 0;
  const clearFilters = () => { setSearch(""); setView("all"); setVisibleCount(30); };

  return (
    <section className="integration-health-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Connected project work</p>
          <h1>Code and design</h1>
          <p className="muted">
            Accepted teams only, including teams awaiting RSVP and those already participating.
            {" "}{summary.totalTeamCount} selected teams · {summary.disconnectedCount} not connected · {summary.attentionCount} with connection issues.
          </p>
        </div>
      </div>

      <div className="integration-toolbar integration-filter-toolbar">
        <label className="compact-search">
          <span className="visually-hidden">Search selected teams</span>
          <input
            type="search"
            placeholder="Search team name or code"
            value={search}
            onChange={event => { setSearch(event.target.value); setVisibleCount(30); }}
          />
        </label>
        <label className="field">
          <span>Connection status</span>
          <select value={view} onChange={event => {
            const value = event.target.value;
            if (value === "all" || value === "attention" || value === "disconnected" || value === "ready") {
              setView(value); setVisibleCount(30);
            }
          }}>
            <option value="all">All selected ({summary.totalTeamCount})</option>
            <option value="attention">Needs a look ({outstanding})</option>
            <option value="disconnected">Not connected ({summary.disconnectedCount})</option>
            <option value="ready">Connected, no issues ({readyCount})</option>
          </select>
        </label>
        {hasFilters ? <button className="secondary" type="button" onClick={clearFilters}>Clear filters</button> : null}
      </div>
      <p className="muted" role="status">
        Showing {visible.length} of {matching.length} matching selected teams
      </p>
      <div className="integration-health-list">
          {visible.map((team) => {
            const note = teamNote(team);
            const connected = team.github.repositoryCount + (team.figmaFileUrl ? 1 : 0);
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
                    <span className="row-context"> · {team.teamCode}</span>
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
                    count={team.figmaFileUrl ? 1 : 0}
                    health={team.figmaFileUrl ? "ready" : "not_connected"}
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
              {summary.totalTeamCount === 0
                ? "No selected teams are available in this workspace."
                : "No selected teams match your search and connection filter."}
            </p>
          ) : null}
      </div>
      {visible.length < matching.length ? (
        <button className="secondary" type="button" onClick={() => setVisibleCount(count => count + 30)}>
          Show more teams ({matching.length - visible.length} remaining)
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
                    {repository.syncState === "ready"
                      ? ""
                      : ` · ${githubRepositorySyncStateLabels[repository.syncState]}`}
                  </small>
                  <small>
                    <LiveNumber value={repository.commitCount} /> {repository.commitCount === 1 ? "commit" : "commits"} ·{" "}
                    <LiveNumber value={repository.pushCount} /> {repository.pushCount === 1 ? "push" : "pushes"} · +<LiveNumber value={repository.additions} /> −
                    <LiveNumber value={repository.deletions} /> in <LiveNumber value={repository.changedFiles} /> {repository.changedFiles === 1 ? "file" : "files"}
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

      {details.figmaFileUrl ? (
        <div>
          <a className="text-button inline-flex p-2" href={details.figmaFileUrl} target="_blank" rel="noopener noreferrer" aria-label="View Figma design" title="View Figma design"><Icon name="figma" /></a>
        </div>
      ) : null}
    </div>
  );
}
