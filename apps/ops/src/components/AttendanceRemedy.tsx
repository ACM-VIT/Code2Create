import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type AttendanceOverview = FunctionReturnType<typeof api.attendanceOperations.overview>
type AttendanceSession = AttendanceOverview['sessions'][number]
type AttendanceRoster = FunctionReturnType<typeof api.attendanceOperations.sessionRoster>
type AttendanceParticipant = AttendanceRoster['page'][number]
type RemedyReview = FunctionReturnType<typeof api.attendanceRemedies.forParticipant>
type ApprovalResult = 'attended' | 'absent' | 'partial' | 'excused' | 'needs_review'
type DecisionKind = 'approve' | 'decline'

export function AttendanceRemedy({
  session,
  participant,
}: {
  session: AttendanceSession
  participant: AttendanceParticipant
}) {
  const eligible = session.status === 'closed' && session.canReadRemedies
  const [open, setOpen] = useState(false)
  const review = useQuery(
    api.attendanceRemedies.forParticipant,
    eligible && open
      ? {
          eventSlug,
          sessionId: session.id,
          membershipId: participant.membershipId,
        }
      : 'skip',
  )

  if (!eligible) return null
  if (!open) {
    return (
      <button className="text-button" type="button" onClick={() => setOpen(true)}>
        Review result
      </button>
    )
  }

  return (
    <div className="attendance-remedy">
      <div className="attendance-remedy-heading">
        <div>
          <strong>Final result review</strong>
          <span>Scanner records stay unchanged. An approval changes only the derived result.</span>
        </div>
        <button className="text-button" type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      {review === undefined ? (
        <p className="muted">Loading frozen result and evidence…</p>
      ) : (
        <RemedyReviewBody session={session} participant={participant} review={review} />
      )}
    </div>
  )
}

