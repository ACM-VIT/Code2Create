import { api } from '@code2create/backend/api'
import { rollCallPresenceStateLabels } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useMutationAttempt } from '../lib/operations'

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
  const startAttempt = useMutationAttempt<FunctionReturnType<typeof api.attendanceRollCalls.start>>()
  const closeAttempt = useMutationAttempt<FunctionReturnType<typeof api.attendanceRollCalls.close>>()
  const startPending = startAttempt.hasPending('attendance-roll-call-start')
  const closePending = closeAttempt.hasPending('attendance-roll-call-close')
  const operationPending = startPending || closePending
  const active = rollCallData?.rollCalls.find((rollCall) => rollCall.state === 'active')
  const latest = active ?? rollCallData?.rollCalls[0]
  const roster = usePaginatedQuery(
    api.attendanceRollCalls.roster,
    active ? { eventSlug, rollCallId: active.id } : 'skip',
    { initialNumItems: 50 },
  )

  if (!session.canReadRollCalls) return null

  const resetStart = () => {
    setStartOpen(false)
    setName('')
    setReason('')
    setError(null)
  }

  const resetClose = () => {
    setCloseOpen(false)
    setCloseReason('')
    setError(null)
  }

  const submitStart = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await startAttempt.run('attendance-roll-call-start', () => {
        const args = {
          eventSlug,
          sessionId: session.id,
          expectedSessionVersion: session.version,
          kind,
          name,
          reason,
          clientOperationId: crypto.randomUUID(),
        }
        return () => startRollCall(args)
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
    if (!closePending && !active) return
    setBusy(true)
    setError(null)
    try {
      await closeAttempt.run('attendance-roll-call-close', () => {
        if (!active) throw new Error('The active roll call is no longer available to close.')
        const args = {
          eventSlug,
          rollCallId: active.id,
          expectedVersion: active.version,
          reason: closeReason,
          clientOperationId: crypto.randomUUID(),
        }
        return () => closeRollCall(args)
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
          <button
            className="secondary"
            type="button"
            disabled={operationPending || busy}
            onClick={() => setStartOpen(true)}
          >Start roll call</button>
        ) : null}
      </div>

      {rollCallData === undefined ? <p className="muted">Loading roll call…</p> : null}

      {startOpen ? (
        <form className="roll-call-form" onSubmit={submitStart}>
          <div className="roll-call-fields">
            <label className="field">
              <span>Type</span>
              <select disabled={busy || operationPending} value={kind} onChange={(event) => setKind(parseKind(event.target.value))}>
                <option value="incident">Incident</option>
                <option value="drill">Drill</option>
              </select>
            </label>
            <label className="field">
              <span>Name</span>
              <input disabled={busy || operationPending} required minLength={3} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="North hall evacuation" />
            </label>
            <label className="field roll-call-wide">
              <span>Reason</span>
              <textarea disabled={busy || operationPending} required minLength={5} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is a roll call being started?" />
            </label>
          </div>
          <p className="muted">Starts from the frozen cohort and current server-accepted venue state. Requires a Google sign-in from the last 15 minutes.</p>
          <div className="button-row">
            <button
              className="primary"
              type="submit"
              disabled={busy || closePending || (!startPending && (
                name.trim().length < 3 || reason.trim().length < 5
              ))}
            >{busy ? 'Starting…' : startPending ? 'Confirm roll call' : 'Start roll call'}</button>
            <button className="secondary" type="button" disabled={busy || operationPending} onClick={resetStart}>Cancel</button>
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
                      <span>{rollCallPresenceStateLabels[participant.state]} · {participant.updatedAt ? timeName(participant.updatedAt) : 'No venue scan'}</span>
                    </div>
                  ))}
                </div>
              )}
              {roster.status === 'CanLoadMore' ? (
                <button className="text-button" type="button" onClick={() => roster.loadMore(50)}>Load more people</button>
              ) : null}
              {session.canCloseRollCall && !closeOpen ? (
                <button
                  className="secondary roll-call-close"
                  type="button"
                  disabled={operationPending || busy}
                  onClick={() => setCloseOpen(true)}
                >Close roll call</button>
              ) : null}
            </>
          ) : (
            <p className="muted">Closed {latest.closedAt ? dateTimeName(latest.closedAt) : ''}{latest.closeReason ? ` · ${latest.closeReason}` : ''}</p>
          )}
        </div>
      ) : rollCallData !== undefined && !startOpen ? (
        <p className="empty">No roll call has been started for this session.</p>
      ) : null}

      {closeOpen && (active || closePending) ? (
        <form className="roll-call-form" onSubmit={submitClose}>
          <label className="field">
            <span>Close reason</span>
            <textarea disabled={busy || operationPending} required minLength={5} maxLength={300} value={closeReason} onChange={(event) => setCloseReason(event.target.value)} />
          </label>
          <p className="muted">Closing freezes the current counts. Later scans continue normal attendance but no longer change this roll call.</p>
          <div className="button-row">
            <button
              className="primary"
              type="submit"
              disabled={busy || startPending || (!closePending && closeReason.trim().length < 5)}
            >{busy ? 'Closing…' : closePending ? 'Confirm closure' : 'Close and freeze counts'}</button>
            <button className="secondary" type="button" disabled={busy || operationPending} onClick={resetClose}>Cancel</button>
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

function dateTimeName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
}

function timeName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp)
}
