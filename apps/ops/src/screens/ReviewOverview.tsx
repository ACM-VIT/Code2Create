import { api } from '@code2create/backend/api'
import { reviewRoundStatusLabels } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { formatMonthDayTimeWindow as formatWindow } from '../lib/dateTime'
import { readableError } from '../lib/errors'
import { useMutationAttempt } from '../lib/operations'

export function ReviewOverview({ showSetup }: { showSetup: boolean }) {
  const overview = useQuery(api.reviewOperations.overview, { eventSlug })
  const openRound = useMutation(api.reviewOperations.openRound)
  const openAttempt = useMutationAttempt<FunctionReturnType<typeof api.reviewOperations.openRound>>()
  const [busyRoundId, setBusyRoundId] = useState<string | null>(null)
  const [pendingRoundId, setPendingRoundId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (overview === undefined) return <p className="muted">Loading review rounds…</p>

  const open = async (round: (typeof overview.rounds)[number]) => {
    if (pendingRoundId && pendingRoundId !== round.id) return
    if (!openAttempt.hasPending('review-round-open')) setPendingRoundId(round.id)
    setBusyRoundId(round.id)
    setError(null)
    try {
      await openAttempt.run('review-round-open', () => {
        const args = {
          eventSlug,
          roundId: round.id,
          expectedVersion: round.version,
          reason: 'Opened from the live review board',
          clientOperationId: crypto.randomUUID(),
        }
        return () => openRound(args)
      })
      setPendingRoundId(null)
    } catch (caught) {
      if (caught instanceof ConvexError) setPendingRoundId(null)
      setError(readableError(caught))
    } finally {
      setBusyRoundId(null)
    }
  }

  return (
    <section className="review-shell">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Judging</p>
          <h1>Review rounds</h1>
          <p className="muted">Queues, panels, reviewer check-in, and missing scores.</p>
        </div>
        {showSetup ? <Link className="secondary compact-link" to="/review-setup">Review setup</Link> : null}
      </header>

      <div className="review-round-list">
        {overview.rounds.map((round) => (
          <article className="review-round-card" key={round.id}>
            <div className="review-round-heading">
              <div>
                <div className="session-title-line">
                  <h2>{round.name}</h2>
                  <span className="state-label">
                    {reviewRoundStatusLabels[round.status]}
                    {round.isPaused ? ' · new reviews paused' : ''}
                  </span>
                </div>
                <p className="muted">{formatWindow(round.startsAt, round.endsAt)}</p>
              </div>
              <Link className="secondary compact-link" to={`/reviews/${round.id}`}>Open board</Link>
            </div>

            <dl className="review-counts">
              <Count label="Unassigned" value={round.stateCounts.unassigned} />
              <Count label="Queued" value={round.stateCounts.queued} />
              <Count label="Called" value={round.stateCounts.called} />
              <Count label="In review" value={round.stateCounts.inReview} />
              <Count label="Complete" value={round.stateCounts.completed} />
              <Count label="Held" value={round.stateCounts.held} />
            </dl>

            <div className="panel-strip">
              {round.panels.map((panel) => (
                <span key={panel.id}>
                  {panel.name} · {panel.queuedCount} waiting · {panel.activeReviewCount} active
                </span>
              ))}
            </div>

            {round.status === 'published' && round.canManage ? (
              <button
                className="primary"
                type="button"
                disabled={busyRoundId !== null || (pendingRoundId !== null && pendingRoundId !== round.id)}
                onClick={() => void open(round)}
              >
                {busyRoundId === round.id ? 'Opening…' : pendingRoundId === round.id ? 'Confirm earlier open' : 'Open round'}
              </button>
            ) : null}
          </article>
        ))}
      </div>

      {overview.rounds.length === 0 ? (
        <div className="empty-state">
          <h2>No review rounds are ready</h2>
          <p className="muted">Set up and publish a round before judging begins.</p>
        </div>
      ) : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}
