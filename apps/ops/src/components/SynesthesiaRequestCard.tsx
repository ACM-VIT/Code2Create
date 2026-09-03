import { api } from '@code2create/backend/api'
import { songRequestStateLabels } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery } from 'convex/react'
import { useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'

type QueueResult = FunctionReturnType<typeof api.synesthesiaOperations.queue>
type QueueRequest = QueueResult['requests'][number] & { voteCount: number }
type ReportPage = FunctionReturnType<typeof api.synesthesiaOperations.reports>
type OpenReport = ReportPage['page'][number]
const reportPageSize = 12

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
  const operations = useOperationRunner()
  const [action, setAction] = useState<RequestAction | null>(null)
  const [reportAction, setReportAction] = useState<ReportAction | null>(null)
  const [reportsOpen, setReportsOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [publicText, setPublicText] = useState('')
  const [internalText, setInternalText] = useState('')
  const [scheduledFor, setScheduledFor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actionSlot = action ? `synesthesia-request-${action.kind}` : null
  const actionPending = actionSlot !== null && operations.hasPending(actionSlot)
  const reportPending = operations.hasPending('synesthesia-report-resolve')
  const operationPending = actionPending || reportPending

  const chooseAction = (kind: RequestActionKind) => {
    if (operationPending || busy) return
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
    if (operationPending || busy) return
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
    if (operationPending || busy) return
    setAction(null)
    setReportAction(null)
    setReason('')
    setPublicText('')
    setInternalText('')
    setScheduledFor('')
  }

  const submitRequestAction = async () => {
    if (!action) return
    const actionKind = action.kind
    setBusy(true)
    setError(null)
    try {
      if (actionKind === 'approve' || actionKind === 'reject' || actionKind === 'hide') {
        await operations.run(
          `synesthesia-request-${actionKind}`, (clientOperationId) => () => moderate({
            eventSlug,
            requestId: request.id,
            decision: actionKind,
            ...(publicText.trim() ? { publicReason: publicText } : {}),
            ...(internalText.trim() ? { internalNote: internalText } : {}),
            expectedVersion: action.expectedVersion,
            reason,
            clientOperationId,
          }),
        )
      } else if (actionKind === 'queue' || actionKind === 'pin' || actionKind === 'defer') {
        const deferredTimestamp = actionKind === 'defer'
          ? timestampFromLocal(scheduledFor)
          : null
        if (actionKind === 'defer' && deferredTimestamp === null) {
          setError('Choose a valid future time for the deferred request.')
          return
        }
        await operations.run(
          `synesthesia-request-${actionKind}`, (clientOperationId) => () => schedule({
            eventSlug,
            requestId: request.id,
            mode: actionKind === 'pin' ? 'pinned' : actionKind === 'defer' ? 'deferred' : 'normal',
            ...(deferredTimestamp !== null ? { scheduledFor: deferredTimestamp } : {}),
            expectedVersion: action.expectedVersion,
            reason,
            clientOperationId,
          }),
        )
      } else if (actionKind === 'suspend' || actionKind === 'restore') {
        await operations.run(
          `synesthesia-request-${actionKind}`, (clientOperationId) => () => setAccess({
            eventSlug,
            requestId: request.id,
            state: actionKind === 'suspend' ? 'suspended' : 'active',
            expectedAccessVersion: action.expectedAccessVersion,
            reason,
            clientOperationId,
          }),
        )
      } else {
        await operations.run(
          `synesthesia-request-${actionKind}`, (clientOperationId) => () => acknowledge({
            eventSlug,
            requestId: request.id,
            action: actionKind,
            expectedVersion: action.expectedVersion,
            reason,
            clientOperationId,
          }),
        )
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
      await operations.run(
        'synesthesia-report-resolve', (clientOperationId) => () => resolveReport({
          eventSlug,
          reportId: reportAction.reportId,
          disposition: reportAction.disposition,
          publicResolution: publicText,
          ...(internalText.trim() ? { internalResolution: internalText } : {}),
          expectedVersion: reportAction.expectedVersion,
          reason,
          clientOperationId,
        }),
      )
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
          <span>{songRequestStateLabels[request.state]}</span>
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
          <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => chooseAction('approve')}>Approve</button>
        ) : null}
        {request.canModerate && ['pending', 'approved', 'queued'].includes(request.state) ? (
          <>
            <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => chooseAction('reject')}>Decline</button>
            <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => chooseAction('hide')}>Hide</button>
          </>
        ) : null}
        {request.canSchedule && (request.state === 'approved' || request.state === 'queued') ? (
          <>
            <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => chooseAction('queue')}>Queue</button>
            <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => chooseAction('pin')}>Pin</button>
            <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => chooseAction('defer')}>Defer</button>
          </>
        ) : null}
        {request.canAcknowledgePlayback && startAvailable && (request.state === 'approved' || request.state === 'queued') ? (
          <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => chooseAction('start')}>Start</button>
        ) : null}
        {request.canAcknowledgePlayback && request.state === 'playing' ? (
          <>
            <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => chooseAction('played')}>Played</button>
            <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => chooseAction('skip')}>Skip</button>
          </>
        ) : null}
        {request.canSuspendRequester ? (
          <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => chooseAction('suspend')}>Pause access</button>
        ) : null}
        {request.canRestoreRequester ? (
          <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => chooseAction('restore')}>Restore access</button>
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
              <input disabled={operationPending || busy} value={publicText} minLength={3} maxLength={160} required onChange={(event) => setPublicText(event.target.value)} />
            </label>
          ) : null}
          {(action.kind === 'approve' || action.kind === 'reject' || action.kind === 'hide') ? (
            <label className="field">
              <span>Internal note, if useful</span>
              <input disabled={operationPending || busy} value={internalText} maxLength={300} onChange={(event) => setInternalText(event.target.value)} />
            </label>
          ) : null}
          {action.kind === 'defer' ? (
            <label className="field">
              <span>Play after</span>
              <input disabled={operationPending || busy} type="datetime-local" value={scheduledFor} required onChange={(event) => setScheduledFor(event.target.value)} />
            </label>
          ) : null}
          <label className="field">
            <span>Reason (kept on record)</span>
            <textarea disabled={operationPending || busy} value={reason} minLength={5} maxLength={200} required onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="synesthesia-command-actions">
            <button type="button" className="text-button" disabled={busy || operationPending} onClick={finish}>Cancel</button>
            <button type="submit" className="secondary compact" disabled={busy || reportPending || (!actionPending && reason.trim().length < 5)}>
              {busy ? 'Saving…' : actionPending ? 'Confirm earlier action' : 'Confirm'}
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
          ) : (
            <>
              <button
                className="text-button"
                type="button"
                onClick={() => setReportsOpen((open) => !open)}
              >
                {reportsOpen
                  ? 'Hide reports'
                  : `View ${request.openReportCount} open ${request.openReportCount === 1 ? 'report' : 'reports'}`}
              </button>
              {reportsOpen ? (
                <OpenReportList
                  busy={busy}
                  canResolve={request.canResolveReports}
                  operationPending={operationPending}
                  requestId={request.id}
                  onChoose={chooseReportAction}
                />
              ) : null}
            </>
          )}
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
            <span>What the participant is told</span>
            <input disabled={operationPending || busy} value={publicText} minLength={3} maxLength={160} required onChange={(event) => setPublicText(event.target.value)} />
          </label>
          <label className="field">
            <span>Internal note on the outcome, if useful</span>
            <input disabled={operationPending || busy} value={internalText} maxLength={300} onChange={(event) => setInternalText(event.target.value)} />
          </label>
          <label className="field">
            <span>Reason (kept on record)</span>
            <textarea disabled={operationPending || busy} value={reason} minLength={5} maxLength={200} required onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="synesthesia-command-actions">
            <button type="button" className="text-button" disabled={busy || operationPending} onClick={finish}>Cancel</button>
            <button type="submit" className="secondary compact" disabled={busy || actionPending || (!reportPending && (reason.trim().length < 5 || publicText.trim().length < 3))}>
              {busy ? 'Saving…' : reportPending ? 'Confirm earlier resolution' : 'Confirm'}
            </button>
          </div>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </form>
      ) : null}
    </article>
  )
}

