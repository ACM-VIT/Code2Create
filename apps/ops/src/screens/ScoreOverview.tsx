import { api } from '@code2create/backend/api'
import { reviewRoundStatusLabels } from '@code2create/domain'
import { useQuery } from 'convex/react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'

export function ScoreOverview() {
  const rounds = useQuery(api.scoreGovernance.rounds, { eventSlug })

  if (rounds === undefined) return <p className="muted">Loading results…</p>

  return (
    <section className="review-shell">
      <header className="page-heading">
        <div>
          <p className="eyebrow">After judging</p>
          <h1>Results</h1>
          <p className="muted">Track which scorecards are complete. Scores stay hidden until results are opened.</p>
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
              <Summary label="Valid results" value={round.completedReviewCount} />
              <Summary label="Unresolved teams" value={round.unresolvedTeamCount} />
              <Summary label="Open corrections" value={round.unresolvedCorrectionCount} />
              <Summary
                label="Round export"
                value={round.exportState ? stateName(round.exportState) : 'Not started'}
              />
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
