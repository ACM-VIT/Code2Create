import { api } from '@code2create/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type DeliveryRecipients = FunctionReturnType<typeof api.participantNotifications.forApplication>
type DeliveryRecipient = DeliveryRecipients[number]
type DeliveryState = NonNullable<DeliveryRecipient['delivery']>['state']
type ApplicationId = FunctionArgs<typeof api.participantNotifications.forApplication>['applicationId']
type Command = 'retry' | 'disable'

const deliveryStateLabel: Record<DeliveryState, string> = {
  pending: 'Queued',
  sending: 'Sending',
  retry_wait: 'Waiting to retry',
  sent: 'Sent',
  delivery_delayed: 'Delayed',
  delivered: 'Mail server delivered',
  bounced: 'Bounced',
  failed: 'Failed',
  suppressed: 'Suppressed',
  unknown: 'Outcome unknown',
  superseded: 'Replaced by a newer email',
}

export function ParticipantDeliveryStatus({ applicationId }: { applicationId: ApplicationId }) {
  const recipients = useQuery(api.participantNotifications.forApplication, {
    eventSlug,
    applicationId,
  })

  if (recipients === undefined) {
    return (
      <section className="detail-section">
        <h2>Application email</h2>
        <p className="muted">Loading…</p>
      </section>
    )
  }
  if (recipients.length === 0) return null
  const needsAttention = recipients.some(
    (recipient) => recipient.delivery && deliveryNeedsAttention(recipient.delivery.state),
  )
  const deliveredCount = recipients.filter(
    (recipient) => recipient.delivery?.state === 'delivered',
  ).length

  return (
    <details className="application-record participant-delivery-record" open={needsAttention || undefined}>
      <summary>
        <span>Application email</span>
        <small>{needsAttention ? 'Needs attention' : `${deliveredCount} of ${recipients.length} delivered`}</small>
      </summary>
      <section className="detail-section">
        <div className="participant-delivery-list">
          {recipients.map((recipient) => (
            <DeliveryRow key={recipient.personId} recipient={recipient} />
          ))}
        </div>
      </section>
    </details>
  )
}

function deliveryNeedsAttention(state: DeliveryState) {
  return state === 'delivery_delayed' ||
    state === 'bounced' ||
    state === 'failed' ||
    state === 'suppressed' ||
    state === 'unknown'
}

function DeliveryRow({ recipient }: { recipient: DeliveryRecipient }) {
  const retryDelivery = useMutation(api.participantNotifications.retry)
  const disableDestination = useMutation(api.participantNotifications.disableDestination)
  const [command, setCommand] = useState<Command | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationId = useRef<string | null>(null)
  const destination = recipient.destination
  const delivery = recipient.delivery
  const canRetry = recipient.canManage && destination?.status === 'active' && delivery?.state === 'failed'
  const canDisable = recipient.canManage && destination?.status === 'active'

  useEffect(() => {
    operationId.current = null
  }, [command, reason, destination?.version, delivery?.version])

  const cancel = () => {
    setCommand(null)
    setReason('')
    setError(null)
    operationId.current = null
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!command || !reason.trim() || !destination) return
    const clientOperationId = operationId.current ?? crypto.randomUUID()
    operationId.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      if (command === 'retry') {
        if (!delivery || delivery.state !== 'failed') return
        await retryDelivery({
          eventSlug,
          deliveryId: delivery.id,
          expectedDeliveryVersion: delivery.version,
          reason,
          clientOperationId,
        })
      } else {
        await disableDestination({
          eventSlug,
          destinationId: destination.id,
          expectedDestinationVersion: destination.version,
          reason,
          clientOperationId,
        })
      }
      cancel()
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="participant-delivery-row">
      <div className="participant-delivery-summary">
        <strong>{recipient.displayName}</strong>
        <span>{destination?.email ?? 'No verified email address'}</span>
        <small>
          {delivery ? deliveryStateLabel[delivery.state] : 'Not sent yet'}
          {destination ? ` · email ${destination.status === 'active' ? 'enabled' : 'disabled'}` : ''}
          {delivery?.updatedAt ? ` · ${new Date(delivery.updatedAt).toLocaleString()}` : ''}
        </small>
        {delivery?.providerErrorCode ? (
          <small>{delivery.providerErrorCode.replaceAll('_', ' ')}</small>
        ) : null}
        {delivery?.state === 'unknown' ? (
          <small>Reconcile this message in Cloudflare Email logs before taking another send action.</small>
        ) : null}
      </div>
      {canRetry || canDisable ? (
        <div className="participant-delivery-actions">
          {canRetry ? (
            <button className="text-button" type="button" onClick={() => setCommand('retry')}>
              Retry
            </button>
          ) : null}
          {canDisable ? (
            <button className="text-button" type="button" onClick={() => setCommand('disable')}>
              Stop email
            </button>
          ) : null}
        </div>
      ) : null}
      {command ? (
        <form className="participant-delivery-command" onSubmit={submit}>
          <p>
            {command === 'retry'
              ? 'Try this failed email once more.'
              : 'Stop future email to this address. A message already being sent may still arrive.'}
          </p>
          <label className="field">
            <span>Reason</span>
            <textarea
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <small>Requires a Google sign-in from the last 15 minutes.</small>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
          <div className="button-row">
            <button className="primary" type="submit" disabled={busy || !reason.trim()}>
              {busy ? 'Saving…' : command === 'retry' ? 'Retry email' : 'Stop email'}
            </button>
            <button className="secondary" type="button" disabled={busy} onClick={cancel}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