function OpenReportList({
  busy,
  canResolve,
  operationPending,
  requestId,
  onChoose,
}: {
  busy: boolean
  canResolve: boolean
  operationPending: boolean
  requestId: QueueRequest['id']
  onChoose: (report: OpenReport, disposition: ReportAction['disposition']) => void
}) {
  const reports = usePaginatedQuery(
    api.synesthesiaOperations.reports,
    { eventSlug, requestId },
    { initialNumItems: reportPageSize },
  )

  if (reports.status === 'LoadingFirstPage') return <p>Loading reports…</p>
  if (reports.results.length === 0) return <p>No open reports.</p>

  return (
    <>
      {reports.results.map((report) => (
        <div className="synesthesia-report" key={report.id}>
          <p>{report.reason}</p>
          <small>{new Date(report.createdAt).toLocaleString()}</small>
          {canResolve ? (
            <div>
              <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => onChoose(report, 'resolved')}>Resolve</button>
              <button type="button" className="text-button" disabled={operationPending || busy} onClick={() => onChoose(report, 'dismissed')}>Dismiss</button>
            </div>
          ) : null}
        </div>
      ))}
      {reports.status === 'CanLoadMore' ? (
        <button
          className="text-button"
          type="button"
          onClick={() => reports.loadMore(reportPageSize)}
        >
          Load more reports
        </button>
      ) : null}
      {reports.status === 'LoadingMore' ? <p>Loading more reports…</p> : null}
    </>
  )
}
