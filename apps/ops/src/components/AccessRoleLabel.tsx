import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation } from 'convex/react'
import { useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'

type AccessDetail = NonNullable<FunctionReturnType<typeof api.access.detail>>
type EventRole = Exclude<AccessDetail['person']['role'], undefined>

const roleOptions: Array<{ value: EventRole; label: string }> = [
  { value: 'supreme', label: 'Supreme' },
  { value: 'board', label: 'Board' },
  { value: 'sc', label: 'SC' },
  { value: 'jc', label: 'JC' },
  { value: 'external_judge', label: 'External judge' },
]

export function AccessRoleLabel({
  personId,
  currentRole,
  accessVersion,
}: {
  personId: AccessDetail['person']['id']
  currentRole: EventRole | undefined
  accessVersion: number
}) {
  const setRole = useMutation(api.accessRoles.set)
  const operations = useOperationRunner()
  const [selectedRole, setSelectedRole] = useState<EventRole | ''>(currentRole ?? '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rolePending = operations.hasPending('access-role-set')

  const selectRole = (value: string) => {
    if (!value) {
      setSelectedRole('')
      return
    }
    const option = roleOptions.find((candidate) => candidate.value === value)
    if (option) setSelectedRole(option.value)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await operations.run(
        'access-role-set', (clientOperationId) => () => setRole({
          eventSlug,
          targetPersonId: personId,
          role: selectedRole || null,
          expectedAccessVersion: accessVersion,
          reason,
          clientOperationId,
        }),
      )
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="permission-command role-command">
      <div>
        <h2>Role</h2>
        <p className="muted">
          Groups this person in the app. Permissions are still granted separately.
        </p>
      </div>
      <form className="role-form" onSubmit={submit}>
        <label className="field">
          <span>Role label</span>
          <select disabled={busy || rolePending} value={selectedRole} onChange={(event) => selectRole(event.target.value)}>
            <option value="">No role label</option>
            {roleOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Why this role is changing</span>
          <textarea required disabled={busy || rolePending} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="role-submit">
          <button
            className="secondary"
            type="submit"
            disabled={busy || (!rolePending && (
              reason.trim().length < 5 || selectedRole === (currentRole ?? '')
            ))}
          >
            {busy ? 'Saving…' : rolePending ? 'Confirm earlier role change' : 'Save role label'}
          </button>
          <small>You may be asked to sign in again before this change.</small>
        </div>
      </form>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}
