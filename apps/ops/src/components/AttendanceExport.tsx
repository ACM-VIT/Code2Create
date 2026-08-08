import { api } from '@code2create/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useRef, useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type AttendanceOverview = FunctionReturnType<typeof api.attendanceOperations.overview>
type AttendanceSession = AttendanceOverview['sessions'][number]
type ExportRequest = FunctionArgs<typeof api.attendanceExports.request>
type ExportField = ExportRequest['fields'][number]
type ExportRecord = FunctionReturnType<typeof api.attendanceExports.list>[number]
type Lifetime = 'one_hour' | 'one_day' | 'three_days'

const defaultFields: ExportField[] = [
  'participant_reference',
  'full_name',
  'email',
  'participant_class',
  'expectation',
  'result',
  'present_duration_minutes',
  'late',
]

const fieldOptions: Array<{ field: ExportField; label: string }> = [
  { field: 'participant_reference', label: 'Participant reference' },
  { field: 'full_name', label: 'Full name' },
  { field: 'email', label: 'Verified email' },
  { field: 'participant_class', label: 'Participant class' },
  { field: 'institution', label: 'Institution' },
  { field: 'year_of_study', label: 'Year of study' },
  { field: 'vit_registration_number', label: 'VIT registration number' },
  { field: 'expectation', label: 'Expectation' },
  { field: 'state', label: 'Current state' },
  { field: 'result', label: 'Final result' },
  { field: 'confirmed_at', label: 'Confirmation time' },
  { field: 'present_duration_minutes', label: 'Present duration' },
  { field: 'late', label: 'Late flag' },
  { field: 'session_name', label: 'Session name' },
  { field: 'session_starts_at', label: 'Session start' },
  { field: 'session_ends_at', label: 'Session end' },
]

export default function AttendanceExport({ session }: { session: AttendanceSession }) {
  const exports = useQuery(api.attendanceExports.list, {
    eventSlug,
    sessionId: session.id,
  })
  const requestExport = useMutation(api.attendanceExports.request)
  const prepareDownload = useAction(api.attendanceExportActions.download)
  const [open, setOpen] = useState(false)
  const [purpose, setPurpose] = useState('')
  const [fields, setFields] = useState<ExportField[]>(defaultFields)
  const [lifetime, setLifetime] = useState<Lifetime>('one_day')
  const [busy, setBusy] = useState(false)
  const [downloadBusyId, setDownloadBusyId] = useState<string | null>(null)
  const [downloadLinks, setDownloadLinks] = useState<
    Record<string, { url: string; expiresAt: number; sha256: string }>
  >({})
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<{ clientOperationId: string; expiresAt: number } | null>(null)

  const invalidateRequest = () => {
    requestRef.current = null
    setError(null)
  }

  const toggleField = (field: ExportField, checked: boolean) => {
    invalidateRequest()
    setFields((current) => checked
      ? current.includes(field) ? current : [...current, field]
      : current.filter((candidate) => candidate !== field))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const identity = requestRef.current ?? {
      clientOperationId: crypto.randomUUID(),
      expiresAt: Date.now() + lifetimeMilliseconds(lifetime),
    }
    requestRef.current = identity
    setBusy(true)
    setError(null)
    try {
      await requestExport({
        eventSlug,
        sessionId: session.id,
        expectedSessionVersion: session.version,
        purpose,
        fields,
        expiresAt: identity.expiresAt,
        clientOperationId: identity.clientOperationId,
      })
      requestRef.current = null
      setPurpose('')
      setOpen(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const createDownloadLink = async (record: ExportRecord) => {
    setDownloadBusyId(record.id)
    setError(null)
    try {
      const result = await prepareDownload({ eventSlug, exportId: record.id })
      setDownloadLinks((current) => ({ ...current, [record.id]: result }))
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setDownloadBusyId(null)
    }
  }

  return (
    <section className="attendance-export-panel">
      <div className="section-heading">
        <div>
          <h2>Protected export</h2>
          <p className="muted">Create a purpose-limited CSV snapshot of this prepared cohort.</p>
        </div>
        {!open ? (
          <button className="secondary" type="button" onClick={() => setOpen(true)}>
            New export
          </button>
        ) : null}
      </div>

      {open ? (
        <form className="attendance-export-form" onSubmit={submit}>
          <label className="field">
            <span>Purpose</span>
            <textarea
              required
              value={purpose}
              onChange={(event) => {
                invalidateRequest()
                setPurpose(event.target.value)
              }}
              placeholder="Who needs this file, and what will they use it for?"
            />
          </label>
          <fieldset className="attendance-export-fields">
            <legend>Columns</legend>
            {fieldOptions.map((option) => (
              <label key={option.field}>
                <input
                  type="checkbox"
                  checked={fields.includes(option.field)}
                  onChange={(event) => toggleField(option.field, event.target.checked)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
          <label className="field attendance-export-lifetime">
            <span>Available for</span>
            <select
              value={lifetime}
              onChange={(event) => {
                invalidateRequest()
                setLifetime(parseLifetime(event.target.value))
              }}
            >
              <option value="one_hour">1 hour</option>
              <option value="one_day">24 hours</option>
              <option value="three_days">3 days</option>
            </select>
          </label>
          <p className="muted">
            The snapshot excludes scan history, credential values, hashes, QR values, and exception reasons. Request and download both require a recent Google sign-in.
          </p>
          <div className="button-row">
            <button
              className="primary"
              type="submit"
              disabled={busy || purpose.trim().length < 10 || fields.length === 0}
            >
              {busy ? 'Requesting…' : 'Create protected CSV'}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                requestRef.current = null
                setOpen(false)
                setError(null)
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {exports === undefined ? <p className="muted">Loading exports…</p> : null}
      {exports && exports.length > 0 ? (
        <ul className="attendance-export-list">
          {exports.map((record) => {
            const link = downloadLinks[record.id]
            const activeLink = link && link.expiresAt > Date.now() ? link : null
            return (
              <li key={`${record.id}-${record.version}`}>
                <div>
                  <strong>{exportStatus(record.status)}</strong>
                  <span>{record.purpose}</span>
                  <small>
                    {record.rowCount === undefined ? 'Waiting for snapshot' : `${record.rowCount} rows`}
                    {record.snapshotAt === undefined ? '' : ` · ${new Date(record.snapshotAt).toLocaleString()}`}
                    {record.sha256 === undefined ? '' : ` · ${record.sha256.slice(0, 12)}`}
                  </small>
                </div>
                {record.status === 'ready' ? (
                  activeLink ? (
                    <a className="text-button" href={activeLink.url} target="_blank" rel="noreferrer">
                      Download CSV
                    </a>
                  ) : (
                    <button
                      className="text-button"
                      type="button"
                      disabled={downloadBusyId === record.id}
                      onClick={() => void createDownloadLink(record)}
                    >
                      {downloadBusyId === record.id ? 'Preparing…' : 'Prepare download'}
                    </button>
                  )
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function lifetimeMilliseconds(lifetime: Lifetime) {
  if (lifetime === 'one_hour') return 60 * 60 * 1_000
  if (lifetime === 'three_days') return 3 * 24 * 60 * 60 * 1_000
  return 24 * 60 * 60 * 1_000
}

function parseLifetime(value: string): Lifetime {
  if (value === 'one_hour' || value === 'three_days') return value
  return 'one_day'
}

function exportStatus(status: ExportRecord['status']) {
  if (status === 'pending') return 'Preparing'
  if (status === 'ready') return 'Ready'
  if (status === 'failed') return 'Generation failed'
  return 'Expired'
}