function RemedyReviewBody({
  session,
  participant,
  review,
}: {
  session: AttendanceSession
  participant: AttendanceParticipant
  review: RemedyReview
}) {
  const openRemedy = useMutation(api.attendanceRemedies.open)
  const decideRemedy = useMutation(api.attendanceRemedies.decide)
  const [description, setDescription] = useState('')
  const [decisionOpen, setDecisionOpen] = useState(false)
  const [decisionKind, setDecisionKind] = useState<DecisionKind>('approve')
  const [result, setResult] = useState<ApprovalResult>('attended')
  const [presentMinutes, setPresentMinutes] = useState('0')
  const [confirmedAt, setConfirmedAt] = useState('')
  const [reason, setReason] = useState('')
  const [participantNote, setParticipantNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openOperationId = useRef<string | null>(null)
  const decisionOperationId = useRef<string | null>(null)
  const openCase = review.cases.find((remedy) => remedy.state === 'open')

  useEffect(() => {
    openOperationId.current = null
  }, [description, review.sessionVersion, review.participantVersion])

  useEffect(() => {
    decisionOperationId.current = null
  }, [
    confirmedAt,
    decisionKind,
    openCase?.version,
    participantNote,
    presentMinutes,
    reason,
    result,
    review.participantVersion,
    review.sessionVersion,
  ])

  const beginDecision = () => {
    setDecisionKind('approve')
    setResult(approvalResult(review.result))
    setPresentMinutes(String(Math.floor(review.presentDurationMs / 60_000)))
    setConfirmedAt(review.confirmedAt === undefined ? '' : localDateTime(review.confirmedAt))
    setReason('')
    setParticipantNote('')
    setError(null)
    setDecisionOpen(true)
  }

  const submitOpen = async (event: FormEvent) => {
    event.preventDefault()
    const clientOperationId = openOperationId.current ?? crypto.randomUUID()
    openOperationId.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await openRemedy({
        eventSlug,
        sessionId: session.id,
        membershipId: participant.membershipId,
        expectedSessionVersion: review.sessionVersion,
        expectedParticipantVersion: review.participantVersion,
        description,
        clientOperationId,
      })
      openOperationId.current = null
      setDescription('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const submitDecision = async (event: FormEvent) => {
    event.preventDefault()
    if (!openCase) return
    const clientOperationId = decisionOperationId.current ?? crypto.randomUUID()
    decisionOperationId.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      if (decisionKind === 'decline') {
        await decideRemedy({
          eventSlug,
          caseId: openCase.id,
          expectedCaseVersion: openCase.version,
          expectedSessionVersion: review.sessionVersion,
          expectedParticipantVersion: review.participantVersion,
          resolution: { kind: 'decline', participantNote },
          reason,
          clientOperationId,
        })
      } else {
        const duration = Number(presentMinutes)
        if (!Number.isSafeInteger(duration)) {
          setError('Present duration must be a whole number of minutes.')
          return
        }
        const confirmation = confirmedAt === '' ? undefined : Date.parse(confirmedAt)
        if (confirmation !== undefined && !Number.isSafeInteger(confirmation)) {
          setError('Choose a valid confirmation time.')
          return
        }
        await decideRemedy({
          eventSlug,
          caseId: openCase.id,
          expectedCaseVersion: openCase.version,
          expectedSessionVersion: review.sessionVersion,
          expectedParticipantVersion: review.participantVersion,
          resolution: {
            kind: 'approve',
            result,
            presentDurationMinutes: result === 'absent' ? 0 : duration,
            ...(result !== 'absent' && confirmation !== undefined
              ? { confirmedAt: confirmation }
              : {}),
            participantNote,
          },
          reason,
          clientOperationId,
        })
      }
      decisionOperationId.current = null
      setDecisionOpen(false)
      setReason('')
      setParticipantNote('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const resultChanged =
    review.sessionVersion !== session.version || review.participantVersion !== participant.version

  return (
    <>
      <dl className="attendance-remedy-summary">
        <div><dt>Current result</dt><dd>{resultName(review.result)}</dd></div>
        <div><dt>Present time</dt><dd>{durationName(review.presentDurationMs)}</dd></div>
        <div><dt>Confirmed</dt><dd>{review.confirmedAt ? timeName(review.confirmedAt) : 'No'}</dd></div>
      </dl>

      {openCase ? (
        <div className="attendance-remedy-case">
          <p><strong>Open case:</strong> {openCase.description}</p>
          <small>Opened by {openCase.openedByKind === 'participant' ? 'the participant' : 'staff'} · {dateTimeName(openCase.createdAt)}</small>
          {session.canDecideRemedy && !decisionOpen ? (
            <button className="secondary" type="button" onClick={beginDecision}>Resolve case</button>
          ) : null}
        </div>
      ) : session.canOpenRemedy ? (
        <form className="attendance-remedy-form" onSubmit={submitOpen}>
          <label className="field">
            <span>Why this result needs review</span>
            <textarea
              required
              minLength={10}
              maxLength={1_000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe the missing scan, boundary case, or evidence to review."
            />
          </label>
          <div className="button-row">
            <button className="secondary" type="submit" disabled={busy || description.trim().length < 10}>
              {busy ? 'Opening…' : 'Open review'}
            </button>
          </div>
        </form>
      ) : null}

      {openCase && session.canDecideRemedy && decisionOpen ? (
        <form className="attendance-remedy-form" onSubmit={submitDecision}>
          <div className="attendance-remedy-fields">
            <label className="field">
              <span>Decision</span>
              <select value={decisionKind} onChange={(event) => setDecisionKind(parseDecisionKind(event.target.value))}>
                <option value="approve">Approve a corrected result</option>
                <option value="decline">Keep the current result</option>
              </select>
            </label>
            {decisionKind === 'approve' ? (
              <>
                <label className="field">
                  <span>Final result</span>
                  <select value={result} onChange={(event) => setResult(parseApprovalResult(event.target.value))}>
                    <option value="attended">Attended</option>
                    <option value="partial">Partial</option>
                    <option value="absent">Absent</option>
                    <option value="excused">Excused</option>
                    <option value="needs_review">Needs review</option>
                  </select>
                </label>
                <label className="field">
                  <span>Present minutes</span>
                  <input
                    type="number"
                    min="0"
                    max={review.maximumPresentDurationMinutes}
                    step="1"
                    disabled={result === 'absent'}
                    value={result === 'absent' ? '0' : presentMinutes}
                    onChange={(event) => setPresentMinutes(event.target.value)}
                  />
                </label>
                {result !== 'absent' ? (
                  <label className="field">
                    <span>First confirmation {result === 'attended' || result === 'partial' ? '' : '(optional)'}</span>
                    <input
                      type="datetime-local"
                      step="60"
                      value={confirmedAt}
                      onChange={(event) => setConfirmedAt(event.target.value)}
                    />
                  </label>
                ) : null}
              </>
            ) : null}
            <label className="field attendance-remedy-wide">
              <span>Internal reason</span>
              <textarea required minLength={5} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <label className="field attendance-remedy-wide">
              <span>Note shown to the participant</span>
              <textarea required minLength={3} maxLength={400} value={participantNote} onChange={(event) => setParticipantNote(event.target.value)} />
            </label>
          </div>
          <p className="muted">Requires a Google sign-in from the last 15 minutes. The decision and before/after result are audited.</p>
          <div className="button-row">
            <button
              className="primary"
              type="submit"
              disabled={busy || resultChanged || reason.trim().length < 5 || participantNote.trim().length < 3}
            >
              {busy ? 'Saving…' : decisionKind === 'approve' ? 'Apply corrected result' : 'Decline review'}
            </button>
            <button className="secondary" type="button" disabled={busy} onClick={() => setDecisionOpen(false)}>Cancel</button>
          </div>
        </form>
      ) : null}

      {resultChanged ? <p className="notice error" role="alert">The result changed while this review was open. Close it and review the latest state.</p> : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}

      {review.recentEvents.length > 0 ? (
        <details className="attendance-remedy-history">
          <summary>Scanner, paper, and correction history</summary>
          <ol>
            {review.recentEvents.map((presenceEvent) => (
              <li key={presenceEvent.id}>
                <span>{eventName(presenceEvent.sourceKind, presenceEvent.transition, presenceEvent.outcome, presenceEvent.reasonCode)}</span>
                <small>{dateTimeName(presenceEvent.effectiveAt)} · recorded {dateTimeName(presenceEvent.recordedAt)}</small>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {review.cases.some((remedy) => remedy.state !== 'open') ? (
        <details className="attendance-remedy-history">
          <summary>Earlier reviews</summary>
          <ol>
            {review.cases.filter((remedy) => remedy.state !== 'open').map((remedy) => (
              <li key={remedy.id}>
                <span>{stateName(remedy.state)} · {remedy.description}</span>
                <small>{remedy.decisionReason ?? 'No internal reason'}{remedy.participantResolutionNote ? ` · participant note: ${remedy.participantResolutionNote}` : ''}</small>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </>
  )
}

function parseDecisionKind(value: string): DecisionKind {
  return value === 'decline' ? 'decline' : 'approve'
}

function parseApprovalResult(value: string): ApprovalResult {
  if (value === 'absent' || value === 'partial' || value === 'excused' || value === 'needs_review') return value
  return 'attended'
}

function approvalResult(value: RemedyReview['result']): ApprovalResult {
  return value === 'not_expected' ? 'attended' : value
}

function localDateTime(timestamp: number) {
  const date = new Date(timestamp)
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000
  return new Date(localTimestamp).toISOString().slice(0, 16)
}

function resultName(value: string) {
  if (value === 'not_expected') return 'Not expected'
  if (value === 'needs_review') return 'Needs review'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function stateName(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function durationName(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000)
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return hours > 0 ? `${hours}h ${remainder}m` : `${minutes}m`
}

function timeName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp)
}

function dateTimeName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}

function eventName(
  sourceKind: 'scanner' | 'staff_reconciliation' | 'manual_import',
  transition: string,
  outcome: string,
  reasonCode: string,
) {
  const source = sourceKind === 'scanner'
    ? 'Scanner'
    : sourceKind === 'manual_import'
      ? 'Paper import'
      : 'Live correction'
  const detail = outcome === 'reconciled' ? reasonCode : `${transition} · ${outcome}`
  return `${source}: ${detail.replaceAll('_', ' ')}`
}
