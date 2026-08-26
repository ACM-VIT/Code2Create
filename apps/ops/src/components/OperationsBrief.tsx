import { api } from '@code2create/backend/api'
import { useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import { briefStreamObserverKey } from '../lib/operationsBrief'
import { Icon, type IconName } from './Icon'
import { OperationsBriefStream } from './OperationsBriefStream'

export function OperationsBrief({
  canGenerate,
  canRead,
}: {
  canGenerate: boolean
  canRead: boolean
}) {
  const brief = useQuery(
    api.operationsIntelligence.latest,
    canRead ? { eventSlug } : 'skip',
  )
  const requestBrief = useMutation(api.operationsIntelligence.request)
  const operations = useOperationRunner<
    FunctionReturnType<typeof api.operationsIntelligence.request>
  >()
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [traceOpen, setTraceOpen] = useState(false)
  const generate = async () => {
    setRequesting(true)
    setError(null)
    setMessage(null)
    try {
      await operations.run(
        'request',
        (clientOperationId) => () => requestBrief({ eventSlug, clientOperationId }),
      )
      setMessage(
        canRead
          ? 'The brief was requested.'
          : 'The brief was requested. Someone with read access can review it.',
      )
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setRequesting(false)
    }
  }

  const inProgress =
    brief?.state === 'pending' ||
    brief?.state === 'dispatching' ||
    brief?.state === 'accepted'
  const requestPending = operations.hasPending('request')
  const currentBriefId = brief?.id

  useEffect(() => {
    if (currentBriefId !== undefined && inProgress) setTraceOpen(true)
  }, [currentBriefId, inProgress])

  return (
    <section className="card-surface intelligence-brief" aria-labelledby="intelligence-brief-heading">
      <div className="section-heading intelligence-brief-heading">
        <div>
          <h2 id="intelligence-brief-heading">Operations brief</h2>
          <p className="muted">Current issues, owners, and next actions.</p>
        </div>
        {canGenerate ? (
          <button
            type="button"
            className="secondary"
            disabled={requesting || (inProgress && !requestPending)}
            onClick={() => void generate()}
          >
            {requesting
              ? 'Confirming…'
              : requestPending
                ? 'Confirm earlier request'
                : inProgress
                  ? 'Preparing…'
                  : brief
                    ? 'Refresh'
                    : 'Prepare brief'}
          </button>
        ) : null}
      </div>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {canRead && brief ? (
        <button
          className="text-button intelligence-brief-trace-toggle"
          onClick={() => setTraceOpen((open) => !open)}
          type="button"
        >
          {traceOpen ? 'Hide agent trace' : inProgress ? 'Show live agent trace' : 'View agent trace'}
        </button>
      ) : null}
      {canRead && brief && traceOpen ? (
        <OperationsBriefStream
          briefId={brief.id}
          isActive={inProgress}
          key={briefStreamObserverKey(brief.id, brief.workerAcceptedAt)}
        />
      ) : null}
      {canRead ? (
        brief === undefined ? (
          <p className="muted">Loading the latest brief…</p>
        ) : brief === null ? (
          <p className="muted">No brief has been prepared yet.</p>
        ) : brief.state === 'succeeded' ? (
          <div className="intelligence-brief-result">
            <p className="eyebrow">
              Requested by an operator · Source checked{' '}
              {brief.sourceGeneratedAt ? formatDateTime(brief.sourceGeneratedAt) : 'recently'}
            </p>
            <h3>{brief.headline}</h3>
            <p>{brief.summary}</p>
            {brief.priorities.length > 0 ? (
              <ol className="health-list intelligence-priorities">
                {brief.priorities.map((priority) => (
                  <li className="list-row" key={priority.signalKeys.join(':')}>
                    <span className={`row-glyph ${priority.severity}`}>
                      <Icon name={severityIcon(priority.severity)} />
                    </span>
                    <div className="row-text">
                      <strong>{priority.title}</strong>
                      <small>{priority.why}</small>
                      <small>Owner: {priority.owner} · Next: {priority.nextAction}</small>
                    </div>
                    <span className="state-label">{severityLabel(priority.severity)}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : brief.state === 'failed' ? (
          <p className="muted">The brief could not be prepared.</p>
        ) : (
          <p className="muted">Preparing from a frozen copy of the current health signals…</p>
        )
      ) : (
        <p className="muted">You can request a brief but not read the result.</p>
      )}
    </section>
  )
}

function severityLabel(value: 'watch' | 'attention' | 'critical') {
  if (value === 'attention') return 'Needs attention'
  if (value === 'critical') return 'Critical'
  return 'Watch'
}

function severityIcon(value: 'watch' | 'attention' | 'critical'): IconName {
  return value === 'watch' ? 'pulse' : 'alert'
}

function formatDateTime(value: number) {
  return new Date(value).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
