import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useMutationAttempt } from '../lib/operations'

type CheckpointState = FunctionReturnType<typeof api.projectCheckpoints.mine>
type Checkpoint = CheckpointState['checkpoints'][number]

export function ProjectCheckpointsPanel({ timezone }: { timezone: string }) {
  const state = useQuery(api.projectCheckpoints.mine, { eventSlug })

  if (state === undefined) return null
  if (!state.configured) return null

  return (
    <section className="checkpoint-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">During the event</p>
          <h2>Team updates</h2>
        </div>
      </div>
      <p className="muted">
        Share one update when it opens so your team has a clear build record.
      </p>
      <div className="checkpoint-list">
        {state.checkpoints.map((checkpoint) => (
          <CheckpointCard
            checkpoint={checkpoint}
            key={checkpoint.checkpointKey}
            timezone={timezone}
          />
        ))}
      </div>
    </section>
  )
}

function CheckpointCard({ checkpoint, timezone }: { checkpoint: Checkpoint; timezone: string }) {
  const saveUpdate = useMutation(api.projectCheckpoints.saveUpdate)
  const saveFollowUp = useMutation(api.projectCheckpoints.saveFollowUp)
  const submit = useMutation(api.projectCheckpoints.submit)
  const [updateText, setUpdateText] = useState(checkpoint.draft?.updateText ?? '')
  const [followUpAnswer, setFollowUpAnswer] = useState(
    checkpoint.draft?.followUpAnswer ?? '',
  )
  const [loadedVersion, setLoadedVersion] = useState(checkpoint.draft?.version ?? 0)
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState<'update' | 'follow_up' | 'submit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const updateAttempt = useMutationAttempt<FunctionReturnType<typeof api.projectCheckpoints.saveUpdate>>()
  const followUpAttempt = useMutationAttempt<FunctionReturnType<typeof api.projectCheckpoints.saveFollowUp>>()
  const submitAttempt = useMutationAttempt<FunctionReturnType<typeof api.projectCheckpoints.submit>>()
  const updatePending = updateAttempt.hasPending('checkpoint-update')
  const followUpPending = followUpAttempt.hasPending('checkpoint-follow-up')
  const submitPending = submitAttempt.hasPending('checkpoint-submit')

  useEffect(() => {
    const version = checkpoint.draft?.version ?? 0
    if (version === loadedVersion) return
    setUpdateText(checkpoint.draft?.updateText ?? '')
    setFollowUpAnswer(checkpoint.draft?.followUpAnswer ?? '')
    setLoadedVersion(version)
    setReviewing(false)
  }, [checkpoint.draft, loadedVersion])

  const saveFirstAnswer = async (event: FormEvent) => {
    event.preventDefault()
    const expectedVersion = checkpoint.draft?.version ?? 0
    setBusy('update')
    setError(null)
    try {
      await updateAttempt.run('checkpoint-update', () => {
        const args = {
          eventSlug,
          checkpointKey: checkpoint.checkpointKey,
          updateText,
          expectedDraftVersion: expectedVersion,
          clientOperationId: crypto.randomUUID(),
        }
        return () => saveUpdate(args)
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const saveSecondAnswer = async (event: FormEvent) => {
    event.preventDefault()
    const draft = checkpoint.draft
    if (!draft) return
    setBusy('follow_up')
    setError(null)
    try {
      await followUpAttempt.run('checkpoint-follow-up', () => {
        const args = {
          eventSlug,
          checkpointKey: checkpoint.checkpointKey,
          answer: followUpAnswer,
          expectedDraftVersion: draft.version,
          clientOperationId: crypto.randomUUID(),
        }
        return () => saveFollowUp(args)
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const submitUpdate = async () => {
    const draft = checkpoint.draft
    if (!draft) return
    setBusy('submit')
    setError(null)
    try {
      await submitAttempt.run('checkpoint-submit', () => {
        const args = {
          eventSlug,
          checkpointKey: checkpoint.checkpointKey,
          expectedDraftVersion: draft.version,
          clientOperationId: crypto.randomUUID(),
        }
        return () => submit(args)
      })
      setReviewing(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <article className="checkpoint-card">
      <header>
        <div>
          <h3>{checkpoint.displayName}</h3>
          {checkpoint.phaseName.toLocaleLowerCase('en') !== checkpoint.displayName.toLocaleLowerCase('en') ? (
            <p className="muted">{checkpoint.phaseName}</p>
          ) : null}
        </div>
        <span className={`checkpoint-state ${checkpoint.availability}`}>
          {availabilityLabel(checkpoint.availability)}
        </span>
      </header>
      <p className="fine-print">{checkpointWindow(checkpoint, timezone)}</p>

      {checkpoint.submission ? (
        <div className="checkpoint-submission">
          <p>{checkpoint.submission.updateText}</p>
          <p className="muted">{checkpoint.followUpQuestion}</p>
          <p>{checkpoint.submission.followUpAnswer}</p>
          <p className="fine-print">
            Submitted {formatTime(checkpoint.submission.submittedAt, timezone)} · {checkpoint.submission.timing.replace('_', ' ')}
          </p>
        </div>
      ) : checkpoint.canEdit ? (
        <>
          <form className="checkpoint-form" onSubmit={saveFirstAnswer}>
            <label className="field">
              <span>{checkpoint.prompt}</span>
              <textarea
                minLength={10}
                maxLength={4000}
                required
                disabled={updatePending}
                value={updateText}
                onChange={(event) => setUpdateText(event.target.value)}
              />
            </label>
            <button className="secondary" disabled={busy !== null} type="submit">
              {busy === 'update' ? 'Saving…' : updatePending ? 'Confirm earlier save' : checkpoint.draft?.updateText ? 'Save changes' : 'Continue'}
            </button>
          </form>

          {checkpoint.draft?.updateText ? (
            <form className="checkpoint-form" onSubmit={saveSecondAnswer}>
              <label className="field">
                <span>{checkpoint.followUpQuestion}</span>
                <textarea
                  minLength={2}
                  maxLength={2000}
                  required
                  disabled={followUpPending}
                  value={followUpAnswer}
                  onChange={(event) => setFollowUpAnswer(event.target.value)}
                />
              </label>
              <button className="secondary" disabled={busy !== null} type="submit">
                {busy === 'follow_up' ? 'Saving…' : followUpPending ? 'Confirm earlier save' : checkpoint.draft.followUpAnswer ? 'Save changes' : 'Save answer'}
              </button>
            </form>
          ) : null}

          {checkpoint.draft?.followUpAnswer ? (
            reviewing ? (
              <div className="checkpoint-confirmation">
                <p>
                  This freezes the update above for the event record. It does not affect judging scores.
                </p>
                <div className="offer-actions">
                  <button className="secondary" disabled={busy !== null || submitPending} type="button" onClick={() => setReviewing(false)}>
                    Keep editing
                  </button>
                  <button className="primary" disabled={busy !== null} type="button" onClick={() => void submitUpdate()}>
                    {busy === 'submit' ? 'Submitting…' : submitPending ? 'Confirm earlier submission' : 'Confirm submission'}
                  </button>
                </div>
              </div>
            ) : (
              <button className="primary" disabled={busy !== null} type="button" onClick={() => setReviewing(true)}>
                Submit update
              </button>
            )
          ) : null}
        </>
      ) : (
        <p className="muted">{unavailableMessage(checkpoint)}</p>
      )}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </article>
  )
}

function availabilityLabel(availability: Checkpoint['availability']) {
  if (availability === 'awaiting_confirmation') return 'Locked'
  if (availability === 'upcoming') return 'Upcoming'
  if (availability === 'open') return 'Open'
  if (availability === 'late') return 'Late'
  if (availability === 'closed') return 'Closed'
  return 'Submitted'
}

function checkpointWindow(checkpoint: Checkpoint, timezone: string) {
  if (checkpoint.availability === 'upcoming') {
    return `Opens ${formatTime(checkpoint.opensAt, timezone)}`
  }
  if (checkpoint.availability === 'open') {
    return `Due ${formatTime(checkpoint.dueAt, timezone)}`
  }
  if (checkpoint.availability === 'late') {
    return `Due time passed. Open until ${formatTime(checkpoint.closesAt, timezone)}`
  }
  return `Window ${formatTime(checkpoint.opensAt, timezone)}–${formatTime(checkpoint.closesAt, timezone)}`
}

function unavailableMessage(checkpoint: Checkpoint) {
  if (checkpoint.availability === 'awaiting_confirmation') {
    return 'This opens after your team confirms its event place.'
  }
  if (checkpoint.availability === 'upcoming') return 'Nothing is needed yet.'
  return 'The submission window has ended.'
}

function formatTime(timestamp: number, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}
