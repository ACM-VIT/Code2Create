import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation } from 'convex/react'
import { useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type AccessDetail = NonNullable<FunctionReturnType<typeof api.access.detail>>
type ManagedStatus = Extract<AccessDetail['person']['status'], 'active' | 'suspended'>

export function AccessSubjectStatus({
  personId,
  status,
  accessVersion,
  effectiveGrantCount,
}: {
  personId: AccessDetail['person']['id']
  status: ManagedStatus
  accessVersion: number
  effectiveGrantCount: number
}) {
  const suspend = useMutation(api.accessSubjects.suspend)
  const reactivate = useMutation(api.accessSubjects.reactivate)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isSuspending = status === 'active'
  const actionLabel = isSuspending ? 'Suspend account' : 'Reactivate account'
  const busyLabel = isSuspending ? 'Suspending…' : 'Reactivating…'

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const request = {
      eventSlug,
      targetPersonId: personId,
      expectedAccessVersion: accessVersion,
      reason,
      clientOperationId: crypto.randomUUID(),
    }
    try {
      if (isSuspending) {
        await suspend(request)
      } else {
        await reactivate(request)
      }
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`permission-command subject-status-command${isSuspending ? ' danger-zone' : ''}`}>
      <div>
        <h2>{isSuspending ? 'Suspend event account' : 'Reactivate event account'}</h2>
        <p className="muted">
          {isSuspending
            ? `This immediately blocks all ${effectiveGrantCount} current permission${effectiveGrantCount === 1 ? '' : 's'}. Their access history remains available.`
            : `This restores ${effectiveGrantCount} current permission${effectiveGrantCount === 1 ? '' : 's'}. Removed or expired permissions stay unavailable.`}
        </p>
      </div>
      <form className="role-form" onSubmit={submit}>
        <label className="field">
          <span>{isSuspending ? 'Why access is being suspended' : 'Why access is being restored'}</span>
          <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="role-submit">
          <button
            className="secondary"
            type="submit"
            disabled={busy || reason.trim().length < 5}
          >
            {busy ? busyLabel : actionLabel}
          </button>
          <small>You may be asked to sign in again before this change.</small>
        </div>
      </form>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}
