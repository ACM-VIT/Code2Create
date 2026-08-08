import { api } from '@code2create/backend/api'
import { useAction, usePaginatedQuery, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type IntegrationTeam = FunctionReturnType<typeof api.integrationOperations.teams>['page'][number]

function healthLabel(value: string) {
  if (value === 'not_connected') return 'Not connected'
  if (value === 'needs_attention') return 'Needs attention'
  if (value === 'syncing') return 'Syncing'
  return 'Ready'
}

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

function stateLabel(value: string) {
  const words = value.replaceAll('_', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function IntegrationOverview() {
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [expandedTeamId, setExpandedTeamId] = useState<IntegrationTeam['teamId'] | null>(null)
  const { results, status, loadMore } = usePaginatedQuery(
    api.integrationOperations.teams,
    { eventSlug },
    { initialNumItems: 30 },
  )
  const visible = attentionOnly
    ? results.filter(
        (team) =>
          team.github.health === 'needs_attention' || team.figma.health === 'needs_attention',
      )
    : results

  return (
    <section className="integration-health-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Connected project work</p>
          <h1>Code and design</h1>
          <p className="muted">See the GitHub repositories and Figma files each team connected. Activity is context, not a score.</p>
        </div>
        <label className="check-filter">
          <input
            type="checkbox"
            checked={attentionOnly}
            onChange={(event) => setAttentionOnly(event.target.checked)}
          />
          <span>Needs attention</span>
        </label>
      </div>

      <div className="integration-health-list">
        {visible.map((team) => (
          <article className="integration-health-row" key={team.teamId}>
            <div className="integration-team-name">
              <strong>{team.teamName}</strong>
              <span>{stateLabel(team.teamStatus)}</span>
            </div>
            <div className="provider-health">
              <div>
                <span>GitHub</span>
                <small className={`health-state ${team.github.health}`}>
                  {healthLabel(team.github.health)}
                </small>
              </div>
              <p>{itemCount(team.github.repositoryCount, 'repository', 'repositories')} connected</p>
              <small>
                {team.github.topicMissingCount > 0 ? `${team.github.topicMissingCount} missing topic · ` : ''}
                {team.github.incompleteCount > 0 ? `${team.github.incompleteCount} incomplete · ` : ''}
                {activityTime(team.github.lastActivityAt) ?? 'No activity yet'}
              </small>
            </div>
            <div className="provider-health">
              <div>
                <span>Figma</span>
                <small className={`health-state ${team.figma.health}`}>
                  {healthLabel(team.figma.health)}
                </small>
              </div>
              <p>{itemCount(team.figma.fileCount, 'file', 'files')} connected</p>
              <small>
                {team.figma.rateLimitedCount > 0 ? `${team.figma.rateLimitedCount} rate limited · ` : ''}
                {team.figma.dirtyCount > 0 ? `${team.figma.dirtyCount} pending · ` : ''}
                {team.figma.incompleteCount > 0 ? `${team.figma.incompleteCount} incomplete · ` : ''}
                {figmaActivity(team.figma.oldestMetadataCheckAt, team.figma.lastCaptureAt)}
              </small>
            </div>
            <button
              className="text-button"
              type="button"
              onClick={() => setExpandedTeamId((current) => current === team.teamId ? null : team.teamId)}
            >
              {expandedTeamId === team.teamId ? 'Hide details' : 'Show details'}
            </button>
            {expandedTeamId === team.teamId ? <IntegrationDetails team={team} /> : null}
          </article>
        ))}
        {status === 'LoadingFirstPage' ? <p className="muted">Loading integrations…</p> : null}
        {status !== 'LoadingFirstPage' && visible.length === 0 ? (
          <p className="empty">No teams in this page match the current view.</p>
        ) : null}
      </div>
      {status === 'CanLoadMore' ? (
        <button className="secondary" type="button" onClick={() => loadMore(30)}>Load more</button>
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

  if (details === undefined) return <p className="muted">Loading team evidence…</p>

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
                    {repository.customKind ?? stateLabel(repository.kind)} · {repository.purpose}
                  </small>
                  <small>
                    {repository.trackedBranch}{repository.rootPath ? ` / ${repository.rootPath}` : ''} · topic {stateLabel(repository.topicState)} · {stateLabel(repository.syncState)}
                  </small>
                  <small>
                    {repository.commitCount} commits · {repository.pushCount} pushes · +{repository.additions} −{repository.deletions} · {repository.changedFiles} files
                  </small>
                  {repository.completeness !== 'complete' || repository.compareTruncated ? (
                    <small>Coverage is {stateLabel(repository.completeness)}{repository.compareTruncated ? ' · comparison file list truncated' : ''}.</small>
                  ) : null}
                  {repository.syncErrorCode ? <small>{stateLabel(repository.syncErrorCode)}</small> : null}
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
                    <small>{stateLabel(file.role)}</small>
                    <small>
                      {figmaActivity(file.lastMetadataCheckAt, file.lastFullCaptureAt)}
                    </small>
                    {file.contentDirty ? <small>Newer Figma changes are waiting for a full checkpoint.</small> : null}
                    {file.metadataRateLimitRetryAt ? (
                      <small>Metadata retry {activityTime(file.metadataRateLimitRetryAt) ?? 'pending'}</small>
                    ) : file.metadataErrorCode ? <small>{stateLabel(file.metadataErrorCode)}</small> : null}
                    <small>
                      {file.preview.availableCount}/{file.preview.selectedNodeCount} frames · {stateLabel(file.preview.state)}{file.preview.truncated ? ' · bounded selection' : ''}
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
