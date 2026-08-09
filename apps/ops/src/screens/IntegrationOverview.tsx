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
import { LoadingLabel, SkeletonList } from '../components/Skeleton'

type IntegrationTeam = FunctionReturnType<typeof api.integrationOperations.teams>['page'][number]
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

function itemCount(value: number, singular: string, plural: string) {
  if (value === 0) return `No ${plural}`
  return `${value} ${value === 1 ? singular : plural}`
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
                  : `All ${results.length} teams have code or design connected and reading normally. Activity is context for a reviewer, not a score.`}
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
          {visible.map((team) => (
            <article className="integration-health-row" key={team.teamId}>
              <div className="integration-team-name">
                <strong>{team.teamName}</strong>
                <span>{teamStatusLabels[team.teamStatus]}</span>
                <small>{teamConsequence(team)}</small>
              </div>
              <div className="provider-health">
                <div>
                  <span>GitHub</span>
                  <small className={`health-state ${team.github.health}`}>
                    {integrationProviderHealthLabels[team.github.health]}
                  </small>
                </div>
                <p>{itemCount(team.github.repositoryCount, 'repository', 'repositories')} connected</p>
                <small>
                  {team.github.topicMissingCount > 0 ? `${team.github.topicMissingCount} missing the event topic · ` : ''}
                  {team.github.incompleteCount > 0 ? `${team.github.incompleteCount} only partly counted · ` : ''}
                  {activityTime(team.github.lastActivityAt) ?? 'No activity yet'}
                </small>
              </div>
              <div className="provider-health">
                <div>
                  <span>Figma</span>
                  <small className={`health-state ${team.figma.health}`}>
                    {integrationProviderHealthLabels[team.figma.health]}
                  </small>
                </div>
                <p>{itemCount(team.figma.fileCount, 'file', 'files')} connected</p>
                <small>
                  {team.figma.rateLimitedCount > 0 ? `${team.figma.rateLimitedCount} paused by Figma's rate limit · ` : ''}
                  {team.figma.dirtyCount > 0 ? `${team.figma.dirtyCount} with newer changes not captured · ` : ''}
                  {team.figma.incompleteCount > 0 ? `${team.figma.incompleteCount} only partly captured · ` : ''}
                  {figmaActivity(team.figma.oldestMetadataCheckAt, team.figma.lastCaptureAt)}
                </small>
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => setExpandedTeamId((current) => current === team.teamId ? null : team.teamId)}
              >
                {expandedTeamId === team.teamId ? 'Hide what is connected' : 'Show what is connected'}
              </button>
              {expandedTeamId === team.teamId ? <IntegrationDetails team={team} /> : null}
            </article>
          ))}
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

/** What the state of this team's connections means for whoever reads its work. */
function teamConsequence(team: IntegrationTeam) {
  if (isDisconnected(team)) return 'Nothing for a reviewer to open'
  if (needsAttention(team)) return 'Recent work may be missing from what a reviewer sees'
  return 'A reviewer can see this team\'s work'
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
      <div>
        <h3>GitHub repositories</h3>
        {details.githubRepositories.length === 0 ? (
          <p className="muted">No repositories connected.</p>
        ) : (
          <ul className="integration-file-list">
            {details.githubRepositories.map((repository) => (
              <li key={repository.bindingId}>
                <div>
                  <a href={repository.url} target="_blank" rel="noreferrer">{repository.fullName}</a>
                  <small>
                    {repository.customKind ?? repositoryKindLabels[repository.kind]} · {repository.purpose}
                  </small>
                  <small>
                    {repository.trackedBranch}{repository.rootPath ? ` / ${repository.rootPath}` : ''} · {githubRepositoryTopicStateLabels[repository.topicState]} · {githubRepositorySyncStateLabels[repository.syncState]}
                  </small>
                  <small>
                    {repository.commitCount} commits · {repository.pushCount} pushes · +{repository.additions} −{repository.deletions} across {repository.changedFiles} files
                  </small>
                  {repository.completeness !== 'complete' || repository.compareTruncated ? (
                    <small>
                      {githubRepositoryCoverageLabels[repository.completeness]}
                      {repository.compareTruncated ? ', and GitHub cut the list of changed files short' : ''}.
                    </small>
                  ) : null}
                  {repository.syncErrorCode ? <small>GitHub said: {repository.syncErrorCode.replaceAll('_', ' ')}</small> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3>Figma files</h3>
        {details.figmaFiles.length === 0 ? (
          <p className="muted">No Figma files connected.</p>
        ) : (
          <ul className="integration-file-list">
            {details.figmaFiles.map((file) => {
              const checkpoint = checkpointLinks[file.bindingId]
              return (
                <li key={file.bindingId}>
                  <div>
                    <a href={file.url} target="_blank" rel="noreferrer">{file.name}</a>
                    <small>{file.role}</small>
                    <small>
                      {figmaActivity(file.lastMetadataCheckAt, file.lastFullCaptureAt)}
                    </small>
                    {file.contentDirty ? <small>The team has changed this file since the last capture, so a reviewer sees the older version.</small> : null}
                    {file.metadataRateLimitRetryAt ? (
                      <small>Metadata retry {activityTime(file.metadataRateLimitRetryAt) ?? 'pending'}</small>
                    ) : file.metadataErrorCode ? <small>Figma said: {file.metadataErrorCode.replaceAll('_', ' ')}</small> : null}
                    <small>
                      {file.preview.availableCount} of {file.preview.selectedNodeCount} frames · {figmaPreviewStateLabels[file.preview.state]}{file.preview.truncated ? ' · only the first frames were taken' : ''}
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
        )}
      </div>
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
