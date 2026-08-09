import { api } from '@code2create/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { LoadingLabel, SkeletonList } from './Skeleton'

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

export function ParticipantDeliveryStatus(
  { applicationId, teamName }: { applicationId: ApplicationId; teamName: string },
) {
  const recipients = useQuery(api.participantNotifications.forApplication, {
    eventSlug,
    applicationId,
  })

  if (recipients === undefined) {
    return (
      <section className="detail-section">
        <h2>Decision email</h2>
        <LoadingLabel>Loading email delivery</LoadingLabel>
        <SkeletonList rows={2} />
      </section>
    )
  }
  if (recipients.length === 0) return null

  const stuck = recipients.filter(
    (recipient) => recipient.delivery && deliveryNeedsAttention(recipient.delivery.state),
  )
  const unreachable = recipients.filter((recipient) => recipient.destination === null)
  const deliveredCount = recipients.filter(
    (recipient) => recipient.delivery?.state === 'delivered',
  ).length
  // Anyone the decision did not reach comes first: they are the reason to read this at all.
  const attention = [...new Set([...stuck, ...unreachable])]
  const ordered = [...attention, ...recipients.filter((recipient) => !attention.includes(recipient))]

  return (
    <section className="detail-section">
      <h2>Decision email</h2>
      {/* A count on its own never said what it cost. Each line below names who is
          affected and what they do not know as a result. */}
      <p className="muted">{deliverySentence({ teamName, recipients, unreachable, stuck, deliveredCount })}</p>
      <div className="participant-delivery-list">
        {ordered.map((recipient) => (
          <DeliveryRow key={recipient.personId} recipient={recipient} />
        ))}
      </div>
    </section>
  )
}

function deliverySentence(
  { teamName, recipients, unreachable, stuck, deliveredCount }: {
    teamName: string
    recipients: DeliveryRecipients
    unreachable: DeliveryRecipients
    stuck: DeliveryRecipients
    deliveredCount: number
  },
) {
  const missing = new Set([...unreachable, ...stuck]).size
  if (missing === 0) {
    return deliveredCount === recipients.length
      ? `Everyone on ${teamName} has the decision.`
      : `${deliveredCount} of ${recipients.length} on ${teamName} are confirmed to have the decision. The rest are still in the mail queue.`
  }
  if (missing === recipients.length) {
    return `Nobody on ${teamName} has the decision yet. Tell the team another way.`
  }
  return `${missing} of ${recipients.length} on ${teamName} do not have the decision yet.`
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
          <small>Check the Cloudflare Email logs before sending again.</small>
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
              : 'Stop future email to this address.'}
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
