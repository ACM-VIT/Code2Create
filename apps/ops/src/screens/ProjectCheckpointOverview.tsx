import { api } from '@code2create/backend/api'
import { usePaginatedQuery, useQuery } from 'convex/react'
import { useState } from 'react'

import { eventSlug } from '../lib/config'

export function ProjectCheckpointOverview() {
  const eventState = useQuery(api.projectCheckpoints.eventState, { eventSlug })
  const [checkpointKey, setCheckpointKey] = useState<'ideation' | 'intermediate_update' | 'final_update'>('ideation')
  const teams = usePaginatedQuery(
    api.projectCheckpoints.teams,
    eventState?.configured ? { eventSlug, checkpointKey } : 'skip',
    { initialNumItems: 40 },
  )

  if (eventState === undefined) return <p className="muted">Loading project checkpoints…</p>

  const checkpoint = eventState.checkpoints.find((candidate) => candidate.checkpointKey === checkpointKey)

  return (
    <section className="integration-health-shell">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Team progress</p>
          <h1>Team updates</h1>
          <p className="muted">See the updates each team shares during the hack.</p>
        </div>
      </header>

      {!eventState.configured ? (
        <p className="notice">Publish both the event phases and checkpoint plan to open this view.</p>
      ) : (
        <>
          <nav className="configuration-tabs checkpoint-tabs" aria-label="Project checkpoints">
            {eventState.checkpoints.map((candidate) => (
              <button
                className={candidate.checkpointKey === checkpointKey ? 'active' : ''}
                key={candidate.checkpointKey}
                type="button"
                onClick={() => setCheckpointKey(candidate.checkpointKey)}
              >
                {candidate.displayName}
              </button>
            ))}
          </nav>
          {checkpoint ? (
            <p className="muted checkpoint-window-copy">
              {checkpoint.phaseName} · due {formatTime(checkpoint.dueAt)} · closes {formatTime(checkpoint.closesAt)}
            </p>
          ) : null}
          <div className="checkpoint-operations-list">
            {teams.results.map((team) => (
              <article className="checkpoint-operations-row" key={team.teamId}>
                <div>
                  <strong>{team.teamName}</strong>
                  <span>{stateName(team.teamStatus)}</span>
                </div>
                <span className={`health-state ${team.availability}`}>{stateName(team.availability)}</span>
                <div className="checkpoint-operations-answer">
                  <p>{team.updateText ?? 'No saved update.'}</p>
                  {team.followUpAnswer ? <small>{team.followUpAnswer}</small> : null}
                </div>
                <small>
                  {team.submittedAt
                    ? `Submitted ${formatTime(team.submittedAt)}${team.timing ? ` · ${stateName(team.timing)}` : ''}`
                    : team.draftVersion
                      ? 'Draft saved'
                      : 'Not started'}
                </small>
              </article>
            ))}
          </div>
          {teams.results.length === 0 && teams.status !== 'LoadingFirstPage' ? (
            <p className="muted">No teams are available for this update.</p>
          ) : null}
          {teams.status === 'CanLoadMore' ? (
            <button className="secondary" type="button" onClick={() => teams.loadMore(40)}>Load more</button>
          ) : null}
        </>
      )}
    </section>
  )
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function stateName(value: string) {
  const words = value.replaceAll('_', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
