import { api } from '@code2create/backend/api'
import { useMutation } from 'convex/react'
import { useState, type FormEvent } from 'react'
import { ErrorNotice } from '../components/Form'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import type { ParticipantMe } from '../types'

export function PolicyConsentScreen({ canAccept, me }: { canAccept: boolean; me: ParticipantMe }) {
  const acceptPolicy = useMutation(api.participants.acceptPolicy)
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const policy = me.participantPolicy.policy
  const operations = useOperationRunner()
  const acceptPending = operations.hasPending('participant-policy-accept')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await operations.run('participant-policy-accept', (clientOperationId) => () => acceptPolicy({
          eventSlug,
          participantPolicyVersionId: me.participantPolicy.id,
          accepted,
          clientOperationId,
        }))
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
        {canAccept ? (
          <form onSubmit={submit}>
            <label className="check-row">
              <input
                type="checkbox"
                checked={accepted}
                disabled={busy || acceptPending}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              <span>I accept the participant policy.</span>
            </label>
            <ErrorNotice message={error} />
            <div className="form-actions">
              <button type="submit" className="primary" disabled={busy || (!acceptPending && !accepted)}>
                {busy ? 'Saving…' : acceptPending ? 'Confirm earlier acceptance' : 'Accept and continue'}
              </button>
            </div>
          </form>
        ) : (
          <p className="notice">Policy acceptance is unavailable. Ask an organizer if this looks wrong.</p>
        )}
      </section>
    </main>
  )
}
