import { api } from '@code2create/backend/api'
import { usePaginatedQuery, useQuery } from 'convex/react'
import { useState } from 'react'

import { eventSlug } from '../lib/config'

type CheckpointKey = 'ideation' | 'intermediate_update' | 'final_update'
type Availability = 'awaiting_confirmation' | 'upcoming' | 'open' | 'late' | 'closed' | 'submitted'

/** What each state means for the team, rather than for the window. */
const availabilityLabels: Record<Availability, string> = {
  awaiting_confirmation: 'Has not confirmed its place',
  upcoming: 'Not open yet',
  open: 'Can still submit',
  late: 'Late, can still submit',
  closed: 'Missed the window',
  submitted: 'Submitted',
}

export function ProjectCheckpointOverview() {
  const eventState = useQuery(api.projectCheckpoints.eventState, { eventSlug })
  const [checkpointKey, setCheckpointKey] = useState<CheckpointKey>('ideation')
  const teams = usePaginatedQuery(
    api.projectCheckpoints.teams,
    eventState?.configured ? { eventSlug, checkpointKey } : 'skip',
    { initialNumItems: 40 },
  )

  if (eventState === undefined) return <p className="muted">Loading team updates…</p>

  const checkpoint = eventState.checkpoints.find(
    (candidate) => candidate.checkpointKey === checkpointKey,
  )
  // Teams that still owe an update come first; a page that leads with the ones
  // already done makes you scroll to find the work.
  const rows = [...teams.results].sort((left, right) => {
    const leftDone = left.submittedAt !== undefined
    const rightDone = right.submittedAt !== undefined
    if (leftDone !== rightDone) return leftDone ? 1 : -1
    return left.teamName.localeCompare(right.teamName)
  })
  const submitted = rows.filter((team) => team.submittedAt !== undefined).length
  const outstanding = rows.length - submitted

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
        <p className="notice">Publish both the event phases and checkpoint plan to open this view.</p>
      ) : (
        <>
          <nav className="stage-filter" aria-label="Project checkpoints">
            {eventState.checkpoints.map((candidate) => (
              <button
                aria-current={candidate.checkpointKey === checkpointKey}
                className={candidate.checkpointKey === checkpointKey ? 'stage-chip active' : 'stage-chip'}
                key={candidate.checkpointKey}
                type="button"
                onClick={() => setCheckpointKey(candidate.checkpointKey)}
              >
                {candidate.displayName}
              </button>
            ))}
          </nav>

          {checkpoint ? (
            <div className="catalog-summary">
              <Stat
                label="Still to submit"
                value={teams.status === 'LoadingFirstPage' ? '—' : String(outstanding)}
              />
              <Stat
                label="Submitted"
                value={teams.status === 'LoadingFirstPage' ? '—' : `${submitted} of ${rows.length}`}
              />
              <Stat label="Due" value={formatTime(checkpoint.dueAt)} />
              <Stat label="Closes" value={formatTime(checkpoint.closesAt)} />
            </div>
          ) : null}

          <div className="checkpoint-operations-list">
            {rows.map((team) => (
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
                    ? `Submitted ${formatTime(team.submittedAt)}${team.timing === 'late' ? ' · late' : ''}`
                    : team.draftVersion
                      ? 'Draft saved, not submitted'
                      : 'Not started'}
                </small>
              </article>
            ))}
            {teams.status === 'LoadingFirstPage' ? (
              <p className="muted">Loading teams…</p>
            ) : null}
            {rows.length === 0 && teams.status !== 'LoadingFirstPage' ? (
              <p className="muted">No team is expected to give this update.</p>
            ) : null}
          </div>
          {teams.status === 'CanLoadMore' ? (
            <button className="secondary" type="button" onClick={() => teams.loadMore(40)}>
              Load more
            </button>
          ) : null}
        </>
      )}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
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
