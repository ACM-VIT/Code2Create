import { api } from '@code2create/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import * as Papa from 'papaparse'
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type Workspace = FunctionReturnType<typeof api.rosters.workspace>
type Entry = Workspace['entries'][number]
type PreviewRequest = FunctionArgs<typeof api.rosters.previewImport>
type ImportRow = PreviewRequest['rows'][number]
type RosterRole = ImportRow['role']
type BundleVersionId = PreviewRequest['bundleVersionIds'][number]

const maximumCsvBytes = 256 * 1024
const maximumRosterRows = 200
const rosterRoles = ['supreme', 'board', 'sc', 'jc', 'external_judge'] as const
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function Roster() {
  const workspace = useQuery(api.rosters.workspace, { eventSlug })
  const rosterPage = usePaginatedQuery(
    api.rosters.list,
    workspace?.canReadAll ? { eventSlug } : 'skip',
    { initialNumItems: 50 },
  )
  const confirmImport = useMutation(api.rosters.confirmImport)
  const [loadedRoster, setLoadedRoster] = useState<{
    fileName: string
    rows: ImportRow[]
  } | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [validFrom, setValidFrom] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [bundleVersionIds, setBundleVersionIds] = useState<BundleVersionId[]>([])
  const [reason, setReason] = useState('')
  const [fileInputKey, setFileInputKey] = useState(0)
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const preview = useQuery(api.rosters.previewImport, previewRequest ?? 'skip')

  useEffect(() => {
    if (!workspace) return
    setValidFrom((current) => current || localDateTime(workspace.recommendedValidFrom))
    const recommendedEnd = workspace.recommendedValidUntil
    if (recommendedEnd !== undefined) {
      setValidUntil((current) => current || localDateTime(recommendedEnd))
    }
  }, [workspace])

  if (workspace === undefined) return <p className="muted">Loading event team…</p>

  const entries = workspace.canReadAll
    ? rosterPage.results
    : workspace.entries

  const readCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    setPreviewRequest(null)
    setMessage(null)
    setError(null)
    if (!file) {
      setLoadedRoster(null)
      return
    }
    if (file.size > maximumCsvBytes) {
      setLoadedRoster(null)
      setError('The roster CSV must be 256 KB or smaller.')
      return
    }
    try {
      const parsed = parseRosterCsv(await file.text())
      setLoadedRoster({ fileName: file.name, rows: parsed })
      setSourceName((current) => current || sourceNameFromFile(file.name))
    } catch (caught) {
      setLoadedRoster(null)
      setError(readableError(caught))
    }
  }

  const requestPreview = (event: FormEvent) => {
    event.preventDefault()
    if (!loadedRoster) return
    const start = new Date(validFrom).getTime()
    const end = new Date(validUntil).getTime()
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
      setError('Choose a valid access start and end time.')
      return
    }
    if (end <= Date.now()) {
      setError('Roster access must end in the future.')
      return
    }
    if (
      workspace.recommendedValidUntil !== undefined &&
      end > workspace.recommendedValidUntil
    ) {
      setError('Roster access cannot outlive the event.')
      return
    }
    setError(null)
    setMessage(null)
    setPreviewRequest({
      eventSlug,
      sourceName,
      sourceFileName: loadedRoster.fileName,
      validFrom: start,
      validUntil: end,
      bundleVersionIds,
      rows: loadedRoster.rows,
      reason,
    })
  }

  const importRoster = async () => {
    if (!previewRequest || !preview) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await confirmImport({
        ...previewRequest,
        previewChecksum: preview.previewChecksum,
        clientOperationId: crypto.randomUUID(),
      })
      setMessage(
        `${result.createdCount} added, ${result.replacedCount} updated, ${result.unchangedCount} unchanged, and ${result.alreadyClaimedCount} already signed in.`,
      )
      setPreviewRequest(null)
      setLoadedRoster(null)
      setSourceName('')
      setBundleVersionIds([])
      setReason('')
      setFileInputKey((current) => current + 1)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="access-shell roster-workspace">
      <Link className="back-link" to="/access">← People and permissions</Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">People and permissions</p>
          <h1>Event team</h1>
          <p className="muted">
            Add approved organizers and judges before they sign in with Google.
          </p>
        </div>
      </header>

      {workspace.importBlocker ? <p className="notice">{workspace.importBlocker}</p> : null}

      {workspace.canImport ? (
        <section className="roster-import">
          <div>
            <h2>Bulk add from a spreadsheet</h2>
            <p className="muted">
              Upload up to 200 people with the columns <code>email,name,role</code>. Roles are Supreme, Board, SC, JC, or External Judge.
            </p>
          </div>

          {previewRequest ? (
            <RosterPreview
              busy={busy}
              preview={preview}
              onCancel={() => {
                setPreviewRequest(null)
                setError(null)
              }}
              onConfirm={() => void importRoster()}
            />
          ) : (
            <form className="roster-import-form" onSubmit={requestPreview}>
              <label className="field roster-file-field">
                <span>Team list</span>
                <input
                  required
                  accept=".csv,text/csv"
                  key={fileInputKey}
                  type="file"
                  onChange={(event) => void readCsv(event)}
                />
                {loadedRoster ? <small>{loadedRoster.rows.length} valid rows loaded</small> : null}
              </label>
              <label className="field">
                <span>List name</span>
                <input
                  required
                  maxLength={100}
                  minLength={3}
                  value={sourceName}
                  onChange={(event) => setSourceName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Access starts</span>
                <input
                  required
                  type="datetime-local"
                  value={validFrom}
                  onChange={(event) => setValidFrom(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Access ends</span>
                <input
                  required
                  max={workspace.recommendedValidUntil === undefined
                    ? undefined
                    : localDateTime(workspace.recommendedValidUntil)}
                  type="datetime-local"
                  value={validUntil}
                  onChange={(event) => setValidUntil(event.target.value)}
                />
              </label>
              <fieldset className="roster-bundles">
                <legend>Reusable access <small>Optional</small></legend>
                {workspace.bundles.map((bundle) => (
                  <label className="check-row" key={bundle.versionId}>
                    <input
                      checked={bundleVersionIds.includes(bundle.versionId)}
                      disabled={
                        !bundle.rosterCompatible ||
                        (!bundleVersionIds.includes(bundle.versionId) && bundleVersionIds.length >= 8)
                      }
                      type="checkbox"
                      onChange={(event) => {
                        if (event.target.checked) {
                          setBundleVersionIds((current) => [...current, bundle.versionId])
                        } else {
                          setBundleVersionIds((current) => current.filter((id) => id !== bundle.versionId))
                        }
                      }}
                    />
                    <span>
                      {bundle.label} · {bundle.entryCount} permissions
                      {!bundle.rosterCompatible ? ' · assign after sign-in' : ''}
                    </span>
                  </label>
                ))}
                {workspace.bundles.length === 0 ? (
                  <p className="muted">No reusable access sets are ready.</p>
                ) : null}
              </fieldset>
              <label className="field roster-reason">
                <span>Why this list is being added</span>
                <textarea
                  required
                  maxLength={300}
                  minLength={5}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button
                className="secondary"
                type="submit"
                disabled={
                  !loadedRoster ||
                  sourceName.trim().length < 3 ||
                  !validFrom ||
                  !validUntil ||
                  reason.trim().length < 5
                }
              >
                Review people
              </button>
            </form>
          )}
          {message ? <p className="notice" role="status">{message}</p> : null}
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </section>
      ) : null}

      <section className="roster-history">
        <div>
          <h2>People</h2>
          <p className="muted">Sign-in and access status update here in real time.</p>
        </div>
        <div className="roster-access-list">
          {entries.map((entry) => <RosterEntry key={entry.id} entry={entry} />)}
          {workspace.canReadAll && rosterPage.status === 'LoadingFirstPage' ? (
            <p className="muted">Loading people…</p>
          ) : null}
          {entries.length === 0 && (!workspace.canReadAll || rosterPage.status !== 'LoadingFirstPage') ? (
            <p className="empty">No people have been added.</p>
          ) : null}
        </div>
        {workspace.canReadAll && rosterPage.status === 'CanLoadMore' ? (
          <button className="secondary" type="button" onClick={() => rosterPage.loadMore(50)}>
            Load more entries
          </button>
        ) : null}
      </section>
    </section>
  )
}

function RosterPreview({
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: FunctionReturnType<typeof api.rosters.previewImport> | undefined
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!preview) return <p className="muted">Checking the roster against current event access…</p>
  return (
    <div className="roster-preview">
      <dl className="roster-preview-counts">
        <div><dt>New</dt><dd>{preview.counts.create}</dd></div>
        <div><dt>Update</dt><dd>{preview.counts.replace}</dd></div>
        <div><dt>Unchanged</dt><dd>{preview.counts.unchanged}</dd></div>
        <div><dt>Already signed in</dt><dd>{preview.counts.alreadyClaimed}</dd></div>
      </dl>
      <div className="roster-preview-rows">
        {preview.rows.map((row) => (
          <div key={`${row.rowNumber}:${row.email}`}>
            <span>{row.rowNumber}</span>
            <span><strong>{row.displayName}</strong><small>{row.email}</small></span>
            <span>{roleName(row.role)}</span>
            <span>{outcomeName(row.outcome)}</span>
          </div>
        ))}
      </div>
      <p className="muted">
        {preview.bundles.length === 0
          ? 'These people receive a role label but no permissions.'
          : `${preview.bundles.length} access set${preview.bundles.length === 1 ? '' : 's'} will be added when each person first signs in.`}
      </p>
      <div className="button-row">
        <button className="primary" type="button" disabled={busy} onClick={onConfirm}>
          {busy ? 'Adding…' : 'Add these people'}
        </button>
        <button className="text-button" type="button" disabled={busy} onClick={onCancel}>
          Edit
        </button>
      </div>
      <small className="muted">You may be asked to sign in again before adding these accounts.</small>
    </div>
  )
}

function RosterEntry({ entry }: { entry: Entry }) {
  const revoke = useMutation(api.rosters.revoke)
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirmRevoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await revoke({
        eventSlug,
        rosterEntryId: entry.id,
        expectedVersion: entry.version,
        reason,
        clientOperationId: crypto.randomUUID(),
      })
      setConfirming(false)
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="roster-access-row">
      <div>
        <strong>{entry.displayName}</strong>
        <span>{entry.email}</span>
        <small>{entry.sourceName} · {dateTime(entry.validFrom)} to {dateTime(entry.validUntil)}</small>
      </div>
      <div className="roster-access-state">
        <span>{entry.roleLabel}</span>
        <small>{statusName(entry.status)}</small>
        {entry.canRevoke ? (
          <button className="text-button" type="button" onClick={() => setConfirming((current) => !current)}>
            {confirming ? 'Keep' : 'Revoke'}
          </button>
        ) : null}
      </div>
      {confirming ? (
        <div className="roster-revoke">
          <label className="field">
            <span>Why remove this invitation?</span>
            <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="button-row">
            <button
              className="secondary"
              type="button"
              disabled={busy || reason.trim().length < 5}
              onClick={() => void confirmRevoke()}
            >
              {busy ? 'Removing…' : 'Remove invitation'}
            </button>
            <button className="text-button" type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </article>
  )
}

function parseRosterCsv(text: string): ImportRow[] {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false })
  const firstError = parsed.errors[0]
  if (firstError) {
    const row = firstError.row === undefined ? '' : ` on row ${firstError.row + 1}`
    throw new Error(`CSV parsing failed${row}: ${firstError.message}`)
  }
  const header = parsed.data[0]
  const normalizedHeader = header?.map((cell, index) =>
    (index === 0 ? cell.replace(/^\uFEFF/, '') : cell).trim().toLowerCase(),
  )
  if (
    normalizedHeader?.length !== 3 ||
    normalizedHeader[0] !== 'email' ||
    normalizedHeader[1] !== 'name' ||
    normalizedHeader[2] !== 'role'
  ) {
    throw new Error('The first CSV row must be exactly: email,name,role.')
  }
  const rows: ImportRow[] = []
  for (let index = 1; index < parsed.data.length; index += 1) {
    const source = parsed.data[index]
    if (!source || source.every((cell) => !cell.trim())) continue
    const email = source[0]?.trim().toLowerCase()
    const displayName = source[1]?.trim()
    const role = source[2] ? parsedRole(source[2]) : null
    if (source.length !== 3 || !email || !displayName || !role) {
      throw new Error(`CSV row ${index + 1} must contain one email, name, and valid role.`)
    }
    if (!emailPattern.test(email) || email.length > 254) {
      throw new Error(`CSV row ${index + 1} has an invalid email address.`)
    }
    if (displayName.length < 2 || displayName.length > 100) {
      throw new Error(`CSV row ${index + 1} needs a name between 2 and 100 characters.`)
    }
    rows.push({ rowNumber: index + 1, email, displayName, role })
  }
  if (rows.length === 0) throw new Error('The CSV contains no roster rows.')
  if (rows.length > maximumRosterRows) {
    throw new Error(`Import at most ${maximumRosterRows} roster rows at a time.`)
  }
  const duplicate = rows.find((row, index) =>
    rows.some((candidate, candidateIndex) => candidateIndex < index && candidate.email === row.email),
  )
  if (duplicate) throw new Error(`${duplicate.email} appears more than once in the CSV.`)
  return rows
}

function parsedRole(value: string): RosterRole | null {
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, '_')
  return rosterRoles.find((role) => role === normalized) ?? null
}

function sourceNameFromFile(fileName: string) {
  const base = fileName.replace(/\.csv$/i, '').trim().slice(0, 100)
  return base.length >= 3 ? base : 'Event roster'
}

function localDateTime(timestamp: number) {
  const date = new Date(timestamp)
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function dateTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}

function roleName(role: RosterRole) {
  if (role === 'external_judge') return 'External judge'
  if (role === 'sc') return 'SC'
  if (role === 'jc') return 'JC'
  return role.charAt(0).toUpperCase() + role.slice(1)
}

function outcomeName(outcome: FunctionReturnType<typeof api.rosters.previewImport>['rows'][number]['outcome']) {
  if (outcome === 'create') return 'New'
  if (outcome === 'replace_pending') return 'Update invitation'
  if (outcome === 'replace_expired') return 'Invite again'
  if (outcome === 'unchanged_pending') return 'Unchanged'
  return 'Already signed in'
}

function statusName(status: Entry['status']) {
  if (status === 'claimed') return 'Signed in'
  if (status === 'revoked') return 'Revoked'
  if (status === 'superseded') return 'Superseded'
  if (status === 'expired') return 'Expired'
  return 'Waiting for sign-in'
}
