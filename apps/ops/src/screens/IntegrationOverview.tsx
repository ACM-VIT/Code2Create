import { api } from '@code2create/backend/api'
import {
  figmaPreviewStateLabels,
  githubRepositoryCoverageLabels,
  githubRepositorySyncStateLabels,
  githubRepositoryTopicStateLabels,
  integrationProviderHealthLabels,
  repositoryKindLabels,
  teamStatusLabels,
} from '@code2create/domain'
import { useAction, usePaginatedQuery, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { Icon } from '../components/Icon'
import type { IconName } from '../components/Icon'
import { LoadingLabel, SkeletonList } from '../components/Skeleton'

type IntegrationTeam = FunctionReturnType<typeof api.integrationOperations.teams>['page'][number]
type ProviderHealth = IntegrationTeam['github']['health']
type IntegrationView = 'attention' | 'all'

function activityTime(value: number | undefined) {
  if (value === undefined) return null
  return new Date(value).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function plural(count: number, singular: string, many: string) {
  return `${count} ${count === 1 ? singular : many}`
}

/** A team nobody can look at: nothing connected on either side. */
function isDisconnected(team: IntegrationTeam) {
  return team.github.health === 'not_connected' && team.figma.health === 'not_connected'
}

function needsAttention(team: IntegrationTeam) {
  return team.github.health === 'needs_attention' || team.figma.health === 'needs_attention'
}

/**
 * Teams a reviewer cannot look at come first, then teams whose connection is
 * broken, then everything working. A page of identical "Not connected" rows in
 * team order told an operator nothing about where to spend the next five minutes.
 */
function teamRank(team: IntegrationTeam) {
  if (isDisconnected(team)) return 0
  if (needsAttention(team)) return 1
  return 2
}

/**
 * The provider is a glyph, not a repeated heading. Fourteen rows that each
 * spelled out "GitHub" and "Figma" above "Nothing connected" said the same six
 * strings fourteen times; the mark plus a count carries it in one glance.
 */
function providerTone(health: ProviderHealth) {
  if (health === 'needs_attention') return 'attention'
  if (health === 'not_connected') return 'unconnected'
  return 'ready'
}

function ProviderCount({
  count,
  health,
  icon,
  name,
  unit,
  units,
}: {
  count: number
  health: ProviderHealth
  icon: IconName
  name: string
  unit: string
  units: string
}) {
  const state = integrationProviderHealthLabels[health]
  return (
    <span
      className={`integration-provider ${providerTone(health)}`}
      title={`${name}: ${plural(count, unit, units)}, ${state.toLowerCase()}`}
    >
      <Icon name={icon} />
      <span className="visually-hidden">{`${name}: ${plural(count, unit, units)}, ${state}. `}</span>
      <span aria-hidden="true">{count}</span>
    </span>
  )
}

/**
 * The one line that differs between rows. A team with nothing connected gets no
 * line at all: the headline already says what that means, and the two dimmed
 * marks on the right say it again without words.
 */
function teamNote(team: IntegrationTeam) {
  const notes: string[] = []
  if (team.github.topicMissingCount > 0) {
    notes.push(`${plural(team.github.topicMissingCount, 'repository', 'repositories')} missing the event topic`)
  }
  if (team.github.incompleteCount > 0) {
    notes.push(`${plural(team.github.incompleteCount, 'repository', 'repositories')} only partly counted`)
  }
  if (team.figma.rateLimitedCount > 0) {
    notes.push(`${plural(team.figma.rateLimitedCount, 'file', 'files')} paused by Figma's rate limit`)
  }
  if (team.figma.dirtyCount > 0) {
    notes.push(`${plural(team.figma.dirtyCount, 'file', 'files')} changed since the last capture`)
  }
  if (team.figma.incompleteCount > 0) {
    notes.push(`${plural(team.figma.incompleteCount, 'file', 'files')} only partly captured`)
  }
  if (notes.length > 0) return notes.join(' · ')
  if (needsAttention(team)) {
    return team.github.health === 'needs_attention'
      ? 'GitHub is not reading properly'
      : 'Figma is not reading properly'
  }
  // A team with nothing connected is the reason this screen exists, so its row
  // says what is missing rather than leaving the only line blank.
  if (isDisconnected(team)) return 'No repository and no design file'
  if (team.github.health === 'not_connected') return 'No repository'
  if (team.figma.health === 'not_connected') return 'No design file'
  const latest = activityTime(
    Math.max(team.github.lastActivityAt ?? 0, team.figma.lastActivityAt ?? 0) || undefined,
  )
  return latest === null ? null : `Last change ${latest}`
}

export function IntegrationOverview() {
  const [chosen, setView] = useState<IntegrationView | null>(null)
  const [expandedTeamId, setExpandedTeamId] = useState<IntegrationTeam['teamId'] | null>(null)
  const { results, status, loadMore } = usePaginatedQuery(
    api.integrationOperations.teams,
    { eventSlug },
    { initialNumItems: 30 },
  )
  const unwatchable = results.filter(isDisconnected)
  const broken = results.filter((team) => !isDisconnected(team) && needsAttention(team))
  const outstanding = unwatchable.length + broken.length
  const view = chosen ?? (outstanding > 0 ? 'attention' : 'all')
  const visible = (view === 'attention'
    ? results.filter((team) => teamRank(team) < 2)
    : results
  ).sort((left, right) => teamRank(left) - teamRank(right) || left.teamName.localeCompare(right.teamName))

  return (
    <section className="integration-health-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Connected project work</p>
          <h1>Code and design</h1>
          <p className="muted">
            {results.length === 0
              ? 'Teams connect their GitHub repositories and Figma files from their own dashboard. None have been loaded yet.'
              : unwatchable.length > 0
                ? `${unwatchable.length} of ${results.length} teams have connected no code and no design. A reviewer opening those teams has nothing to look at.`
                : broken.length > 0
                  ? `Every team has connected something, but ${broken.length} ${broken.length === 1 ? 'connection is' : 'connections are'} not reading properly. Their recent work will look emptier than it is.`
                  : `All ${results.length} teams have code or design connected and reading normally.`}
          </p>
        </div>
      </div>

      {outstanding > 0 && outstanding < results.length ? (
        <div className="configuration-tabs" role="tablist" aria-label="Which teams to show">
          <button
            aria-selected={view === 'attention'}
            className={view === 'attention' ? 'active' : ''}
            role="tab"
            type="button"
            onClick={() => setView('attention')}
          >
            Needs a look · {outstanding}
          </button>
          <button
            aria-selected={view === 'all'}
            className={view === 'all' ? 'active' : ''}
            role="tab"
            type="button"
            onClick={() => setView('all')}
          >
            Every team · {results.length}
          </button>
        </div>
      ) : null}

      {status === 'LoadingFirstPage' ? (
        <>
          <LoadingLabel>Loading connected code and design</LoadingLabel>
          <SkeletonList rows={5} />
        </>
      ) : (
        <div className="integration-health-list">
          {visible.map((team) => {
            const note = teamNote(team)
            const connected = team.github.repositoryCount + team.figma.fileCount
            const expanded = expandedTeamId === team.teamId
            return (
              <article className="integration-health-row" key={team.teamId}>
                <span className={`row-glyph ${isDisconnected(team) ? 'critical' : needsAttention(team) ? 'attention' : ''}`}>
                  <Icon name="users" />
                </span>
                <div className="row-text">
                  {/* The ordinary status repeated on every row taught nothing.
                      It appears only when it changes whether the missing work
                      still matters. */}
                  <strong>
                    {team.teamName}
                    {team.teamStatus === 'confirmed' ? null : (
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
                      onClick={() => setExpandedTeamId((current) => (current === team.teamId ? null : team.teamId))}
                    >
                      {expanded ? 'Hide' : 'Open'}
                    </button>
                  ) : null}
                </div>
                {expanded ? <IntegrationDetails team={team} /> : null}
              </article>
            )
          })}
          {visible.length === 0 ? (
            <p className="empty">
              {results.length === 0
                ? 'No team has connected code or design yet.'
                : 'Every team loaded so far is connected and reading normally.'}
            </p>
          ) : null}
        </div>
      )}
      {status === 'CanLoadMore' ? (
        <button className="secondary" type="button" onClick={() => loadMore(30)}>Load more teams</button>
      ) : null}
    </section>
  )
}

function IntegrationDetails({ team }: { team: IntegrationTeam }) {
  const details = useQuery(api.integrationOperations.details, {
    eventSlug,
    teamId: team.teamId,
  })
  const openFullCheckpoint = useAction(api.figmaActions.openFullCheckpoint)
  const [checkpointBusy, setCheckpointBusy] = useState<string | null>(null)
  const [checkpointError, setCheckpointError] = useState<string | null>(null)
  const [checkpointLinks, setCheckpointLinks] = useState<
    Record<string, { url: string; expiresAt: number; sha256: string; capturedAt: number }>
  >({})

  if (details === undefined) {
    return (
      <>
        <LoadingLabel>Loading what this team connected</LoadingLabel>
        <SkeletonList rows={2} />
      </>
    )
  }

  return (
    <div className="integration-team-detail">
      {details.githubRepositories.length > 0 ? (
        <div>
          <h3><Icon name="github" /> Repositories</h3>
          <ul className="integration-file-list">
            {details.githubRepositories.map((repository) => (
              <li key={repository.bindingId}>
                <div>
                  <a href={repository.url} target="_blank" rel="noreferrer">{repository.fullName}</a>
                  <small>
                    {repository.customKind ?? repositoryKindLabels[repository.kind]} · {repository.purpose}
                  </small>
                  <small>
                    {repository.trackedBranch}{repository.rootPath ? ` / ${repository.rootPath}` : ''}
                    {repository.topicState === 'present' ? '' : ` · ${githubRepositoryTopicStateLabels[repository.topicState]}`}
                    {repository.syncState === 'ready' ? '' : ` · ${githubRepositorySyncStateLabels[repository.syncState]}`}
                  </small>
                  <small>
                    {plural(repository.commitCount, 'commit', 'commits')} · {plural(repository.pushCount, 'push', 'pushes')} · +{repository.additions} −{repository.deletions} in {plural(repository.changedFiles, 'file', 'files')}
                  </small>
                  {repository.completeness === 'complete' && !repository.compareTruncated ? null : (
                    <small>
                      {githubRepositoryCoverageLabels[repository.completeness]}
                      {repository.compareTruncated ? ', and GitHub cut the list of changed files short' : ''}
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
          <h3><Icon name="figma" /> Design files</h3>
          <ul className="integration-file-list">
            {details.figmaFiles.map((file) => {
              const checkpoint = checkpointLinks[file.bindingId]
              return (
                <li key={file.bindingId}>
                  <div>
                    <a href={file.url} target="_blank" rel="noreferrer">{file.name}</a>
                    <small>{file.role}</small>
                    <small>{figmaActivity(file.lastMetadataCheckAt, file.lastFullCaptureAt)}</small>
                    {file.contentDirty ? <small>Changed since the last capture</small> : null}
                    {file.metadataRateLimitRetryAt ? (
                      <small>Paused by Figma's rate limit, retrying {activityTime(file.metadataRateLimitRetryAt) ?? 'soon'}</small>
                    ) : null}
                    <small>
                      {file.preview.availableCount} of {plural(file.preview.selectedNodeCount, 'frame', 'frames')}
                      {file.preview.state === 'ready' ? '' : ` · ${figmaPreviewStateLabels[file.preview.state]}`}
                      {file.preview.truncated ? ' · only the first frames were taken' : ''}
                    </small>
                  </div>
                  {details.canReadFigmaArtifacts && file.hasFullArtifact ? (
                    checkpoint && checkpoint.expiresAt > Date.now() ? (
                      <a
                        className="text-button"
                        href={checkpoint.url}
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
                          setCheckpointBusy(file.bindingId)
                          setCheckpointError(null)
                          void openFullCheckpoint({ eventSlug, bindingId: file.bindingId })
                            .then((result) => {
                              setCheckpointLinks((current) => ({
                                ...current,
                                [file.bindingId]: result,
                              }))
                            })
                            .catch((error: unknown) => setCheckpointError(readableError(error)))
                            .finally(() => setCheckpointBusy(null))
                        }}
                      >
                        {checkpointBusy === file.bindingId ? 'Preparing…' : 'Prepare checkpoint'}
                      </button>
                    )
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      {checkpointError ? <p className="notice error" role="alert">{checkpointError}</p> : null}
    </div>
  )
}

function figmaActivity(lastCheckedAt: number | undefined, lastCapturedAt: number | undefined) {
  const checked = activityTime(lastCheckedAt)
  const captured = activityTime(lastCapturedAt)
  if (!checked && !captured) return 'No activity yet'
  if (!checked) return `Captured ${captured}`
  if (!captured) return `Checked ${checked}`
  return `Checked ${checked} · captured ${captured}`
}
