import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type AttendanceOverview = FunctionReturnType<typeof api.attendanceOperations.overview>
type AttendanceSession = AttendanceOverview['sessions'][number]
type RollCallKind = 'incident' | 'drill'

export function AttendanceRollCall({ session }: { session: AttendanceSession }) {
  const rollCallData = useQuery(
    api.attendanceRollCalls.forSession,
    session.canReadRollCalls ? { eventSlug, sessionId: session.id } : 'skip',
  )
  const startRollCall = useMutation(api.attendanceRollCalls.start)
  const closeRollCall = useMutation(api.attendanceRollCalls.close)
  const [startOpen, setStartOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [kind, setKind] = useState<RollCallKind>('incident')
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')
  const [closeReason, setCloseReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const startOperationId = useRef<string | null>(null)
  const closeOperationId = useRef<string | null>(null)
  const active = rollCallData?.rollCalls.find((rollCall) => rollCall.state === 'active')
  const latest = active ?? rollCallData?.rollCalls[0]
  const roster = usePaginatedQuery(
    api.attendanceRollCalls.roster,
    active ? { eventSlug, rollCallId: active.id } : 'skip',
    { initialNumItems: 50 },
  )

  useEffect(() => {
    startOperationId.current = null
  }, [kind, name, reason, session.version])

  useEffect(() => {
    closeOperationId.current = null
  }, [active?.version, closeReason])

  if (!session.canReadRollCalls) return null

  const resetStart = () => {
    startOperationId.current = null
    setStartOpen(false)
    setName('')
    setReason('')
    setError(null)
  }

  const resetClose = () => {
    closeOperationId.current = null
    setCloseOpen(false)
    setCloseReason('')
    setError(null)
  }

  const submitStart = async (event: FormEvent) => {
    event.preventDefault()
    const clientOperationId = startOperationId.current ?? crypto.randomUUID()
    startOperationId.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await startRollCall({
        eventSlug,
        sessionId: session.id,
        expectedSessionVersion: session.version,
        kind,
        name,
        reason,
        clientOperationId,
      })
      resetStart()
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const submitClose = async (event: FormEvent) => {
    event.preventDefault()
    if (!active) return
    const clientOperationId = closeOperationId.current ?? crypto.randomUUID()
    closeOperationId.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await closeRollCall({
        eventSlug,
        rollCallId: active.id,
        expectedVersion: active.version,
        reason: closeReason,
        clientOperationId,
      })
      resetClose()
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const canStart =
    session.canStartRollCall &&
    session.expectationBuildState === 'complete' &&
    session.expectationCount > 0 &&
    (session.status === 'ready' || session.status === 'open' || session.status === 'closing')

  return (
    <section className="roll-call-section">
      <div className="roll-call-heading">
        <div>
          <p className="eyebrow">Emergency accounting</p>
          <h2>Roll call</h2>
          <p className="muted">Freezes this session’s expected cohort and tracks venue scans for {rollCallData?.zoneName ?? session.zoneName}.</p>
        </div>
        {rollCallData !== undefined && !active && canStart && !startOpen ? (
          <button className="secondary" type="button" onClick={() => setStartOpen(true)}>Start roll call</button>
        ) : null}
      </div>

      {rollCallData === undefined ? <p className="muted">Loading roll call…</p> : null}

      {startOpen ? (
        <form className="roll-call-form" onSubmit={submitStart}>
          <div className="roll-call-fields">
            <label className="field">
              <span>Type</span>
              <select value={kind} onChange={(event) => setKind(parseKind(event.target.value))}>
                <option value="incident">Incident</option>
                <option value="drill">Drill</option>
              </select>
            </label>
            <label className="field">
              <span>Name</span>
              <input required minLength={3} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="North hall evacuation" />
            </label>
            <label className="field roll-call-wide">
              <span>Reason</span>
              <textarea required minLength={5} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is a roll call being started?" />
            </label>
          </div>
          <p className="muted">Starts from the frozen cohort and current server-accepted venue state. Requires a Google sign-in from the last 15 minutes.</p>
          <div className="button-row">
            <button className="primary" type="submit" disabled={busy || name.trim().length < 3 || reason.trim().length < 5}>{busy ? 'Starting…' : 'Start roll call'}</button>
            <button className="secondary" type="button" disabled={busy} onClick={resetStart}>Cancel</button>
          </div>
        </form>
      ) : null}

      {latest ? (
        <div className="roll-call-live">
          <div className="roll-call-title">
            <div>
              <strong>{latest.name}</strong>
              <span>{kindName(latest.kind)} · {stateName(latest.state)} · started {dateTimeName(latest.snapshotAt)}</span>
            </div>
            <span>{latest.currentCounts.expected} expected</span>
          </div>
          <dl className="roll-call-counts">
            <Count label="Inside" value={latest.currentCounts.inside} />
            <Count label="Not arrived" value={latest.currentCounts.notArrived} />
            <Count label="Temporarily out" value={latest.currentCounts.temporarilyOut} />
            <Count label="Elsewhere" value={latest.currentCounts.elsewhere} />
            <Count label="Unknown" value={latest.currentCounts.unknown} />
            <Count label="Departed" value={latest.currentCounts.departed} />
          </dl>
          <p className="roll-call-snapshot">
            Starting point: {latest.snapshotCounts.inside} inside, {latest.snapshotCounts.temporarilyOut} temporarily out, {latest.snapshotCounts.notArrived} not arrived
          </p>

          {active ? (
            <>
              {roster.status === 'LoadingFirstPage' ? <p className="muted">Loading expected people…</p> : (
                <div className="roll-call-roster">
                  {roster.results.map((participant) => (
                    <div key={participant.membershipId}>
                      <span><strong>{participant.displayName}</strong>{participant.teamName ? ` · ${participant.teamName}` : ''}</span>
                      <span>{presenceName(participant.state)} · {participant.updatedAt ? timeName(participant.updatedAt) : 'No venue scan'}</span>
                    </div>
                  ))}
                </div>
              )}
              {roster.status === 'CanLoadMore' ? (
                <button className="text-button" type="button" onClick={() => roster.loadMore(50)}>Load more people</button>
              ) : null}
              {session.canCloseRollCall && !closeOpen ? (
                <button className="secondary roll-call-close" type="button" onClick={() => setCloseOpen(true)}>Close roll call</button>
              ) : null}
            </>
          ) : (
            <p className="muted">Closed {latest.closedAt ? dateTimeName(latest.closedAt) : ''}{latest.closeReason ? ` · ${latest.closeReason}` : ''}</p>
          )}
        </div>
      ) : rollCallData !== undefined && !startOpen ? (
        <p className="empty">No roll call has been started for this session.</p>
      ) : null}

      {closeOpen && active ? (
        <form className="roll-call-form" onSubmit={submitClose}>
          <label className="field">
            <span>Close reason</span>
            <textarea required minLength={5} maxLength={300} value={closeReason} onChange={(event) => setCloseReason(event.target.value)} />
          </label>
          <p className="muted">Closing freezes the current counts. Later scans continue normal attendance but no longer change this roll call.</p>
          <div className="button-row">
            <button className="primary" type="submit" disabled={busy || closeReason.trim().length < 5}>{busy ? 'Closing…' : 'Close and freeze counts'}</button>
            <button className="secondary" type="button" disabled={busy} onClick={resetClose}>Cancel</button>
          </div>
        </form>
      ) : null}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function parseKind(value: string): RollCallKind {
  return value === 'drill' ? 'drill' : 'incident'
}

function kindName(value: RollCallKind) {
  return value === 'drill' ? 'Drill' : 'Incident'
}

function stateName(value: 'active' | 'closed') {
  return value === 'active' ? 'Active' : 'Closed'
}

function presenceName(value: string) {
  if (value === 'not_arrived') return 'Not arrived'
  if (value === 'temporarily_out') return 'Temporarily out'
  if (value === 'elsewhere') return 'Elsewhere'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function dateTimeName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
}

function timeName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp)
}
