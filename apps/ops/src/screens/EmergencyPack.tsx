import { api } from '@code2create/backend/api'
import { emergencyPackStatusLabels, type EmergencyPackStatus } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useState } from 'react'

import { LoadingLabel, SkeletonCard, SkeletonList } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { formatCompactDateTime } from '../lib/dateTime'
import { readableError } from '../lib/errors'
import { useMutationAttempt } from '../lib/operations'
import { useEstimatedServerNow } from '../lib/useEstimatedServerNow'

type EmergencyPack = FunctionReturnType<typeof api.emergencyPacks.list>['packs'][number]
type EmergencyPackId = EmergencyPack['id']

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
  const result = useQuery(api.emergencyPacks.list, canRead ? { eventSlug } : 'skip')
  const now = useEstimatedServerNow(result?.serverNow, 30_000)
  const packs = result?.packs
  const requestPack = useMutation(api.emergencyPacks.request)
  const openPack = useAction(api.emergencyPackActions.print)
  const requestAttempt = useMutationAttempt<FunctionReturnType<typeof api.emergencyPacks.request>>()
  const [purpose, setPurpose] = useState('Current event-day paper fallback')
  const [spareAttendanceSheetCount, setSpareAttendanceSheetCount] = useState(4)
  const [spareReviewSheetCount, setSpareReviewSheetCount] = useState(4)
  const [preparing, setPreparing] = useState(false)
  const [openingPackId, setOpeningPackId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const requestPending = requestAttempt.hasPending('emergency-pack-request')

  const changeRequest = () => {
    setError(null)
    setMessage(null)
  }

  const prepare = async () => {
    const normalizedPurpose = purpose.trim()
    setPreparing(true)
    setError(null)
    setMessage(null)
    try {
      await requestAttempt.run('emergency-pack-request', () => {
        const args = {
          eventSlug,
          purpose: normalizedPurpose,
          spareAttendanceSheetCount,
          spareReviewSheetCount,
          clientOperationId: crypto.randomUUID(),
        }
        return () => requestPack(args)
      })
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
          <p className="emergency-pack-boundary">
            The incident lead decides when to use a paper backup. Completed sheets must still be entered and checked.
          </p>
        </section>
      )}

      <section
        className="emergency-pack-history"
        hidden={!canRead || packsByUse === null || packsByUse.length === 0}
      >
        <h2>Prepared backups</h2>
        <p className="section-note">
          A printable copy of the roster, stations, panels and blank sheets. It expires after four hours.
        </p>
        {!canRead ? (
          <p className="muted">Prepared backups are not available to this account.</p>
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
                : 'An organizer with recovery access must prepare one.'}
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
                      Requested by {pack.requestedByName} · {formatCompactDateTime(pack.requestedAt)}
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
                      : `Snapshot taken ${formatCompactDateTime(pack.snapshotAt)}`}
                  </span>
                  <span>
                    {status === 'expired'
                      ? `Expired ${formatCompactDateTime(pack.expiresAt)}`
                      : `Usable until ${formatCompactDateTime(pack.expiresAt)}`}
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
                    You can view this backup, but you cannot open the printable file.
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
                    This backup could not be built. Prepare another one.
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
          <h2>Prepare a backup</h2>
          <p>Preparing takes a fresh copy of everything and builds a new printable backup.</p>
          <label className="field">
            <span>What this backup is for</span>
            <textarea
              minLength={10}
              maxLength={240}
              required
              disabled={preparing || requestPending}
              value={purpose}
              onChange={(event) => {
                if (requestPending) return
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
                disabled={preparing || requestPending}
                value={spareAttendanceSheetCount}
                onChange={(event) => {
                  if (requestPending) return
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
                disabled={preparing || requestPending}
                value={spareReviewSheetCount}
                onChange={(event) => {
                  if (requestPending) return
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
            {preparing ? 'Preparing…' : requestPending ? 'Confirm backup request' : 'Prepare paper backup'}
          </button>
          {requestPending ? <p className="muted">Confirm the earlier backup request before changing it.</p> : null}
        </form>
      ) : (
        <p className="muted">This account cannot prepare backups.</p>
      )}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
    </section>
  )
}

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
          {` The newest stops being usable at ${formatCompactDateTime(first.expiresAt)}.`}
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

function currentStatus(pack: EmergencyPack, now: number): EmergencyPackStatus {
  return pack.expiresAt <= now ? 'expired' : pack.status
}


function formatBytes(value: number) {
  if (value < 1_000) return `${value} B`
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`
  return `${(value / 1_000_000).toFixed(1)} MB`
}
