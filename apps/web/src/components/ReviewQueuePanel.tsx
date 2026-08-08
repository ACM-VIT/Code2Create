import { api } from '@code2create/backend/api'
import { useMutation, useQuery } from 'convex/react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useRef, useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { countdownName } from '../lib/time'

type TeamQr = {
  payload: string
  manualCode: string
  expiresAt: number
  tableLabel: string
}

export function ReviewQueuePanel() {
  const queue = useQuery(api.participantReview.current, { eventSlug })
  const mintTeamQr = useMutation(api.participantReview.mintTeamQr)
  const mintingRef = useRef(false)
  const [teamQr, setTeamQr] = useState<TeamQr | null>(null)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!teamQr) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [teamQr])

  const showTeamQr = async () => {
    if (!queue?.review?.canShowTeamQr || mintingRef.current) return
    mintingRef.current = true
    setBusy(true)
    setError(null)
    try {
      const minted = await mintTeamQr({
        eventSlug,
        reviewSessionId: queue.review.id,
      })
      setTeamQr({
        payload: minted.payload,
        manualCode: minted.manualCode,
        expiresAt: minted.expiresAt,
        tableLabel: minted.tableLabel,
      })
      setNow(Date.now())
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      mintingRef.current = false
      setBusy(false)
    }
  }

  if (queue === undefined) {
    return null
  }
  if (!queue) return null

  const secondsLeft = teamQr ? Math.max(0, Math.ceil((teamQr.expiresAt - now) / 1_000)) : 0
  const currentQr = teamQr && secondsLeft > 0 && queue.review?.canShowTeamQr ? teamQr : null

  return (
    <section className="attendance-panel" aria-labelledby="review-queue-heading">
      <div>
        <p className="eyebrow">Project review</p>
        <h2 id="review-queue-heading">{queue.round.name}</h2>
        <p className="muted review-queue-copy">{queueStateCopy(queue.state, queue.teamsAhead)}</p>
      </div>

      {queue.round.isPaused ? (
        <p className="notice">
          Staff paused new review calls and starts. Your queue position is saved; stay nearby unless staff tells you otherwise.
        </p>
      ) : null}

      <dl className="detail-list compact-details">
        <div>
          <dt>Status</dt>
          <dd>{queueStateName(queue.state)}</dd>
        </div>
        {queue.panel ? (
          <div>
            <dt>Panel</dt>
            <dd>{queue.panel.name} · {queue.panel.tableLabel}</dd>
          </div>
        ) : null}
        {queue.estimate ? (
          <div>
            <dt>Estimated wait</dt>
            <dd>{queue.estimate.lowerMinutes === 0
              ? `Within ${queue.estimate.upperMinutes} min`
              : `About ${queue.estimate.lowerMinutes}–${queue.estimate.upperMinutes} min`}</dd>
          </div>
        ) : queue.state === 'queued' && queue.round.isPaused ? (
          <div>
            <dt>Estimated wait</dt>
            <dd>Updates when reviews resume</dd>
          </div>
        ) : null}
        {queue.review ? (
          <div>
            <dt>Reviewer check-in</dt>
            <dd>{queue.review.reviewerPresenceCount} of {queue.review.reviewerCount}</dd>
          </div>
        ) : null}
      </dl>

      {currentQr ? (
        <div className="portal-qr">
          <div className="qr-surface">
            <QRCodeSVG
              bgColor="#f1eee8"
              fgColor="#0a0a09"
              level="M"
              marginSize={2}
              size={220}
              title="Short-lived team review code"
              value={currentQr.payload}
            />
          </div>
          <p className="inline-status">
            {currentQr.tableLabel} · expires in {countdownName(secondsLeft)} · show this to each reviewer at your table.
          </p>
          <p className="manual-code" aria-label={`Fallback code ${currentQr.manualCode}`}>
            {currentQr.manualCode}
          </p>
          <p className="inline-status">A reviewer can type this code if their camera is unavailable.</p>
          <button type="button" className="text-button" disabled={busy} onClick={() => void showTeamQr()}>
            Replace code
          </button>
        </div>
      ) : queue.review?.canShowTeamQr ? (
        <button type="button" className="primary" disabled={busy} onClick={() => void showTeamQr()}>
          {busy ? 'Creating code…' : teamQr ? 'Refresh team code' : 'Show team code'}
        </button>
      ) : null}

      {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
    </section>
  )
}

function queueStateName(state: string) {
  if (state === 'unassigned') return 'Waiting for the review desk'
  if (state === 'queued') return 'In queue'
  if (state === 'called') return 'Go to your table'
  if (state === 'at_table') return 'At the table'
  if (state === 'in_review') return 'Review in progress'
  if (state === 'completed') return 'Complete'
  if (state === 'held') return 'On hold'
  if (state === 'missed') return 'Missed call'
  if (state === 'withdrawn') return 'Withdrawn'
  return 'Waiting for an update'
}

function queueStateCopy(state: string, teamsAhead?: number) {
  if (state === 'unassigned') return 'The review desk will place your team into a panel queue. This page updates automatically.'
  if (state === 'queued') {
    if (teamsAhead === 0) return 'You are next at this panel. Keep the team nearby.'
    if (teamsAhead === 1) return 'One team is ahead of you. Keep the team nearby.'
    if (teamsAhead !== undefined) return `${teamsAhead} teams are ahead of you. Keep the team nearby.`
    return 'Keep the team nearby. This page updates when your panel calls you.'
  }
  if (state === 'called') return 'Bring the whole team to the table shown below, then open the team code.'
  if (state === 'at_table') return 'Keep the team code open until every reviewer has confirmed their place.'
  if (state === 'in_review') return 'Your review is underway.'
  if (state === 'completed') return 'This review round is complete.'
  if (state === 'held') return 'Staff paused this queue entry and will update you.'
  if (state === 'missed') return 'Speak to the review desk when your team is together.'
  return 'The review desk will update this state.'
}
