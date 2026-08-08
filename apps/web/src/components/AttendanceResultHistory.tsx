import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type RemedySessions = FunctionReturnType<typeof api.attendanceRemedies.mine>
type RemedySession = RemedySessions[number]

export function AttendanceResultHistory() {
  const sessions = useQuery(api.attendanceRemedies.mine, { eventSlug })
  const openRemedy = useMutation(api.attendanceRemedies.openMine)
  const [selectedSessionId, setSelectedSessionId] = useState<RemedySession['sessionId'] | null>(null)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationId = useRef<string | null>(null)
  const selectedSession = sessions?.find((session) => session.sessionId === selectedSessionId)

  useEffect(() => {
    operationId.current = null
  }, [
    description,
    selectedSession?.participantVersion,
    selectedSession?.sessionId,
    selectedSession?.sessionVersion,
  ])

  if (sessions === undefined) return <p className="muted">Loading final session results…</p>
  if (sessions.length === 0) return null

  const cancel = () => {
    operationId.current = null
    setSelectedSessionId(null)
    setDescription('')
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedSession) return
    const clientOperationId = operationId.current ?? crypto.randomUUID()
    operationId.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await openRemedy({
        eventSlug,
        sessionId: selectedSession.sessionId,
        expectedSessionVersion: selectedSession.sessionVersion,
        expectedParticipantVersion: selectedSession.participantVersion,
        description,
        clientOperationId,
      })
      cancel()
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="attendance-results">
      <div>
        <strong>Session results</strong>
        <p className="muted">Final results appear here after each hacking session closes.</p>
      </div>
      <ul className="attendance-result-list">
        {sessions.map((session) => (
          <li key={session.sessionId}>
            <div className="attendance-result-summary">
              <div>
                <strong>{session.sessionName}</strong>
                <span>{dateName(session.startsAt)}</span>
              </div>
              <div>
                <strong>{resultName(session.result)}</strong>
                <span>{durationName(session.presentDurationMs)}</span>
              </div>
            </div>
            {session.latestCase ? (
              <div className="attendance-result-case">
                <span>{caseStateName(session.latestCase.state)}</span>
                <p>{session.latestCase.description}</p>
                {session.latestCase.participantResolutionNote ? (
                  <p>{session.latestCase.participantResolutionNote}</p>
                ) : null}
              </div>
            ) : null}
            {session.canRequest && selectedSessionId !== session.sessionId ? (
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setSelectedSessionId(session.sessionId)
                  setDescription('')
                  setError(null)
                }}
              >
                Report an issue
              </button>
            ) : null}
            {selectedSessionId === session.sessionId ? (
              <form className="attendance-result-form" onSubmit={submit}>
                <label className="field">
                  <span className="field-label">What looks wrong?</span>
                  <textarea
                    autoFocus
                    required
                    minLength={10}
                    maxLength={1_000}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="For example: I checked in, but my final result says absent."
                  />
                </label>
                <p className="fine-print">Staff will review the frozen result and scanner history. Sending a report does not change the result by itself.</p>
                <div className="button-row">
                  <button className="secondary" type="submit" disabled={busy || description.trim().length < 10}>
                    {busy ? 'Sending…' : 'Send for review'}
                  </button>
                  <button className="text-button" type="button" disabled={busy} onClick={cancel}>Cancel</button>
                </div>
                {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function resultName(value: RemedySession['result']) {
  if (value === 'not_expected') return 'Not expected'
  if (value === 'needs_review') return 'Needs review'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function caseStateName(value: NonNullable<RemedySession['latestCase']>['state']) {
  if (value === 'open') return 'Review in progress'
  return value === 'approved' ? 'Correction approved' : 'Review declined'
}

function durationName(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000)
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return hours > 0 ? `${hours}h ${remainder}m present` : `${minutes}m present`
}

function dateName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}
