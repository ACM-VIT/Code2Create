import { api } from '@code2create/backend/api'
import { teamRoundStateParticipantLabels, type TeamRoundState } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useRef, useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { countdownName, queueWaitName } from '../lib/time'

type TeamQr = {
  tokenId: FunctionReturnType<typeof api.participantReview.mintTeamQr>['tokenId']
  reviewSessionId: string
  payload: string
  manualCode: string
  expiresAt: number
  serverNow: number
  clientNow: number
  tableLabel?: string
}

export function ReviewQueuePanel() {
  const queue = useQuery(api.participantReview.current, { eventSlug })
  const mintTeamQr = useMutation(api.participantReview.mintTeamQr)
  const mintingRef = useRef(false)
  const [teamQr, setTeamQr] = useState<TeamQr | null>(null)
  const [now, setNow] = useState(() => performance.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const teamQrState = useQuery(
    api.participantReview.teamQrState,
    teamQr ? { eventSlug, tokenId: teamQr.tokenId } : 'skip',
  )
  useEffect(() => {
    if (!teamQr) return
    const timer = window.setInterval(() => {
      const nextNow = performance.now()
      setNow(nextNow)
      const nextServerNow = teamQr.serverNow + nextNow - teamQr.clientNow
      if (nextServerNow >= teamQr.expiresAt) window.clearInterval(timer)
    }, 1_000)
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
      const clientNow = performance.now()
      setTeamQr({
        tokenId: minted.tokenId,
        reviewSessionId: queue.review.id,
        payload: minted.payload,
        manualCode: minted.manualCode,
        expiresAt: minted.expiresAt,
        serverNow: minted.serverNow,
        clientNow,
        ...(minted.tableLabel !== undefined ? { tableLabel: minted.tableLabel } : {}),
      })
      setNow(clientNow)
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

  const qrServerNow = teamQr ? teamQr.serverNow + now - teamQr.clientNow : 0
  const secondsLeft = teamQr
    ? Math.max(0, Math.ceil((teamQr.expiresAt - qrServerNow) / 1_000))
    : 0
  const tokenIsActive = teamQrState === undefined || teamQrState?.state === 'active'
  const currentQr = teamQr &&
    tokenIsActive &&
    secondsLeft > 0 &&
    queue.review?.canShowTeamQr &&
    teamQr.reviewSessionId === queue.review.id
    ? teamQr
    : null

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
          <dd>{teamRoundStateParticipantLabels[queue.state]}</dd>
        </div>
        {queue.tableLabel ? (
          <div>
            <dt>Team location</dt>
            <dd>{queue.tableLabel}</dd>
          </div>
        ) : null}
        {queue.panel ? (
          <div>
            <dt>Panel</dt>
            <dd>{queue.panel.name}</dd>
          </div>
        ) : null}
        {queue.estimate ? (
          <div>
            <dt>Estimated wait</dt>
            <dd>
              <EstimatedWait
                estimate={queue.estimate}
                key={queue.serverNow}
                serverNow={queue.serverNow}
              />
            </dd>
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
            {currentQr.tableLabel ? `${currentQr.tableLabel} · ` : ''}expires in {countdownName(secondsLeft)} · show this to each reviewer when they arrive.
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

function EstimatedWait({
  estimate,
  serverNow,
}: {
  estimate: NonNullable<
    NonNullable<FunctionReturnType<typeof api.participantReview.current>>['estimate']
  >
  serverNow: number
}) {
  const [clock] = useState(() => ({ serverNow, clientNow: performance.now() }))
  const [now, setNow] = useState(clock.clientNow)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return queueWaitName(estimate, clock.serverNow + now - clock.clientNow)
}

function queueStateCopy(state: TeamRoundState, teamsAhead?: number) {
  if (state === 'unassigned') return 'The review desk will place your team into a panel queue. This page updates automatically.'
  if (state === 'queued') {
    if (teamsAhead === 0) return 'You are next at this panel. Keep the team nearby.'
    if (teamsAhead === 1) return 'One team is ahead of you. Keep the team nearby.'
    if (teamsAhead !== undefined) return `${teamsAhead} teams are ahead of you. Keep the team nearby.`
    return 'Keep the team nearby. This page updates when your panel calls you.'
  }
  if (state === 'called') return 'Stay with your team at the location shown below. Reviewers are on their way; open the team code.'
  if (state === 'at_table') return 'Keep the team code open until every reviewer has checked in.'
  if (state === 'in_review') return 'Your review is underway.'
  if (state === 'completed') return 'This review round is complete.'
  if (state === 'held') return 'Staff paused this queue entry and will update you.'
  if (state === 'missed') return 'Speak to the review desk when your team is together.'
  return 'Your team is no longer in this review round.'
}
