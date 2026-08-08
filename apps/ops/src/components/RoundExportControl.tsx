import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useRef, useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type Workspace = FunctionReturnType<typeof api.roundExports.workspace>
type RoundId = Workspace['round']['id']

export function RoundExportControl({ roundId }: { roundId: RoundId }) {
  const workspace = useQuery(api.roundExports.workspace, { eventSlug, roundId })

  if (workspace === undefined) {
    return <p className="muted">Loading round export…</p>
  }

  const activeExport = workspace.activeExport
  return (
    <section className="score-final-command round-export-control">
      <div className="section-heading-row">
        <div>
          <h2>Round export</h2>
          <p className="muted">The round closes after a different person opens and verifies both files.</p>
        </div>
        {activeExport ? <span className="state-label">{stateName(activeExport.state)}</span> : null}
      </div>

      {activeExport ? <ExportSummary activeExport={activeExport} /> : null}

      {workspace.round.status === 'open' && !activeExport && workspace.canStart ? (
        <StartClose workspace={workspace} />
      ) : null}

      {activeExport?.state === 'generating' ? (
        <p className="notice">Judging writes are frozen while the JSON and CSV files are generated and checked.</p>
      ) : null}

      {activeExport?.state === 'failed' ? (
        workspace.canRetry ? (
          <RetryExport workspace={workspace} activeExport={activeExport} />
        ) : (
          <p className="notice error">Generation failed. An exact round export retry grant is required.</p>
        )
      ) : null}

      {activeExport && (activeExport.state === 'uploaded' || activeExport.state === 'verified') ? (
        <>
          {workspace.canReadFiles ? (
            <ExportDownloads activeExport={activeExport} />
          ) : (
            <p className="muted">You do not have permission to open these files.</p>
          )}
          {activeExport.state === 'uploaded' ? (
            workspace.canVerify ? (
              <VerifyExport workspace={workspace} activeExport={activeExport} />
            ) : (
              <p className="notice">Another authorized person must verify these files before the round can close.</p>
            )
          ) : null}
        </>
      ) : null}

      {activeExport?.state === 'verified' && workspace.round.status === 'closed' ? (
        <>
          <p className="notice">
            Verified {activeExport.verifiedAt ? formatTime(activeExport.verifiedAt) : ''}
            {activeExport.verifiedByName ? ` by ${activeExport.verifiedByName}` : ''}.
          </p>
          {workspace.canReopen && !workspace.hasParticipantRelease ? (
            <ReopenRound workspace={workspace} activeExport={activeExport} />
          ) : null}
          {workspace.hasParticipantRelease ? (
            <p className="muted">Participant feedback is published, so this round cannot use the ordinary reopen command.</p>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function ExportSummary({ activeExport }: { activeExport: NonNullable<Workspace['activeExport']> }) {
  return (
    <>
      <p className="muted">
        Started by {activeExport.requestedByName} · {formatTime(activeExport.requestedAt)}
      </p>
      <dl className="score-summary-grid round-export-counts">
        <Summary label="Teams" value={activeExport.counts.team} />
        <Summary label="Results" value={activeExport.counts.result} />
        <Summary label="Excluded" value={activeExport.counts.excluded} />
        <Summary label="Withdrawn" value={activeExport.counts.withdrawn} />
        <Summary label="Reviews" value={activeExport.counts.reviewSession} />
        <Summary label="Scorecards" value={activeExport.counts.scorecard} />
        <Summary label="Score submissions" value={activeExport.counts.scorecardVersion} />
        <Summary label="Corrections" value={activeExport.counts.correctionCase} />
        <Summary label="Paper records" value={activeExport.counts.manualReviewRecord} />
      </dl>
      {activeExport.failureCode ? <p className="notice error">{stateName(activeExport.failureCode)}</p> : null}
    </>
  )
}

function StartClose({ workspace }: { workspace: Workspace }) {
  const start = useMutation(api.roundExports.start)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const changed = () => {
    operationRef.current = null
    setError(null)
  }

  const submit = async () => {
    if (busy || !confirmed || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await start({
        eventSlug,
        roundId: workspace.round.id,
        expectedRoundVersion: workspace.round.version,
        reason,
        clientOperationId,
      })
      operationRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return <button className="secondary" type="button" onClick={() => setOpen(true)}>Review close</button>
  }
  return (
    <div className="score-command destructive-command">
      <p>This freezes judging writes and starts the private round export. It does not close the round yet.</p>
      <label className="field">
        <span>Close reason</span>
        <textarea disabled={busy} value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
      </label>
      <label className="check-filter">
        <input checked={confirmed} disabled={busy} type="checkbox" onChange={(event) => { setConfirmed(event.target.checked); changed() }} />
        I reviewed every team, review, correction, paper record, and score result shown above.
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy || !confirmed || reason.trim().length < 5} type="button" onClick={() => void submit()}>
          {busy ? 'Starting…' : 'Start export'}
        </button>
        <button className="secondary" disabled={busy} type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  )
}

function RetryExport({
  workspace,
  activeExport,
}: {
  workspace: Workspace
  activeExport: NonNullable<Workspace['activeExport']>
}) {
  const retry = useMutation(api.roundExports.retry)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const submit = async () => {
    if (busy || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await retry({
        eventSlug,
        roundExportId: activeExport.id,
        expectedExportVersion: activeExport.version,
        expectedRoundVersion: workspace.round.version,
        reason,
        clientOperationId,
      })
      operationRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="score-command">
      <label className="field">
        <span>Retry reason</span>
        <textarea disabled={busy} value={reason} onChange={(event) => { setReason(event.target.value); operationRef.current = null; setError(null) }} />
      </label>
      <button className="primary" disabled={busy || reason.trim().length < 5} type="button" onClick={() => void submit()}>
        {busy ? 'Retrying…' : 'Retry export'}
      </button>
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  )
}

function ExportDownloads({ activeExport }: { activeExport: NonNullable<Workspace['activeExport']> }) {
  const download = useAction(api.roundExportActions.download)
  const [busy, setBusy] = useState<'json' | 'csv' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const openFile = async (kind: 'json' | 'csv') => {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      const result = await download({ eventSlug, roundExportId: activeExport.id, kind })
      window.location.assign(result.url)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="round-export-files">
      <div className="button-row">
        <button className="secondary" disabled={busy !== null} type="button" onClick={() => void openFile('json')}>
          {busy === 'json' ? 'Preparing…' : 'Download JSON'}
        </button>
        <button className="secondary" disabled={busy !== null} type="button" onClick={() => void openFile('csv')}>
          {busy === 'csv' ? 'Preparing…' : 'Download CSV'}
        </button>
      </div>
      {activeExport.files ? (
        <dl className="file-manifest-list">
          <div><dt>JSON</dt><dd>{formatBytes(activeExport.files.json.byteCount)} · {shortHash(activeExport.files.json.sha256)}</dd></div>
          <div><dt>CSV</dt><dd>{formatBytes(activeExport.files.csv.byteCount)} · {shortHash(activeExport.files.csv.sha256)}</dd></div>
        </dl>
      ) : null}
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  )
}

function VerifyExport({
  workspace,
  activeExport,
}: {
  workspace: Workspace
  activeExport: NonNullable<Workspace['activeExport']>
}) {
  const verify = useAction(api.roundExportActions.verify)
  const [filesOpened, setFilesOpened] = useState(false)
  const [countsMatch, setCountsMatch] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const changed = () => {
    operationRef.current = null
    setError(null)
  }

  const submit = async () => {
    if (busy || !filesOpened || !countsMatch || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await verify({
        eventSlug,
        roundExportId: activeExport.id,
        expectedExportVersion: activeExport.version,
        expectedRoundVersion: workspace.round.version,
        filesOpened,
        countsMatch,
        reason,
        clientOperationId,
      })
      operationRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="score-command">
      <h3>Verify and close</h3>
      <label className="check-filter">
        <input checked={filesOpened} disabled={busy} type="checkbox" onChange={(event) => { setFilesOpened(event.target.checked); changed() }} />
        I opened both downloaded files and checked their contents.
      </label>
      <label className="check-filter">
        <input checked={countsMatch} disabled={busy} type="checkbox" onChange={(event) => { setCountsMatch(event.target.checked); changed() }} />
        The team, result, review, scorecard, correction, and paper-record counts match this screen.
      </label>
      <label className="field">
        <span>Verification reason</span>
        <textarea disabled={busy} value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
      </label>
      <button className="primary" disabled={busy || !filesOpened || !countsMatch || reason.trim().length < 5} type="button" onClick={() => void submit()}>
        {busy ? 'Verifying…' : 'Verify and close round'}
      </button>
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  )
}

function ReopenRound({
  workspace,
  activeExport,
}: {
  workspace: Workspace
  activeExport: NonNullable<Workspace['activeExport']>
}) {
  const reopen = useMutation(api.roundExports.reopen)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const changed = () => {
    operationRef.current = null
    setError(null)
  }

  const submit = async () => {
    if (busy || !confirmed || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await reopen({
        eventSlug,
        roundId: workspace.round.id,
        roundExportId: activeExport.id,
        expectedRoundVersion: workspace.round.version,
        expectedExportVersion: activeExport.version,
        reason,
        clientOperationId,
      })
      operationRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return <button className="text-button" type="button" onClick={() => setOpen(true)}>Reopen round</button>
  }
  return (
    <div className="score-command destructive-command">
      <p>The verified files remain in the audit history. Closing again creates a new export.</p>
      <label className="field">
        <span>Reopen reason</span>
        <textarea disabled={busy} value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
      </label>
      <label className="check-filter">
        <input checked={confirmed} disabled={busy} type="checkbox" onChange={(event) => { setConfirmed(event.target.checked); changed() }} />
        I understand corrections can resume and another verified export will be required.
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy || !confirmed || reason.trim().length < 5} type="button" onClick={() => void submit()}>
          {busy ? 'Reopening…' : 'Reopen round'}
        </button>
        <button className="secondary" disabled={busy} type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  )
}

function Summary({ label, value }: { label: string; value: number }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function stateName(value: string) {
  return value.replaceAll('_', ' ')
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function shortHash(value: string) {
  return `${value.slice(0, 12)}…`
}
