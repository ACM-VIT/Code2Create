import { api } from '@code2create/backend/api'
import { reviewRoundStatusLabels } from '@code2create/domain'
import { useQuery } from 'convex/react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { LoadingLabel, SkeletonList } from '../components/Skeleton'

export function ScoreOverview() {
  const rounds = useQuery(api.scoreGovernance.rounds, { eventSlug })

  if (rounds === undefined) {
    return (
      <section className="review-shell">
        <LoadingLabel>Loading the judging rounds</LoadingLabel>
        <SkeletonList rows={3} />
      </section>
    )
  }

  return (
    <section className="review-shell">
      <header className="page-heading">
        <div>
          <p className="eyebrow">After judging</p>
          <h1>Results</h1>
          <p className="muted">Open a round to inspect completeness. Numeric values stay hidden until requested.</p>
        </div>
      </header>

      <div className="review-round-list">
        {rounds.map((round) => (
          <article className="review-round-card" key={round.id}>
            <div className="review-round-heading">
              <div>
                <div className="session-title-line">
                  <h2>{round.name}</h2>
                  <span className="state-label">{reviewRoundStatusLabels[round.status]}</span>
                </div>
                <p className="muted">{formatWindow(round.startsAt, round.endsAt)}</p>
              </div>
              <Link className="secondary compact-link" to={`/scores/${round.id}`}>Open results</Link>
            </div>
            <dl className="score-summary-grid">
              <Summary
                label="Round export"
                value={round.exportState ? stateName(round.exportState) : 'Not started'}
              />
              <Summary label="Numeric values" value={round.canReadValues ? 'Available' : 'Hidden'} />
              <Summary label="Participant feedback" value={round.releasedAt ? 'Released' : 'Not released'} />
            </dl>
            <p className="panel-strip">
              <span>{round.canReadValues ? 'Scores visible' : 'Progress only'}</span>
              {round.releasedAt ? <span>Released {formatTime(round.releasedAt)}</span> : null}
            </p>
          </article>
        ))}
      </div>

      {rounds.length === 0 ? (
        <div className="empty-state">
          <h2>No visible score rounds</h2>
          <p className="muted">Publish a review round before results can be tracked.</p>
        </div>
      ) : null}
    </section>
  )
}

function Summary({ label, value }: { label: string; value: number | string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function stateName(value: string) {
  return value.replaceAll('_', ' ')
}

function formatWindow(startsAt: number, endsAt: number) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${formatter.format(startsAt)} – ${formatter.format(endsAt)}`
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}
