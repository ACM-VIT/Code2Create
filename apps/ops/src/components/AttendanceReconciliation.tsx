import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useRef, useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type AttendanceOverview = FunctionReturnType<typeof api.attendanceOperations.overview>
type AttendanceSession = AttendanceOverview['sessions'][number]
type AttendanceRoster = FunctionReturnType<typeof api.attendanceOperations.sessionRoster>
type AttendanceParticipant = AttendanceRoster['page'][number]
type ActionKind =
  | 'mark_present'
  | 'mark_temporarily_out'
  | 'mark_needs_review'
  | 'void_last_transition'

export function AttendanceReconciliation({
  session,
  participant,
}: {
  session: AttendanceSession
  participant: AttendanceParticipant
}) {
  const reconcile = useMutation(api.attendanceReconciliation.reconcile)
  const options = actionOptions(participant)
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState<ActionKind>(options[0]?.kind ?? 'mark_needs_review')
  const [effectiveAt, setEffectiveAt] = useState(localDateTime(Date.now()))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)
  const preview = useQuery(
    api.attendanceOperations.reconciliationPreview,
    open
      ? {
          eventSlug,
          sessionId: session.id,
          membershipId: participant.membershipId,
        }
      : 'skip',
  )

  if (session.status !== 'open' || options.length === 0) return null
  const previewChanged = preview !== undefined && preview.participantVersion !== participant.version

  const chooseAction = (value: string) => {
    const option = options.find((candidate) => candidate.kind === value)
    if (!option) return
    setAction(option.kind)
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    const request = {
      eventSlug,
      sessionId: session.id,
      membershipId: participant.membershipId,
      expectedSessionVersion: session.version,
      expectedParticipantVersion: participant.version,
      reason,
      clientOperationId,
    }
    setBusy(true)
    setError(null)
    try {
      if (action === 'void_last_transition') {
        if (!participant.lastEventId) {
          setError('The latest scanner event changed. Refresh and try again.')
          return
        }
        await reconcile({
          ...request,
          action: {
            kind: 'void_last_transition',
            sourceEventId: participant.lastEventId,
          },
        })
      } else {
        const timestamp = Date.parse(effectiveAt)
        if (!Number.isSafeInteger(timestamp)) {
          setError('Choose a valid effective time.')
          return
        }
        if (action === 'mark_present') {
          await reconcile({
            ...request,
            action: { kind: 'mark_present', effectiveAt: timestamp },
          })
        } else if (action === 'mark_temporarily_out') {
          await reconcile({
            ...request,
            action: { kind: 'mark_temporarily_out', effectiveAt: timestamp },
          })
        } else {
          await reconcile({
            ...request,
            action: { kind: 'mark_needs_review', effectiveAt: timestamp },
          })
        }
      }
      operationRef.current = null
      setReason('')
      setOpen(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button className="text-button" type="button" onClick={() => setOpen(true)}>
        Correct
      </button>
    )
  }

  return (
    <form className="attendance-correction" onSubmit={submit}>
      <div className="attendance-correction-fields">
        <label className="field">
          <span>Correction</span>
          <select value={action} onChange={(event) => chooseAction(event.target.value)}>
            {options.map((option) => (
              <option key={option.kind} value={option.kind}>{option.label}</option>
            ))}
          </select>
        </label>
        {action !== 'void_last_transition' ? (
          <label className="field">
            <span>Effective time</span>
            <input
              type="datetime-local"
              step="60"
              value={effectiveAt}
              onChange={(event) => setEffectiveAt(event.target.value)}
            />
          </label>
        ) : null}
        <label className="field attendance-correction-reason">
          <span>Reason</span>
          <textarea
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="What was missed or recorded incorrectly?"
          />
        </label>
      </div>
      <p className="muted">
        This adds a linked correction; the original scanner event stays in history. Requires a Google sign-in from the last 15 minutes.
      </p>
      {preview === undefined ? <p className="muted">Loading current history…</p> : (
        <div className="attendance-correction-preview">
          <p>
            <strong>Current state:</strong> {stateName(preview.state)}
            {preview.currentInterval
              ? ` · present since ${timeName(preview.currentInterval.openedAt)}`
              : ' · no open interval'}
          </p>
          <p>{consequenceText(action, preview.currentInterval !== null)}</p>
          {preview.recentEvents.length > 0 ? (
            <details>
              <summary>Recent presence history</summary>
              <ol>
                {preview.recentEvents.map((presenceEvent) => (
                  <li key={presenceEvent.id}>
                    <span>{eventName(presenceEvent)}</span>
                    <small>{timeName(presenceEvent.effectiveAt)}</small>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      )}
      {previewChanged ? (
        <p className="notice error" role="alert">Attendance changed while this form was open. Close it and review the new state.</p>
      ) : null}
      <div className="button-row">
        <button
          className="primary"
          type="submit"
          disabled={busy || preview === undefined || previewChanged || reason.trim().length < 5}
        >
          {busy ? 'Saving…' : 'Save correction'}
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false)
            setError(null)
          }}
        >
          Cancel
        </button>
      </div>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </form>
  )
}

function actionOptions(participant: AttendanceParticipant) {
  const options: Array<{ kind: ActionKind; label: string }> = []
  if (
    participant.state === 'confirmation_due' ||
    participant.state === 'temporarily_out' ||
    participant.state === 'needs_review'
  ) {
    options.push({ kind: 'mark_present', label: 'Record presence' })
  }
  if (participant.state === 'present') {
    options.push({ kind: 'mark_temporarily_out', label: 'Record temporary exit' })
  }
  if (
    participant.state !== 'complete' &&
    participant.state !== 'excused' &&
    participant.state !== 'not_expected' &&
    participant.state !== 'needs_review'
  ) {
    options.push({ kind: 'mark_needs_review', label: 'Mark for review' })
  }
  if (participant.canVoidLastTransition && participant.lastEventId) {
    options.push({ kind: 'void_last_transition', label: 'Void latest scanner event' })
  }
  return options
}

function localDateTime(timestamp: number) {
  const date = new Date(timestamp)
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000
  return new Date(localTimestamp).toISOString().slice(0, 16)
}

function stateName(value: string) {
  if (value === 'confirmation_due') return 'waiting for confirmation'
  if (value === 'temporarily_out') return 'temporarily out'
  if (value === 'needs_review') return 'needs review'
  return value.replaceAll('_', ' ')
}

function timeName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}

function consequenceText(action: ActionKind, hasOpenInterval: boolean) {
  if (action === 'mark_present') {
    return hasOpenInterval
      ? 'This keeps the verified open interval and restores the live state to present.'
      : 'This opens one presence interval at the effective time.'
  }
  if (action === 'mark_temporarily_out') {
    return 'This closes the current presence interval at the effective time.'
  }
  if (action === 'void_last_transition') {
    return 'This reverses only the latest accepted scanner transition. Its original ledger event remains visible.'
  }
  return hasOpenInterval
    ? 'This closes the current interval and marks the participant for human review.'
    : 'This marks the participant for human review without inventing an interval.'
}

function eventName(event: {
  sourceKind: 'scanner' | 'staff_reconciliation' | 'manual_import'
  transition: string
  outcome: string
  reasonCode: string
}) {
  const source = event.sourceKind === 'scanner'
    ? 'Scanner'
    : event.sourceKind === 'manual_import'
      ? 'Paper import'
      : 'Correction'
  const result = event.outcome === 'reconciled'
    ? event.reasonCode
    : `${event.transition} · ${event.outcome}`
  return `${source}: ${result.replaceAll('_', ' ')}`
}
