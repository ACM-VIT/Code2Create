import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation } from 'convex/react'
import { useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type QueueResult = FunctionReturnType<typeof api.synesthesiaOperations.queue>
type QueueRequest = QueueResult['requests'][number]
type OpenReport = QueueRequest['openReports'][number]

type RequestActionKind =
  | 'approve'
  | 'reject'
  | 'hide'
  | 'queue'
  | 'pin'
  | 'defer'
  | 'start'
  | 'played'
  | 'skip'
  | 'suspend'
  | 'restore'

type RequestAction = {
  kind: RequestActionKind
  expectedVersion: number
  expectedAccessVersion: number
}

type ReportAction = {
  reportId: OpenReport['id']
  expectedVersion: number
  disposition: 'resolved' | 'dismissed'
}

function durationLabel(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function stateLabel(value: string) {
  return value.replaceAll('_', ' ')
}

function timestampFromLocal(value: string) {
  const timestamp = new Date(value).getTime()
  return Number.isSafeInteger(timestamp) ? timestamp : null
}

function actionLabel(kind: RequestActionKind) {
  if (kind === 'approve') return 'Approve request'
  if (kind === 'reject') return 'Decline request'
  if (kind === 'hide') return 'Hide request'
  if (kind === 'queue') return 'Add to queue'
  if (kind === 'pin') return 'Pin in queue'
  if (kind === 'defer') return 'Defer in queue'
  if (kind === 'start') return 'Mark playing'
  if (kind === 'played') return 'Mark played'
  if (kind === 'skip') return 'Skip request'
  if (kind === 'suspend') return 'Pause requester access'
  return 'Restore requester access'
}

export function SynesthesiaRequestCard({
  request,
  startAvailable,
}: {
  request: QueueRequest
  startAvailable: boolean
}) {
  const moderate = useMutation(api.synesthesiaOperations.moderateRequest)
  const schedule = useMutation(api.synesthesiaOperations.scheduleRequest)
  const acknowledge = useMutation(api.synesthesiaOperations.acknowledgePlayback)
  const resolveReport = useMutation(api.synesthesiaOperations.resolveReport)
  const setAccess = useMutation(api.synesthesiaOperations.setRequesterAccess)
  const [action, setAction] = useState<RequestAction | null>(null)
  const [reportAction, setReportAction] = useState<ReportAction | null>(null)
  const [reason, setReason] = useState('')
  const [publicText, setPublicText] = useState('')
  const [internalText, setInternalText] = useState('')
  const [scheduledFor, setScheduledFor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chooseAction = (kind: RequestActionKind) => {
    setAction({
      kind,
      expectedVersion: request.version,
      expectedAccessVersion: request.requesterAccessVersion,
    })
    setReportAction(null)
    setReason('')
    setPublicText('')
    setInternalText('')
    setScheduledFor('')
    setError(null)
  }

  const chooseReportAction = (
    report: OpenReport,
    disposition: ReportAction['disposition'],
  ) => {
    setAction(null)
    setReportAction({
      reportId: report.id,
      expectedVersion: report.version,
      disposition,
    })
    setReason('')
    setPublicText('')
    setInternalText('')
    setError(null)
  }

  const finish = () => {
    setAction(null)
    setReportAction(null)
    setReason('')
    setPublicText('')
    setInternalText('')
    setScheduledFor('')
  }

  const submitRequestAction = async () => {
    if (!action) return
    setBusy(true)
    setError(null)
    try {
      if (action.kind === 'approve' || action.kind === 'reject' || action.kind === 'hide') {
        await moderate({
          eventSlug,
          requestId: request.id,
          decision: action.kind,
          ...(publicText.trim() ? { publicReason: publicText } : {}),
          ...(internalText.trim() ? { internalNote: internalText } : {}),
          expectedVersion: action.expectedVersion,
          reason,
          clientOperationId: crypto.randomUUID(),
        })
      } else if (action.kind === 'queue' || action.kind === 'pin' || action.kind === 'defer') {
        const deferredTimestamp = action.kind === 'defer'
          ? timestampFromLocal(scheduledFor)
          : null
        if (action.kind === 'defer' && deferredTimestamp === null) {
          setError('Choose a valid future time for the deferred request.')
          return
        }
        await schedule({
          eventSlug,
          requestId: request.id,
          mode: action.kind === 'pin' ? 'pinned' : action.kind === 'defer' ? 'deferred' : 'normal',
          ...(deferredTimestamp !== null ? { scheduledFor: deferredTimestamp } : {}),
          expectedVersion: action.expectedVersion,
          reason,
          clientOperationId: crypto.randomUUID(),
        })
      } else if (action.kind === 'suspend' || action.kind === 'restore') {
        await setAccess({
          eventSlug,
          requestId: request.id,
          state: action.kind === 'suspend' ? 'suspended' : 'active',
          expectedAccessVersion: action.expectedAccessVersion,
          reason,
          clientOperationId: crypto.randomUUID(),
        })
      } else {
        await acknowledge({
          eventSlug,
          requestId: request.id,
          action: action.kind,
          expectedVersion: action.expectedVersion,
          reason,
          clientOperationId: crypto.randomUUID(),
        })
      }
      finish()
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const submitReportAction = async () => {
    if (!reportAction) return
    setBusy(true)
    setError(null)
    try {
      await resolveReport({
        eventSlug,
        reportId: reportAction.reportId,
        disposition: reportAction.disposition,
        publicResolution: publicText,
        ...(internalText.trim() ? { internalResolution: internalText } : {}),
        expectedVersion: reportAction.expectedVersion,
        reason,
        clientOperationId: crypto.randomUUID(),
      })
      finish()
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={request.state === 'playing' ? 'synesthesia-request playing' : 'synesthesia-request'}>
      <div className="synesthesia-request-heading">
        <div>
          <strong>{request.title}</strong>
          <span>
            {request.artist} · {durationLabel(request.durationSeconds)} · {request.energyTag}
            {request.isExplicit ? ' · explicit' : ''}
          </span>
        </div>
        <div className="synesthesia-request-state">
          <span>{stateLabel(request.state)}</span>
          <small>{request.voteCount} votes · {request.openReportCount} open reports</small>
        </div>
      </div>
      {request.note ? <p className="synesthesia-request-note">{request.note}</p> : null}
      {request.publicReason ? <p className="synesthesia-request-note">Participant message: {request.publicReason}</p> : null}
      {request.internalNote ? <p className="synesthesia-request-note">Internal note: {request.internalNote}</p> : null}
      {request.scheduledFor ? (
        <p className="synesthesia-request-note">Deferred until {new Date(request.scheduledFor).toLocaleString()}</p>
      ) : null}

      <div className="synesthesia-request-actions">
        {request.canModerate && request.state === 'pending' ? (
          <button type="button" className="text-button" onClick={() => chooseAction('approve')}>Approve</button>
        ) : null}
        {request.canModerate && ['pending', 'approved', 'queued'].includes(request.state) ? (
          <>
            <button type="button" className="text-button" onClick={() => chooseAction('reject')}>Decline</button>
            <button type="button" className="text-button" onClick={() => chooseAction('hide')}>Hide</button>
          </>
        ) : null}
        {request.canSchedule && (request.state === 'approved' || request.state === 'queued') ? (
          <>
            <button type="button" className="text-button" onClick={() => chooseAction('queue')}>Queue</button>
            <button type="button" className="text-button" onClick={() => chooseAction('pin')}>Pin</button>
            <button type="button" className="text-button" onClick={() => chooseAction('defer')}>Defer</button>
          </>
        ) : null}
        {request.canAcknowledgePlayback && startAvailable && (request.state === 'approved' || request.state === 'queued') ? (
          <button type="button" className="text-button" onClick={() => chooseAction('start')}>Start</button>
        ) : null}
        {request.canAcknowledgePlayback && request.state === 'playing' ? (
          <>
            <button type="button" className="text-button" onClick={() => chooseAction('played')}>Played</button>
            <button type="button" className="text-button" onClick={() => chooseAction('skip')}>Skip</button>
          </>
        ) : null}
        {request.canSuspendRequester ? (
          <button type="button" className="text-button" onClick={() => chooseAction('suspend')}>Pause access</button>
        ) : null}
        {request.canRestoreRequester ? (
          <button type="button" className="text-button" onClick={() => chooseAction('restore')}>Restore access</button>
        ) : null}
      </div>

      {action ? (
        <form
          className="synesthesia-command"
          onSubmit={(event) => {
            event.preventDefault()
            void submitRequestAction()
          }}
        >
          <strong>{actionLabel(action.kind)}</strong>
          {(action.kind === 'reject' || action.kind === 'hide') ? (
            <label className="field">
              <span>Participant message</span>
              <input value={publicText} minLength={3} maxLength={160} required onChange={(event) => setPublicText(event.target.value)} />
            </label>
          ) : null}
          {(action.kind === 'approve' || action.kind === 'reject' || action.kind === 'hide') ? (
            <label className="field">
              <span>Internal note, if useful</span>
              <input value={internalText} maxLength={300} onChange={(event) => setInternalText(event.target.value)} />
            </label>
          ) : null}
          {action.kind === 'defer' ? (
            <label className="field">
              <span>Play after</span>
              <input type="datetime-local" value={scheduledFor} required onChange={(event) => setScheduledFor(event.target.value)} />
            </label>
          ) : null}
          <label className="field">
            <span>Audit reason</span>
            <textarea value={reason} minLength={5} maxLength={200} required onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="synesthesia-command-actions">
            <button type="button" className="text-button" disabled={busy} onClick={finish}>Cancel</button>
            <button type="submit" className="secondary compact" disabled={busy || reason.trim().length < 5}>
              {busy ? 'Saving…' : 'Confirm'}
            </button>
          </div>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </form>
      ) : null}

      {request.openReportCount > 0 ? (
        <div className="synesthesia-reports">
          <strong>Reports</strong>
          {!request.canReadReports ? (
            <p>You need a separate permission to read report reasons.</p>
          ) : request.openReports.length === 0 ? (
            <p>No report reason is available in this bounded page.</p>
          ) : request.openReports.map((report) => (
            <div className="synesthesia-report" key={report.id}>
              <p>{report.reason}</p>
              <small>{new Date(report.createdAt).toLocaleString()}</small>
              {request.canResolveReports ? (
                <div>
                  <button type="button" className="text-button" onClick={() => chooseReportAction(report, 'resolved')}>Resolve</button>
                  <button type="button" className="text-button" onClick={() => chooseReportAction(report, 'dismissed')}>Dismiss</button>
                </div>
              ) : null}
            </div>
          ))}
          {request.reportsTruncated ? <p>Some report reasons are outside this bounded page.</p> : null}
        </div>
      ) : null}

      {reportAction ? (
        <form
          className="synesthesia-command"
          onSubmit={(event) => {
            event.preventDefault()
            void submitReportAction()
          }}
        >
          <strong>{reportAction.disposition === 'resolved' ? 'Resolve report' : 'Dismiss report'}</strong>
          <label className="field">
            <span>Participant-facing resolution</span>
            <input value={publicText} minLength={3} maxLength={160} required onChange={(event) => setPublicText(event.target.value)} />
          </label>
          <label className="field">
            <span>Internal resolution, if useful</span>
            <input value={internalText} maxLength={300} onChange={(event) => setInternalText(event.target.value)} />
          </label>
          <label className="field">
            <span>Audit reason</span>
            <textarea value={reason} minLength={5} maxLength={200} required onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="synesthesia-command-actions">
            <button type="button" className="text-button" disabled={busy} onClick={finish}>Cancel</button>
            <button type="submit" className="secondary compact" disabled={busy || reason.trim().length < 5 || publicText.trim().length < 3}>
              {busy ? 'Saving…' : 'Confirm'}
            </button>
          </div>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </form>
      ) : null}
    </article>
  )
}
