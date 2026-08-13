import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useMutationAttempt } from '../lib/operations'

type Lifecycle = FunctionReturnType<typeof api.eventLifecycle.current>
type LifecycleStatus = Lifecycle['status']

const statusCopy: Readonly<Record<LifecycleStatus, { label: string; detail: string }>> = {
  draft: {
    label: 'Setup',
    detail: 'Participants cannot apply yet.',
  },
  registration_open: {
    label: 'Applications open',
    detail: 'Participants can register, form teams, and submit.',
  },
  registration_closed: {
    label: 'Applications closed',
    detail: 'Submitted applications remain available to the review team.',
  },
  live: {
    label: 'Event live',
    detail: 'Event-day check-in, hall, project, and judging work can run.',
  },
  complete: {
    label: 'Event complete',
    detail: 'The main event window is finished.',
  },
}

export function EventLifecycleControl() {
  const lifecycle = useQuery(api.eventLifecycle.current, { eventSlug })
  const transitionEvent = useMutation(api.eventLifecycle.transition)
  const operationAttempt = useMutationAttempt<FunctionReturnType<typeof api.eventLifecycle.transition>>()
  const [targetStatus, setTargetStatus] = useState<LifecycleStatus | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedTransition = lifecycle?.transitions.find(
    (transition) => transition.targetStatus === targetStatus,
  )
  const operationPending = operationAttempt.hasPending('event-lifecycle-transition')

  useEffect(() => {
    if (targetStatus === null || selectedTransition !== undefined) return
    setTargetStatus(null)
    setReason('')
    setError(null)
  }, [selectedTransition, targetStatus])

  if (lifecycle === undefined) return <p className="muted">Loading event state…</p>
  const current = statusCopy[lifecycle.status]

  const selectTransition = (status: LifecycleStatus) => {
    setTargetStatus(status)
    setReason('')
    setError(null)
  }

  const cancel = () => {
    setTargetStatus(null)
    setReason('')
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedTransition || selectedTransition.blockers.length > 0) return
    setBusy(true)
    setError(null)
    try {
      await operationAttempt.run('event-lifecycle-transition', () => {
        const args = {
          eventSlug,
          targetStatus: selectedTransition.targetStatus,
          expectedEventVersion: lifecycle.eventVersion,
          reason,
          clientOperationId: crypto.randomUUID(),
        }
        return () => transitionEvent(args)
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="event-lifecycle">
      <div className="event-lifecycle-current">
        <span>Current state</span>
        <strong>{current.label}</strong>
        <small>{current.detail}</small>
      </div>

      {lifecycle.canManage && lifecycle.transitions.length > 0 ? (
        <div className="event-lifecycle-actions">
          {lifecycle.transitions.map((transition) => (
            <button
              className={transition.targetStatus === 'registration_open' && lifecycle.status === 'registration_closed'
                ? 'text-button'
                : 'secondary'}
              key={transition.targetStatus}
              type="button"
              onClick={() => selectTransition(transition.targetStatus)}
            >
              {transitionLabel(lifecycle.status, transition.targetStatus)}
            </button>
          ))}
        </div>
      ) : null}

      {selectedTransition ? (
        selectedTransition.blockers.length > 0 ? (
          <div className="event-lifecycle-confirmation">
            <strong>Finish setup first</strong>
            <ul>
              {selectedTransition.blockers.map((blocker) => <li key={blocker.key}>{blocker.label}</li>)}
            </ul>
            <button className="text-button" type="button" onClick={cancel}>Cancel</button>
          </div>
        ) : (
          <form className="event-lifecycle-confirmation" onSubmit={submit}>
            <strong>{transitionLabel(lifecycle.status, selectedTransition.targetStatus)}?</strong>
            <p>{transitionEffect(lifecycle.status, selectedTransition.targetStatus)}</p>
            <label className="field">
              <span>Reason</span>
              <textarea
                required
                minLength={5}
              maxLength={500}
              disabled={operationPending}
                value={reason}
                onChange={(event) => setReason(event.currentTarget.value)}
              />
            </label>
            {error ? <p className="notice error" role="alert">{error}</p> : null}
            <div className="button-row">
              <button className="primary" type="submit" disabled={busy || reason.trim().length < 5}>
                {busy ? 'Saving…' : operationPending ? 'Confirm earlier transition' : 'Confirm'}
              </button>
              <button className="text-button" type="button" disabled={busy || operationPending} onClick={cancel}>Cancel</button>
            </div>
          </form>
        )
      ) : null}
    </div>
  )
}

function transitionLabel(current: LifecycleStatus, target: LifecycleStatus) {
  if (target === 'registration_open') {
    return current === 'registration_closed' ? 'Reopen applications' : 'Open applications'
  }
  if (target === 'registration_closed') return 'Close applications'
  if (target === 'live') return 'Start event'
  if (target === 'complete') return 'Finish event'
  return 'Change event state'
}

function transitionEffect(current: LifecycleStatus, target: LifecycleStatus) {
  if (target === 'registration_open') {
    return current === 'registration_closed'
      ? 'Participants can change and submit applications again.'
      : 'New participants can register and teams can submit applications.'
  }
  if (target === 'registration_closed') {
    return 'Participant profiles, teams, and project applications stop changing.'
  }
  if (target === 'live') return 'Workflows that require the live event become available.'
  if (target === 'complete') return 'The event moves out of live operation.'
  return 'The event state changes immediately for every open app.'
}
