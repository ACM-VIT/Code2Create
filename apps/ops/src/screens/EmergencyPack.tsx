import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type RequestAttempt = {
  purpose: string
  spareAttendanceSheetCount: number
  spareReviewSheetCount: number
  clientOperationId: string
}

type EmergencyPackId = FunctionReturnType<typeof api.emergencyPacks.list>[number]['id']

export function EmergencyPack({
  canRead,
  canPrepare,
  canPrint,
}: {
  canRead: boolean
  canPrepare: boolean
  canPrint: boolean
}) {
  const packs = useQuery(api.emergencyPacks.list, canRead ? { eventSlug } : 'skip')
  const requestPack = useMutation(api.emergencyPacks.request)
  const openPack = useAction(api.emergencyPackActions.print)
  const requestAttemptRef = useRef<RequestAttempt | null>(null)
  const [purpose, setPurpose] = useState('Current event-day paper fallback')
  const [spareAttendanceSheetCount, setSpareAttendanceSheetCount] = useState(4)
  const [spareReviewSheetCount, setSpareReviewSheetCount] = useState(4)
  const [preparing, setPreparing] = useState(false)
  const [openingPackId, setOpeningPackId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const changeRequest = () => {
    requestAttemptRef.current = null
    setError(null)
    setMessage(null)
  }

  const prepare = async () => {
    const normalizedPurpose = purpose.trim()
    const prior = requestAttemptRef.current
    const attempt =
      prior?.purpose === normalizedPurpose &&
      prior.spareAttendanceSheetCount === spareAttendanceSheetCount &&
      prior.spareReviewSheetCount === spareReviewSheetCount
        ? prior
        : {
            purpose: normalizedPurpose,
            spareAttendanceSheetCount,
            spareReviewSheetCount,
            clientOperationId: crypto.randomUUID(),
          }
    requestAttemptRef.current = attempt
    setPreparing(true)
    setError(null)
    setMessage(null)
    try {
      await requestPack({ eventSlug, ...attempt })
      requestAttemptRef.current = null
      setMessage(
        canRead
          ? 'Pack requested. Its status will update below.'
          : 'Pack requested. An operator with read access can follow its status.',
      )
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setPreparing(false)
    }
  }

  const print = async (packId: EmergencyPackId) => {
    setOpeningPackId(packId)
    setError(null)
    try {
      const result = await openPack({ eventSlug, packId })
      window.location.assign(result.url)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setOpeningPackId(null)
    }
  }

  return (
    <section className="emergency-pack-shell">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Event fallback</p>
          <h1>Recovery</h1>
          <p className="muted">
            Prepare a current paper backup for check-in and judging if the live system becomes unavailable.
          </p>
        </div>
      </header>

      <div className="emergency-pack-warning">
        <strong>This pack is a backup, not a mode switch.</strong>
        <p>
          The incident lead decides when to use it. Every completed sheet must still be entered and checked by a second person.
        </p>
      </div>

      {canPrepare ? (
        <form
          className="emergency-pack-form"
          onSubmit={(event) => {
            event.preventDefault()
            void prepare()
          }}
        >
          <label className="field">
            <span>Purpose</span>
            <textarea
              minLength={10}
              maxLength={240}
              required
              value={purpose}
              onChange={(event) => {
                changeRequest()
                setPurpose(event.target.value)
              }}
            />
          </label>
          <div className="emergency-pack-count-fields">
            <label className="field">
              <span>Extra check-in sheets</span>
              <input
                type="number"
                min={0}
                max={20}
                required
                value={spareAttendanceSheetCount}
                onChange={(event) => {
                  changeRequest()
                  const next = event.currentTarget.valueAsNumber
                  setSpareAttendanceSheetCount(Number.isNaN(next) ? 0 : next)
                }}
              />
            </label>
            <label className="field">
              <span>Extra judging sheets</span>
              <input
                type="number"
                min={0}
                max={20}
                required
                value={spareReviewSheetCount}
                onChange={(event) => {
                  changeRequest()
                  const next = event.currentTarget.valueAsNumber
                  setSpareReviewSheetCount(Number.isNaN(next) ? 0 : next)
                }}
              />
            </label>
          </div>
          <p className="muted">
            Current check-in phones and judging panels already receive one sheet each. Add only the extras you expect to need.
          </p>
          <button
            className="primary"
            type="submit"
            disabled={
              preparing ||
              purpose.trim().length < 10 ||
              !validCount(spareAttendanceSheetCount) ||
              !validCount(spareReviewSheetCount)
            }
          >
            {preparing ? 'Preparing…' : 'Prepare paper backup'}
          </button>
        </form>
      ) : (
        <p className="muted">This account cannot prepare a paper backup.</p>
      )}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}

      <section className="emergency-pack-history">
        <div className="section-heading">
          <h2>Recent backups</h2>
          <p className="muted">
            Each backup expires after four hours. Opening it is permission-checked and recorded.
          </p>
        </div>
        {!canRead ? (
          <p className="muted">This account cannot view prepared backups.</p>
        ) : packs === undefined ? (
          <p className="muted">Loading prepared backups…</p>
        ) : packs.length === 0 ? (
          <p className="muted">No paper backup has been prepared.</p>
        ) : (
          <ol className="emergency-pack-list">
            {packs.map((pack) => {
              const status = pack.expiresAt <= now ? 'expired' : pack.status
              return <li key={pack.id}>
                <div className="emergency-pack-main">
                  <div>
                    <span className={`state-label ${status}`}>{statusLabel(status)}</span>
                    <strong>{pack.purpose}</strong>
                    <small>
                      Requested by {pack.requestedByName} · {formatDateTime(pack.requestedAt)}
                    </small>
                  </div>
                  {pack.counts ? (
                    <dl className="emergency-pack-counts">
                      <Count label="People" value={pack.counts.participants} />
                      <Count label="Stations" value={pack.counts.stations} />
                      <Count label="Panels" value={pack.counts.panels} />
                      <Count
                        label="Sheets"
                        value={pack.counts.attendanceSheets + pack.counts.reviewSheets}
                      />
                    </dl>
                  ) : null}
                </div>
                <div className="emergency-pack-meta">
                  <span>
                    {pack.snapshotAt === undefined
                      ? 'Snapshot pending'
                      : `Snapshot ${formatDateTime(pack.snapshotAt)}`}
                  </span>
                  <span>Expires {formatDateTime(pack.expiresAt)}</span>
                  {pack.byteCount !== undefined ? <span>{formatBytes(pack.byteCount)}</span> : null}
                </div>
                {status === 'ready' && canPrint ? (
                  <button
                    className="secondary"
                    type="button"
                    disabled={openingPackId !== null}
                    onClick={() => void print(pack.id)}
                  >
                    {openingPackId === pack.id ? 'Opening…' : 'Open paper backup'}
                  </button>
                ) : null}
                {status === 'failed' ? (
                  <p className="notice error">Generation failed: {pack.failureCode ?? 'unknown reason'}.</p>
                ) : null}
              </li>
            })}
          </ol>
        )}
      </section>
    </section>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function validCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 20
}

function statusLabel(value: 'pending' | 'ready' | 'failed' | 'expired') {
  if (value === 'pending') return 'Preparing'
  if (value === 'ready') return 'Ready to print'
  if (value === 'failed') return 'Failed'
  return 'Expired'
}

function formatDateTime(value: number) {
  return new Date(value).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatBytes(value: number) {
  if (value < 1_000) return `${value} B`
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`
  return `${(value / 1_000_000).toFixed(1)} MB`
}
