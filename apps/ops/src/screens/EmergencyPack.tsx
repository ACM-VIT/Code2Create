import { api } from '@code2create/backend/api'
import { emergencyPackStatusLabels, type EmergencyPackStatus } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'

import { LoadingLabel, SkeletonCard, SkeletonList } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type RequestAttempt = {
  purpose: string
  spareAttendanceSheetCount: number
  spareReviewSheetCount: number
  clientOperationId: string
}

type EmergencyPack = FunctionReturnType<typeof api.emergencyPacks.list>[number]
type EmergencyPackId = EmergencyPack['id']

/**
 * A backup you could print right now leads; one still being built comes next;
 * the ones that failed or went stale are a record of what was tried.
 */
const packOrder: Record<EmergencyPackStatus, number> = {
  ready: 0,
  pending: 1,
  failed: 2,
  expired: 3,
}

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
          ? 'Requested. It becomes printable above once it has been built.'
          : 'Requested. Someone with read access has to confirm it was built.',
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

  const packsByUse = packs
    ? [...packs]
      .map((pack) => ({ pack, status: currentStatus(pack, now) }))
      .sort((left, right) => packOrder[left.status] - packOrder[right.status] || right.pack.requestedAt - left.pack.requestedAt)
    : null
  const usable = packsByUse?.filter((entry) => entry.status === 'ready') ?? []
  const beingPrepared = packsByUse?.filter((entry) => entry.status === 'pending') ?? []

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
          The incident lead decides when to use it. Completed sheets still have to be entered and checked.
        </p>
      </div>

      {canRead && packsByUse === null ? (
        <>
          <LoadingLabel>Checking whether a paper backup is ready</LoadingLabel>
          <SkeletonCard lines={2} />
        </>
      ) : (
        <section className="stage-block">
          <PackLead
            beingPrepared={beingPrepared.length}
            canPrepare={canPrepare}
            canRead={canRead}
            usable={usable.map((entry) => entry.pack)}
          />
        </section>
      )}

      <section className="emergency-pack-history">
        <h2>Prepared backups</h2>
        <p className="section-note">
          A printable snapshot of the roster, stations, panels and blank sheets. It expires four hours later.
        </p>
        {!canRead ? (
          <p className="muted">This account cannot view prepared backups.</p>
        ) : packsByUse === null ? (
          <>
            <LoadingLabel>Loading prepared backups</LoadingLabel>
            <SkeletonList rows={3} />
          </>
        ) : packsByUse.length === 0 ? (
          <div className="health-empty">
            <strong>Nothing has been prepared for this event.</strong>
            <span>
              {canPrepare
                ? 'Prepare one at the start of each shift.'
                : 'Preparing one needs the recovery permission, which you do not have.'}
            </span>
          </div>
        ) : (
          <ol className="emergency-pack-list">
            {packsByUse.map(({ pack, status }) => (
              <li key={pack.id}>
                <div className="emergency-pack-main">
                  <div>
                    <span className={`state-label ${status}`}>{emergencyPackStatusLabels[status]}</span>
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
                      ? 'The snapshot has not been taken yet'
                      : `Snapshot taken ${formatDateTime(pack.snapshotAt)}`}
                  </span>
                  <span>
                    {status === 'expired'
                      ? `Expired ${formatDateTime(pack.expiresAt)}`
                      : `Usable until ${formatDateTime(pack.expiresAt)}`}
                  </span>
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
                {status === 'ready' && !canPrint ? (
                  <p className="notice">
                    Opening this needs the recovery print permission, which you do not have.
                  </p>
                ) : null}
                {status === 'pending' ? (
                  <p className="notice">Still being built.</p>
                ) : null}
                {status === 'expired' ? (
                  <p className="notice">Too old to match who is in the venue. Prepare a fresh one.</p>
                ) : null}
                {status === 'failed' ? (
                  <p className="notice error">
                    This backup could not be built{pack.failureCode ? ` (${pack.failureCode})` : ''}. Prepare another one.
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {canPrepare ? (
        <form
          className="emergency-pack-form"
          onSubmit={(event) => {
            event.preventDefault()
            void prepare()
          }}
        >
          <p>Preparing takes a fresh snapshot and builds a new printable backup.</p>
          <label className="field">
            <span>What this backup is for</span>
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
            Every check-in phone and judging panel already gets one sheet.
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
        <p className="muted">
          Preparing a backup needs the recovery permission, which you do not have.
        </p>
      )}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
    </section>
  )
}

/**
 * What the event can fall back on right now, said before the form that changes
 * it. The screen used to open with a request form and leave the answer to a
 * line at the foot of the page.
 */
function PackLead({
  beingPrepared,
  canPrepare,
  canRead,
  usable,
}: {
  beingPrepared: number
  canPrepare: boolean
  canRead: boolean
  usable: EmergencyPack[]
}) {
  const first = usable[0]
  if (!canRead) {
    return (
      <>
        <p>This account cannot see whether a backup exists.</p>
        <p className="muted">
          {canPrepare
            ? 'You can prepare one, but someone with read access has to print it.'
            : 'Ask someone with recovery access whether a backup exists.'}
        </p>
      </>
    )
  }
  if (first) {
    return (
      <>
        <p>
          {usable.length === 1
            ? 'One paper backup is printable right now.'
            : `${usable.length} paper backups are printable right now.`}
          {` The newest stops being usable at ${formatDateTime(first.expiresAt)}.`}
        </p>
        <p className="muted">Print it before then, or the room falls back to nothing.</p>
      </>
    )
  }
  if (beingPrepared > 0) {
    return (
      <>
        <p>A backup is being built. Nothing is printable yet.</p>
      </>
    )
  }
  return (
    <>
      <p>No paper backup is prepared.</p>
      <p className="muted">
        If the live system goes down, check-in and judging have nothing to fall back on.
      </p>
    </>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function validCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 20
}

/**
 * The stored status says nothing about the four-hour lifetime, so a pack the
 * server still calls "ready" may already be useless on the floor.
 */
function currentStatus(pack: EmergencyPack, now: number): EmergencyPackStatus {
  return pack.expiresAt <= now ? 'expired' : pack.status
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
