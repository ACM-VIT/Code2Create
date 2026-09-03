import { api } from '@code2create/backend/api'
import { reviewRoundStatusLabels } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useQuery } from 'convex/react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import {
  formatMonthDayTime as formatTime,
  formatMonthDayTimeWindow as formatWindow,
} from '../lib/dateTime'
import { LoadingLabel, SkeletonList } from '../components/Skeleton'

type Round = FunctionReturnType<typeof api.scoreGovernance.rounds>[number]

const exportStateLabels: Record<NonNullable<Round['exportState']>, string> = {
  generating: 'Preparing files',
  uploaded: 'Ready to verify',
  verified: 'Verified',
  failed: 'Could not prepare files',
  superseded: 'Replaced by a newer export',
}

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
          <p className="muted">Open a round to finish missing work, close judging, or publish participant feedback.</p>
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
                value={round.exportState ? exportStateLabels[round.exportState] : 'Not started'}
              />
              <Summary label="Scores" value={round.canReadValues ? 'Visible' : 'Hidden'} />
              <Summary label="Participant feedback" value={round.releasedAt ? 'Released' : 'Not released'} />
            </dl>
            {round.releasedAt ? (
              <p className="panel-strip"><span>Released {formatTime(round.releasedAt)}</span></p>
            ) : null}
          </article>
        ))}
      </div>

      {rounds.length === 0 ? (
        <div className="empty-state">
          <h2>No results to show yet</h2>
          <p className="muted">Publish a review round before results can be tracked.</p>
        </div>
      ) : null}
    </section>
  )
}

function Summary({ label, value }: { label: string; value: number | string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}
