import { api } from '@code2create/backend/api'
import { useMutation } from 'convex/react'
import { useState, type FormEvent } from 'react'
import { ErrorNotice } from '../components/Form'
import { eventSlug } from '../lib/config'
import { operationId, readableError } from '../lib/errors'
import type { ParticipantMe } from '../types'

export function PolicyConsentScreen({ me }: { me: ParticipantMe }) {
  const acceptPolicy = useMutation(api.participants.acceptPolicy)
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const policy = me.participantPolicy.policy

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await acceptPolicy({
        eventSlug,
        participantPolicyVersionId: me.participantPolicy.id,
        accepted,
        clientOperationId: operationId('participant-policy-accept'),
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="centered-shell top-aligned">
      <section className="narrow-panel policy-consent">
        <p className="muted">Before team setup</p>
        <h1>Review the participant policy.</h1>
        <div className="policy-copy">
          <p>{policy.profileNotice}</p>
          <p>{policy.projectTextNotice}</p>
          <a href={policy.privacyNoticeUrl} target="_blank" rel="noreferrer">Read the privacy notice</a>
        </div>
        <form onSubmit={submit}>
          <label className="check-row">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>I accept the participant policy.</span>
          </label>
          <ErrorNotice message={error} />
          <div className="form-actions">
            <button type="submit" className="primary" disabled={busy || !accepted}>
              {busy ? 'Saving…' : 'Accept and continue'}
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}
