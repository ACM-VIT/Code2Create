import { api } from '@code2create/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import * as Papa from 'papaparse'
import { useState, type ChangeEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { Icon, type IconName } from '../components/Icon'
import { LoadingLabel, SkeletonCard, SkeletonList, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'

type Entry = FunctionReturnType<typeof api.teamRosters.list>['page'][number]
type PreviewRequest = FunctionArgs<typeof api.teamRosters.previewImport>
type ImportRow = PreviewRequest['rows'][number]
type TeamRole = ImportRow['role']
type PreviewResult = FunctionReturnType<typeof api.teamRosters.previewImport>
type ImportResult = FunctionReturnType<typeof api.teamRosters.confirmImport>

type EntryGroup = 'waiting' | 'joined' | 'skipped' | 'ended'

const maximumCsvBytes = 256 * 1024
const maximumTeamRosterRows = 200
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const roleByWrittenForm = new Map<string, TeamRole>([
  ['lead', 'lead'],
  ['team_lead', 'lead'],
  ['team lead', 'lead'],
  ['member', 'member'],
])

const teamRosterGroups: ReadonlyArray<{ key: EntryGroup; label: string }> = [
  { key: 'waiting', label: 'Waiting to sign in or for their lead' },
  { key: 'joined', label: 'On their team' },
  { key: 'skipped', label: 'Already on a team' },
  { key: 'ended', label: 'Removed or replaced' },
]

export function TeamRoster() {
  const workspace = useQuery(api.teamRosters.workspace, { eventSlug })
  const entryPage = usePaginatedQuery(
    api.teamRosters.list,
    workspace?.canRead ? { eventSlug } : 'skip',
    { initialNumItems: 50 },
  )
  const confirmImport = useMutation(api.teamRosters.confirmImport)
  const operations = useOperationRunner<ImportResult>()
  const [showImport, setShowImport] = useState(false)
  const [loadedRoster, setLoadedRoster] = useState<{
    fileName: string
    rows: ImportRow[]
  } | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [reason, setReason] = useState('')
  const [fileInputKey, setFileInputKey] = useState(0)
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const preview = useQuery(api.teamRosters.previewImport, previewRequest ?? 'skip')

  if (workspace === undefined) {
    return (
      <section className="access-shell roster-workspace">
        <LoadingLabel>Loading participant teams</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonList rows={5} />
      </section>
    )
  }

  const entries = entryPage.results
  const loadingPeople = entryPage.status === 'LoadingFirstPage'
  const waiting = workspace.entryCounts.waiting
  const joined = workspace.entryCounts.claimed
  const skipped = workspace.entryCounts.skipped
  const total = workspace.entryCounts.total

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
      setError('The team roster CSV must be 256 KB or smaller.')
      return
    }
    if (file.type.includes('spreadsheet') || file.name.toLowerCase().endsWith('.xlsx')) {
      setLoadedRoster(null)
      setError('Export the sheet as CSV and upload that file.')
      return
    }
    try {
      const parsed = parseTeamRosterCsv(await file.text())
      setLoadedRoster({ fileName: file.name, rows: parsed })
      setSourceName((current) => current || sourceNameFromFile(file.name))
    } catch (caught) {
      setLoadedRoster(null)
      setError(readableError(caught))
    }
  }

  const requestPreview = (event: FormEvent) => {
    event.preventDefault()
    setMessage(null)
    if (!loadedRoster) {
      setError('Choose the CSV holding the people you want to place on teams.')
      return
    }
    if (sourceName.trim().length < 3) {
      setError('Give this list a name of at least three characters.')
      return
    }
    if (reason.trim().length < 5) {
      setError('Say why this list is being added, in at least five characters.')
      return
    }
    setError(null)
    setPreviewRequest({
      eventSlug,
      sourceName,
      sourceFileName: loadedRoster.fileName,
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
      const result = await operations.run(
        'team-roster-import', (clientOperationId) => () => confirmImport({
          ...previewRequest,
          previewChecksum: preview.previewChecksum,
          clientOperationId,
        }),
      )
      setMessage(
        `Recorded ${result.rowCount} ${people(result.rowCount)}. They join their team as soon as they sign in, or right away if they already have an account.`,
      )
      setPreviewRequest(null)
      setLoadedRoster(null)
      setSourceName('')
      setReason('')
      setFileInputKey((current) => current + 1)
      setShowImport(false)
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
          <h1>Participant teams</h1>
          <p className="muted">
            Place participants on their assigned teams before they sign in. People already on a team are left there.
          </p>
        </div>
        {workspace.canImport ? (
          <button
            aria-expanded={showImport}
            className="secondary"
            type="button"
            onClick={() => setShowImport((current) => !current)}
          >
            {showImport ? 'Hide the spreadsheet form' : 'Import team assignments'}
          </button>
        ) : null}
      </header>

      {loadingPeople ? (
        <>
          <LoadingLabel>Loading participant teams</LoadingLabel>
          <SkeletonCard lines={3} />
          <SkeletonStats columns={3} />
        </>
      ) : (
        <section className="stage-block">
          <p className="eyebrow">Where this list stands</p>
          {total === 0 ? (
            <p>No team assignments have been imported yet.</p>
          ) : (
            <>
              <dl className="catalog-summary">
                <div><dt>On their team</dt><dd>{joined}</dd></div>
                <div><dt>Waiting</dt><dd>{waiting}</dd></div>
                <div><dt>Already on a team</dt><dd>{skipped}</dd></div>
              </dl>
              <p>
                {waiting === 0
                  ? 'Every imported person is on a team.'
                  : `${waiting} of ${total} ${people(total)} are still waiting to join their team.`}
              </p>
              {!workspace.canImport ? (
                <p className="muted">You can read this list but not import team assignments.</p>
              ) : null}
            </>
          )}
        </section>
      )}

      {message ? <p className="notice" role="status">{message}</p> : null}

      {workspace.canImport && showImport ? (
        <section className="roster-import">
          <div>
            <h2>Import team assignments</h2>
            <p className="muted">
              A CSV of up to {maximumTeamRosterRows} rows with the columns <code>email,name,team,role</code>.
              The role is lead or member. Export Excel as CSV.
            </p>
          </div>

          {previewRequest ? (
            <TeamRosterPreview
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
                  accept=".csv,text/csv"
                  key={fileInputKey}
                  type="file"
                  onChange={(event) => void readCsv(event)}
                />
                {loadedRoster ? (
                  <small>
                    {loadedRoster.rows.length} {people(loadedRoster.rows.length)} read from{' '}
                    {loadedRoster.fileName}
                  </small>
                ) : null}
              </label>
              <label className="field">
                <span>List name</span>
                <input
                  maxLength={100}
                  value={sourceName}
                  onChange={(event) => setSourceName(event.target.value)}
                />
              </label>
              <label className="field roster-reason">
                <span>Why this list is being added</span>
                <textarea
                  maxLength={300}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button className="secondary" type="submit">Check what this changes</button>
            </form>
          )}
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </section>
      ) : null}

      {loadingPeople ? (
        <SkeletonList rows={5} />
      ) : entries.length === 0 ? null : (
        teamRosterGroups.map((group) => {
          const rows = orderedEntries(entries, group.key)
          if (rows.length === 0) return null
          return (
            <section key={group.key}>
              <p className="board-section-label">{group.label} · {rows.length}</p>
              <div className="health-list">
                {rows.map((entry) => <TeamRosterEntry key={entry.id} entry={entry} canRevoke={workspace.canRevoke} />)}
              </div>
            </section>
          )
        })
      )}

      {workspace.canRead && entryPage.status === 'CanLoadMore' ? (
        <button className="secondary" type="button" onClick={() => entryPage.loadMore(50)}>
          Load more people
        </button>
      ) : null}
    </section>
  )
}

function TeamRosterPreview({
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: PreviewResult | undefined
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!preview) {
    return (
      <>
        <LoadingLabel>Checking this list against the teams people already have</LoadingLabel>
        <SkeletonCard lines={4} />
      </>
    )
  }
  return (
    <div className="roster-preview">
      <dl className="roster-preview-counts">
        <div><dt>Waiting to sign in</dt><dd>{preview.counts.pending}</dd></div>
        <div><dt>Already on a team</dt><dd>{preview.counts.alreadyOnTeam}</dd></div>
        <div><dt>Team lead not signed in</dt><dd>{preview.counts.waitingForLead}</dd></div>
        <div><dt>Replaces an earlier row</dt><dd>{preview.counts.superseded}</dd></div>
      </dl>
      <div className="roster-preview-rows">
        {preview.rows.map((row) => (
          <div key={`${row.rowNumber}:${row.email}`}>
            <span>{row.rowNumber}</span>
            <span><strong>{row.displayName}</strong><small>{row.email}</small></span>
            <span>{row.teamName} · {row.role}</span>
            <span>{outcomeName(row.outcome)}</span>
          </div>
        ))}
      </div>
      <p className="muted">
        People already on a team stay where they are. Everyone else joins the named team when they
        sign in, or immediately if they already have a participant account.
      </p>
      <div className="button-row">
        <button className="primary" type="button" disabled={busy} onClick={onConfirm}>
          {busy ? 'Importing…' : 'Place these people'}
        </button>
        <button className="text-button" type="button" disabled={busy} onClick={onCancel}>
          Go back and edit
        </button>
      </div>
    </div>
  )
}

function TeamRosterEntry({ entry, canRevoke }: { entry: Entry; canRevoke: boolean }) {
  const revoke = useMutation(api.teamRosters.revoke)
  const operations = useOperationRunner()
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const group = entryGroup(entry.status)

  const confirmRevoke = async () => {
    if (reason.trim().length < 5) {
      setError('Say why this assignment is being removed, in at least five characters.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await operations.run(
        'team-roster-revoke', (clientOperationId) => () => revoke({
          eventSlug,
          teamRosterEntryId: entry.id,
          expectedVersion: entry.version,
          reason,
          clientOperationId,
        }),
      )
      setConfirming(false)
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <article className="list-row">
        <span className={`row-glyph ${groupTone(group)}`}>
          <Icon name={groupIcon(group)} />
        </span>
        <div className="row-text">
          <strong>
            {entry.displayName}
            <span className="row-context"> · {entry.teamName} · {entry.role}</span>
          </strong>
          <small>{statusStatement(entry)}</small>
          <small className="row-context">{entry.email}</small>
        </div>
        {canRevoke && entry.canRevoke ? (
          <button
            className="row-action"
            type="button"
            onClick={() => setConfirming((current) => !current)}
          >
            {confirming ? 'Keep the assignment' : 'Remove'}
          </button>
        ) : null}
      </article>
      {confirming ? (
        <div className="roster-revoke">
          <label className="field">
            <span>Why {entry.displayName} is being removed</span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="button-row">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void confirmRevoke()}
            >
              {busy ? 'Removing…' : 'Remove assignment'}
            </button>
            <button className="text-button" type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </>
  )
}

function orderedEntries(entries: readonly Entry[], group: EntryGroup) {
  const rows = entries.filter((entry) => entryGroup(entry.status) === group)
  return rows.sort((left, right) => right.createdAt - left.createdAt)
}

function entryGroup(status: Entry['status']): EntryGroup {
  if (status === 'pending' || status === 'waiting_for_lead') return 'waiting'
  if (status === 'claimed') return 'joined'
  if (status === 'skipped_has_team') return 'skipped'
  return 'ended'
}

function groupTone(group: EntryGroup) {
  if (group === 'skipped') return 'watch'
  if (group === 'waiting') return 'watch'
  return ''
}

function groupIcon(group: EntryGroup): IconName {
  if (group === 'waiting') return 'clock'
  if (group === 'joined') return 'users'
  if (group === 'skipped') return 'pause'
  return 'alert'
}

function statusStatement(entry: Entry) {
  if (entry.status === 'pending') {
    return 'Has not signed in yet. They join the team automatically when they do.'
  }
  if (entry.status === 'waiting_for_lead') {
    return 'Signed in, but the team lead has not. They join as soon as the lead does.'
  }
  if (entry.status === 'claimed') return 'On their team.'
  if (entry.status === 'skipped_has_team') {
    return 'Was already on a team, so this assignment was skipped.'
  }
  if (entry.status === 'revoked') return 'The assignment was removed.'
  return 'A newer assignment for the same email address replaced this one.'
}

function parseTeamRosterCsv(text: string): ImportRow[] {
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
    normalizedHeader?.length !== 4 ||
    normalizedHeader[0] !== 'email' ||
    normalizedHeader[1] !== 'name' ||
    normalizedHeader[2] !== 'team' ||
    normalizedHeader[3] !== 'role'
  ) {
    throw new Error('The first CSV row must be exactly: email,name,team,role.')
  }
  const rows: ImportRow[] = []
  for (let index = 1; index < parsed.data.length; index += 1) {
    const source = parsed.data[index]
    if (!source || source.every((cell) => !cell.trim())) continue
    const email = source[0]?.trim().toLowerCase()
    const displayName = source[1]?.trim()
    const teamName = source[2]?.trim()
    const role = source[3] ? parsedRole(source[3]) : null
    if (source.length !== 4 || !email || !displayName || !teamName || !role) {
      throw new Error(
        'CSV row ' + (index + 1) + ' needs an email, a name, a team name, and a role of lead or member.',
      )
    }
    if (!emailPattern.test(email) || email.length > 254) {
      throw new Error(`CSV row ${index + 1} has an invalid email address.`)
    }
    if (displayName.length < 2 || displayName.length > 100) {
      throw new Error(`CSV row ${index + 1} needs a name between 2 and 100 characters.`)
    }
    if (teamName.length < 2 || teamName.length > 60) {
      throw new Error(`CSV row ${index + 1} needs a team name between 2 and 60 characters.`)
    }
    rows.push({ rowNumber: index + 1, email, displayName, teamName, role })
  }
  if (rows.length === 0) throw new Error('The CSV contains no team roster rows.')
  if (rows.length > maximumTeamRosterRows) {
    throw new Error(`Import at most ${maximumTeamRosterRows} team roster rows at a time.`)
  }
  const duplicate = rows.find((row, index) =>
    rows.some((candidate, candidateIndex) => candidateIndex < index && candidate.email === row.email),
  )
  if (duplicate) throw new Error(`${duplicate.email} appears more than once in the CSV.`)
  const leadByTeam: Record<string, number> = {}
  for (const row of rows) {
    leadByTeam[row.teamName] = (leadByTeam[row.teamName] ?? 0) + (row.role === 'lead' ? 1 : 0)
  }
  const badTeam = Object.entries(leadByTeam).find(([, leadCount]) => leadCount !== 1)
  if (badTeam) {
    throw new Error(
      `Team ${badTeam[0]} needs exactly one lead row. Give every team one lead.`,
    )
  }
  return rows
}

function parsedRole(value: string): TeamRole | null {
  return roleByWrittenForm.get(normalizedRoleText(value)) ?? null
}

function normalizedRoleText(value: string) {
  return value.trim().toLowerCase().replace(/[ -]+/g, '_')
}

function sourceNameFromFile(fileName: string) {
  const base = fileName.replace(/\.csv$/i, '').trim().slice(0, 100)
  return base.length >= 3 ? base : 'Team roster'
}

function people(count: number) {
  return count === 1 ? 'person' : 'people'
}

function outcomeName(outcome: PreviewResult['rows'][number]['outcome']) {
  if (outcome === 'pending') return 'Waiting to sign in'
  if (outcome === 'already_on_team') return 'Already on a team'
  return 'Lead not signed in yet'
}
