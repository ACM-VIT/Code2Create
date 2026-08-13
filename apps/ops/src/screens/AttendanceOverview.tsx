import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'

type AttendanceOverviewData = FunctionReturnType<typeof api.attendanceOperations.overview>
type AttendanceSessionData = AttendanceOverviewData['sessions'][number]
type AttendanceStationData = AttendanceOverviewData['stations'][number]
type SessionAction = {
  sessionId: AttendanceSessionData['id']
  command: 'extend' | 'close' | 'cancel'
}
type SessionCommand = SessionAction['command'] | 'prepare' | 'open'
type PendingSessionIntent = {
  sessionId: AttendanceSessionData['id']
  command: SessionCommand
}
type StationAction = {
  stationId: AttendanceStationData['id']
  command: 'disable' | 'enable'
}

export function AttendanceOverview() {
  const overview = useQuery(api.attendanceOperations.overview, { eventSlug })
  const prepare = useMutation(api.attendanceSessions.prepare)
  const open = useMutation(api.attendanceSessions.open)
  const extend = useMutation(api.attendanceSessions.extend)
  const close = useMutation(api.attendanceSessions.close)
  const cancel = useMutation(api.attendanceSessions.cancel)
  const disableStation = useMutation(api.attendanceSecurity.disableStation)
  const enableStation = useMutation(api.attendanceSecurity.enableStation)
  const operations = useOperationRunner()
  const [busySessionId, setBusySessionId] = useState<string | null>(null)
  const [sessionAction, setSessionAction] = useState<SessionAction | null>(null)
  const [pendingSessionIntent, setPendingSessionIntent] = useState<PendingSessionIntent | null>(null)
  const [sessionReason, setSessionReason] = useState('')
  const [extensionMinutes, setExtensionMinutes] = useState('30')
  const [stationAction, setStationAction] = useState<StationAction | null>(null)
  const [pendingStationIntent, setPendingStationIntent] = useState<StationAction | null>(null)
  const [stationReason, setStationReason] = useState('')
  const [busyStationId, setBusyStationId] = useState<AttendanceStationData['id'] | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (overview === undefined) return <p className="muted">Loading attendance…</p>

  const activeStationCount = overview.stations.filter(
    (station) => station.status === 'active',
  ).length
  const waitingStationCount = overview.stations.length - activeStationCount
  const pendingSessionSlot = pendingSessionIntent
    ? sessionOperationSlot(pendingSessionIntent)
    : null
  const sessionCommandPending = pendingSessionSlot !== null && operations.hasPending(pendingSessionSlot)
  const pendingStationSlot = pendingStationIntent
    ? stationOperationSlot(pendingStationIntent)
    : null
  const stationCommandPending = pendingStationSlot !== null && operations.hasPending(pendingStationSlot)
  const operationPending = sessionCommandPending || stationCommandPending

  const runSessionCommand = async (
    session: AttendanceSessionData | undefined,
    requestedIntent: PendingSessionIntent,
  ) => {
    const intent = pendingSessionIntent ?? requestedIntent
    const slot = sessionOperationSlot(intent)
    if (!session && !operations.hasPending(slot)) {
      setPendingSessionIntent(null)
      setError('The original session is no longer available to retry.')
      return
    }
    setPendingSessionIntent(intent)
    setBusySessionId(intent.sessionId)
    setError(null)
    try {
      await operations.run(slot, (clientOperationId) => {
        if (!session || session.id !== intent.sessionId) {
          return async () => {
            throw new Error('The original session is unavailable. Refresh its status before retrying.')
          }
        }
        if (intent.command === 'prepare') return () => prepare({
          eventSlug,
          sessionId: session.id,
          expectedSessionVersion: session.version,
          clientOperationId,
        })
        if (intent.command === 'open') return () => open({
          eventSlug,
          sessionId: session.id,
          expectedSessionVersion: session.version,
          clientOperationId,
        })
        if (intent.command === 'extend') return () => extend({
          eventSlug,
          sessionId: session.id,
          expectedSessionVersion: session.version,
          extensionMinutes: Number(extensionMinutes),
          reason: sessionReason,
          clientOperationId,
        })
        if (intent.command === 'close') return () => close({
          eventSlug,
          sessionId: session.id,
          expectedSessionVersion: session.version,
          reason: sessionReason,
          clientOperationId,
        })
        return () => cancel({
          eventSlug,
          sessionId: session.id,
          expectedSessionVersion: session.version,
          reason: sessionReason,
          clientOperationId,
        })
      })
      setPendingSessionIntent(null)
      if (intent.command === 'extend' || intent.command === 'close' || intent.command === 'cancel') {
        resetSessionAction()
      }
    } catch (caught) {
      if (!operations.hasPending(slot)) setPendingSessionIntent(null)
      setError(readableError(caught))
    } finally {
      setBusySessionId(null)
    }
  }

  const beginSessionAction = (
    session: AttendanceSessionData,
    command: SessionAction['command'],
  ) => {
    setSessionAction({ sessionId: session.id, command })
    setSessionReason(
      command === 'close' && Date.now() >= session.endsAt ? 'Session ended as scheduled' : '',
    )
    setExtensionMinutes('30')
  }

  const resetSessionAction = () => {
    setSessionAction(null)
    setSessionReason('')
    setExtensionMinutes('30')
  }

  const beginStationAction = (
    station: AttendanceStationData,
    command: StationAction['command'],
  ) => {
    setStationAction({ stationId: station.id, command })
    setStationReason(
      command === 'enable' ? 'Scanner station checked and ready for reassignment' : '',
    )
  }

  const runStationAction = async (station: AttendanceStationData) => {
    if (!stationAction || stationAction.stationId !== station.id) return
    await runStationCommand(station, stationAction)
  }

  const runStationCommand = async (
    station: AttendanceStationData | undefined,
    requestedIntent: StationAction,
  ) => {
    const intent = pendingStationIntent ?? requestedIntent
    const slot = stationOperationSlot(intent)
    if (!station && !operations.hasPending(slot)) {
      setPendingStationIntent(null)
      setError('The original scanner station is no longer available to retry.')
      return
    }
    setPendingStationIntent(intent)
    setBusyStationId(intent.stationId)
    setError(null)
    try {
      await operations.run(slot, (clientOperationId) => async () => {
        if (!station || station.id !== intent.stationId) {
          throw new Error('The original scanner station is unavailable. Refresh its status before retrying.')
        }
        const input = {
          eventSlug,
          stationId: station.id,
          expectedConfigurationVersion: station.configurationVersion,
          reason: stationReason,
          clientOperationId,
        }
        if (intent.command === 'disable') await disableStation(input)
        else await enableStation(input)
      })
      setPendingStationIntent(null)
      setStationAction(null)
      setStationReason('')
    } catch (caught) {
      if (!operations.hasPending(slot)) setPendingStationIntent(null)
      setError(readableError(caught))
    } finally {
      setBusyStationId(null)
    }
  }

  return (
    <section className="attendance-shell">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Event day</p>
          <h1>Check-in</h1>
          <p className="muted">Hacking-session presence, temporary exits, and scanner readiness.</p>
        </div>
        {overview.publishedPlan ? (
          <div className="plan-meta">
            <span>{overview.publishedPlan.name}</span>
            {overview.canConfigure || overview.canPublish ? (
              <Link
                aria-disabled={operationPending}
                onClick={(event) => {
                  if (operationPending) event.preventDefault()
                }}
                to="/attendance-setup"
              >
                Edit plan
              </Link>
            ) : null}
          </div>
        ) : overview.canConfigure || overview.canPublish ? (
          <Link
            aria-disabled={operationPending}
            className="secondary compact-link"
            onClick={(event) => {
              if (operationPending) event.preventDefault()
            }}
            to="/attendance-setup"
          >
            Set up attendance
          </Link>
        ) : null}
      </header>

      {!overview.publishedPlan ? (
        <div className="empty-state">
          <h2>No published attendance plan</h2>
          <p className="muted">
            {overview.canConfigure
              ? 'Create and rehearse a plan before opening participant check-in.'
              : 'No attendance plan is visible to this permission scope.'}
          </p>
        </div>
      ) : null}

      {overview.publishedPlan ? (
        <p className="plan-note">
          VIT ID formats: {overview.publishedPlan.barcodeSymbologies.length > 0
            ? overview.publishedPlan.barcodeSymbologies.map(symbologyName).join(', ')
            : 'not enabled'}
        </p>
      ) : null}

      {overview.venueCheckIns ? (
        <section className="session-card" aria-labelledby="venue-arrival-heading">
          <div className="session-heading">
            <div>
              <h2 id="venue-arrival-heading">Venue arrival</h2>
              <p className="muted">
                Staffed identity check-in. Presence and hacking-session confirmation remain separate.
              </p>
            </div>
          </div>
          <dl className="attendance-counts">
            <Count label="Checked in" value={overview.venueCheckIns.checkedIn} />
          </dl>
          {overview.venueCheckIns.updatedAt ? (
            <small>
              Last change {new Date(overview.venueCheckIns.updatedAt).toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </small>
          ) : null}
        </section>
      ) : null}

      {overview.stations.length > 0 ? (
        <details className="scanner-stations" open={activeStationCount > 0 || undefined}>
          <summary>
            <strong>Scanner phones</strong>
            <span>{activeStationCount} ready · {waitingStationCount} need a phone</span>
          </summary>
          <p className="muted">
            {waitingStationCount > 0
              ? 'On each event phone, open Scanner and choose one of the waiting stations.'
              : 'See each assigned phone, its last check-in, and any unsent scans.'}
          </p>
          <ul className="station-list">
            {overview.stations.map((station) => {
              const action = stationAction?.stationId === station.id ? stationAction : null
              const busy = busyStationId === station.id
              return (
                <li key={station.id}>
                  <div className="station-heading">
                    <span>{station.name}</span>
                    <small>{stationStatusName(station.status)}</small>
                  </div>
                  <small>{station.zoneName}</small>
                  <small>{stationDeviceSummary(station)}</small>
                  {station.canManage && !action && station.status === 'active' ? (
                    <button
                      className="text-button"
                      type="button"
                      disabled={stationAction !== null || pendingStationIntent !== null}
                      onClick={() => beginStationAction(station, 'disable')}
                    >
                      Disable scanner
                    </button>
                  ) : null}
                  {station.canManage && !action && station.status === 'disabled' ? (
                    <button
                      className="text-button"
                      type="button"
                      disabled={stationAction !== null || pendingStationIntent !== null}
                      onClick={() => beginStationAction(station, 'enable')}
                    >
                      Make available
                    </button>
                  ) : null}
                  {action ? (
                    <div className="station-command">
                      <label className="field">
                        <span>Reason</span>
                        <textarea
                          disabled={stationCommandPending}
                          value={stationReason}
                          onChange={(event) => setStationReason(event.target.value)}
                        />
                      </label>
                      <p className="muted">
                        {action.command === 'disable'
                          ? 'This immediately revokes the phone and its scanner grants.'
                          : 'A checked phone can be assigned after this station becomes available.'}
                      </p>
                      <div className="button-row">
                        <button
                          className="primary"
                          type="button"
                          disabled={busy || (!stationCommandPending && stationReason.trim().length < 5)}
                          onClick={() => void runStationAction(station)}
                        >
                          {busy
                            ? 'Saving…'
                            : stationCommandPending
                              ? `Retry ${action.command === 'disable' ? 'disable' : 'make available'}`
                            : action.command === 'disable'
                              ? 'Confirm disable'
                              : 'Confirm available'}
                        </button>
                        <button
                          className="secondary"
                          type="button"
                          disabled={busy || stationCommandPending}
                          onClick={() => {
                            setStationAction(null)
                            setStationReason('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </details>
      ) : null}

      {pendingStationIntent && !overview.stations.some(
        (station) => station.id === pendingStationIntent.stationId,
      ) ? (
        <div className="notice" role="status">
          <p>The scanner command has an unknown outcome and its station is no longer visible.</p>
          <button
            className="secondary"
            type="button"
            disabled={busyStationId !== null}
            onClick={() => void runStationCommand(undefined, pendingStationIntent)}
          >
            {busyStationId !== null ? 'Retrying…' : `Retry ${stationCommandName(pendingStationIntent.command)}`}
          </button>
        </div>
      ) : null}

      <div className="session-list">
        {overview.sessions.map((session) => {
          const busy = busySessionId === session.id
          const action = sessionAction?.sessionId === session.id ? sessionAction : null
          const now = Date.now()
          const canOpen = now >= session.checkInOpensAt && now <= session.checkInClosesAt
          const extension = Number(extensionMinutes)
          const extensionValid = Number.isInteger(extension) && extension >= 1 && extension <= 1_440
          const canCancel =
            session.status === 'scheduled' ||
            session.status === 'preparing' ||
            session.status === 'ready' ||
            session.status === 'open'
          return (
            <article className="session-card" key={session.id}>
              <div className="session-heading">
                <div>
                  <div className="session-title-line">
                    <h2>{session.name}</h2>
                    <span className="state-label">{sessionStatusName(session)}</span>
                  </div>
                  <p className="muted">
                    {session.zoneName} · {formatWindow(session.startsAt, session.endsAt, overview.timezone)}
                  </p>
                </div>
                <Link
                  aria-disabled={operationPending}
                  className="secondary compact-link"
                  onClick={(event) => {
                    if (operationPending) event.preventDefault()
                  }}
                  to={`/attendance/${session.id}`}
                >
                  View people
                </Link>
              </div>

              {session.expectationBuildState === 'complete' ? (
                <dl className="attendance-counts">
                  <Count label="Expected" value={session.counters.expected} />
                  <Count label="Present" value={session.counters.present} />
                  <Count label="Temporarily out" value={session.counters.temporarilyOut} />
                  <Count label="Waiting" value={session.counters.confirmationDue} />
                  <Count label="Needs review" value={session.counters.needsReview} />
                  <Count label="Complete" value={session.counters.complete} />
                </dl>
              ) : (
                <dl className="attendance-counts">
                  <Count
                    label="Expected participants"
                    value={session.expectationBuildState === 'not_started' ? 'Not prepared' : 'Preparing'}
                  />
                </dl>
              )}

              {session.job && session.job.status !== 'complete' ? (
                <p className={session.job.status === 'failed' ? 'notice error' : 'notice'}>
                  {session.job.status === 'failed'
                    ? `Background work failed: ${session.job.failureCode ?? 'unknown reason'}.`
                    : `${jobName(session.job.kind)} · ${session.job.scannedCount} checked`}
                </p>
              ) : null}

              {session.canManage ? (
                <div className="session-actions">
                  {!action && session.status === 'scheduled' && session.expectationBuildState === 'not_started' ? (
                    <button
                      className="primary"
                      type="button"
                      disabled={busy || sessionAction !== null || pendingSessionIntent !== null}
                      onClick={() => void runSessionCommand(session, { sessionId: session.id, command: 'prepare' })}
                    >
                      {busy ? 'Preparing…' : 'Prepare session'}
                    </button>
                  ) : null}
                  {!action && session.status === 'ready' ? (
                    <button
                      className="primary"
                      type="button"
                      disabled={busy || !canOpen || sessionAction !== null || pendingSessionIntent !== null}
                      onClick={() => void runSessionCommand(session, { sessionId: session.id, command: 'open' })}
                    >
                      {busy ? 'Opening…' : canOpen ? 'Open check-in' : now < session.checkInOpensAt ? 'Check-in not open yet' : 'Check-in window ended'}
                    </button>
                  ) : null}
                  {!action && session.status === 'open' ? (
                    <button
                      className="secondary"
                      type="button"
                      disabled={sessionAction !== null || pendingSessionIntent !== null}
                      onClick={() => beginSessionAction(session, 'extend')}
                    >
                      Extend
                    </button>
                  ) : null}
                  {!action && session.status === 'open' ? (
                    <button
                      className="secondary"
                      type="button"
                      disabled={sessionAction !== null || pendingSessionIntent !== null}
                      onClick={() => beginSessionAction(session, 'close')}
                    >
                      Close session
                    </button>
                  ) : null}
                  {!action && canCancel ? (
                    <button
                      className="text-button"
                      type="button"
                      disabled={sessionAction !== null || pendingSessionIntent !== null}
                      onClick={() => beginSessionAction(session, 'cancel')}
                    >
                      Cancel session
                    </button>
                  ) : null}
                </div>
              ) : null}

              {pendingSessionIntent?.sessionId === session.id && !action ? (
                <div className="notice" role="status">
                  <p>The {sessionCommandName(pendingSessionIntent.command)} command has an unknown outcome.</p>
                  <button
                    className="secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => void runSessionCommand(session, pendingSessionIntent)}
                  >
                    {busy ? 'Retrying…' : `Retry ${sessionCommandName(pendingSessionIntent.command)}`}
                  </button>
                </div>
              ) : null}

              {action ? (
                <div className="close-confirmation">
                  {action.command === 'extend' ? (
                    <label className="field">
                      <span>Extra minutes</span>
                      <input
                        type="number"
                        min="1"
                        max="1440"
                        step="1"
                        disabled={sessionCommandPending}
                        value={extensionMinutes}
                        onChange={(event) => setExtensionMinutes(event.target.value)}
                      />
                    </label>
                  ) : null}
                  <label className="field">
                    <span>Reason</span>
                    <textarea
                      disabled={sessionCommandPending}
                      value={sessionReason}
                      onChange={(event) => setSessionReason(event.target.value)}
                      placeholder={sessionActionPlaceholder(action.command)}
                    />
                  </label>
                  <p className="muted">{sessionActionDescription(action.command)}</p>
                  <div className="button-row">
                    <button
                      className="primary"
                      type="button"
                      disabled={
                        busy ||
                        (!sessionCommandPending && sessionReason.trim().length < 5) ||
                        (!sessionCommandPending && action.command === 'extend' && !extensionValid)
                      }
                      onClick={() => void runSessionCommand(session, action)}
                    >
                      {busy
                        ? 'Saving…'
                        : sessionCommandPending
                          ? `Retry ${sessionCommandName(action.command)}`
                          : sessionActionLabel(action.command)}
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy || sessionCommandPending}
                      onClick={resetSessionAction}
                    >
                      Back
                    </button>
                  </div>
                </div>
              ) : null}
            </article>
          )
        })}
      </div>
      {pendingSessionIntent && !overview.sessions.some(
        (session) => session.id === pendingSessionIntent.sessionId,
      ) ? (
        <div className="notice" role="status">
          <p>The session command has an unknown outcome and its session is no longer visible.</p>
          <button
            className="secondary"
            type="button"
            disabled={busySessionId !== null}
            onClick={() => void runSessionCommand(undefined, pendingSessionIntent)}
          >
            {busySessionId !== null ? 'Retrying…' : `Retry ${sessionCommandName(pendingSessionIntent.command)}`}
          </button>
        </div>
      ) : null}
      {overview.publishedPlan && overview.sessions.length === 0 ? (
        <p className="empty">No sessions are visible to your permission scope.</p>
      ) : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function Count({ label, value }: { label: string; value: number | string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function formatWindow(startsAt: number, endsAt: number, timezone: string) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${formatter.format(startsAt)} – ${formatter.format(endsAt)}`
}

function statusName(value: string) {
  const label = value.replaceAll('_', ' ')
  return `${label.slice(0, 1).toUpperCase()}${label.slice(1)}`
}

function sessionStatusName(session: AttendanceSessionData) {
  if (session.status === 'closing' && session.job?.kind === 'cancel_results') return 'Cancelling'
  return statusName(session.status)
}

function sessionActionPlaceholder(command: SessionAction['command']) {
  if (command === 'extend') return 'Why does this session need more time?'
  if (command === 'cancel') return 'Why is this session being cancelled?'
  return 'Why is this session closing now?'
}

function sessionActionDescription(command: SessionAction['command']) {
  if (command === 'extend') {
    return 'The accepted end and late-arrival close move together. Existing scans do not change.'
  }
  if (command === 'cancel') {
    return 'New scans stop at one server cutoff. Existing scans remain, and nobody is marked absent.'
  }
  return 'New scans stop at the accepted end or now, whichever came first. Results then finalise in batches.'
}

function sessionActionLabel(command: SessionAction['command']) {
  if (command === 'extend') return 'Confirm extension'
  if (command === 'cancel') return 'Confirm cancellation'
  return 'Confirm close'
}

function sessionOperationSlot(intent: PendingSessionIntent) {
  return `attendance-session-${intent.command}:${intent.sessionId}`
}

function stationOperationSlot(intent: StationAction) {
  return `attendance-station-${intent.command}:${intent.stationId}`
}

function sessionCommandName(command: SessionCommand) {
  if (command === 'prepare') return 'prepare session'
  if (command === 'open') return 'open check-in'
  if (command === 'extend') return 'extend session'
  if (command === 'cancel') return 'cancel session'
  return 'close session'
}

function stationCommandName(command: StationAction['command']) {
  return command === 'disable' ? 'disable scanner' : 'make scanner available'
}

function symbologyName(value: string) {
  if (value === 'code128') return 'Code 128'
  if (value === 'code39') return 'Code 39'
  if (value === 'code93') return 'Code 93'
  if (value === 'ean13') return 'EAN-13'
  if (value === 'ean8') return 'EAN-8'
  if (value === 'itf14') return 'ITF-14'
  if (value === 'pdf417') return 'PDF417'
  if (value === 'upc_a') return 'UPC-A'
  if (value === 'upc_e') return 'UPC-E'
  if (value === 'datamatrix') return 'Data Matrix'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function jobName(value: string) {
  if (value === 'build_expectations') return 'Preparing expected participants'
  if (value === 'cancel_results') return 'Cancelling session'
  return 'Finalising results'
}

function stationStatusName(value: string) {
  if (value === 'active') return 'Active'
  if (value === 'disabled') return 'Disabled'
  return 'Waiting for phone'
}

function stationDeviceSummary(station: AttendanceStationData) {
  if (!station.device) {
    return station.status === 'disabled' ? 'No phone assigned' : 'Waiting for a phone to be assigned'
  }
  const platform = station.device.platform === 'ios' ? 'iPhone' : 'Android'
  const lastSeen = station.device.lastSeenAt
    ? `last seen ${new Date(station.device.lastSeenAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'waiting for first heartbeat'
  const pending = station.device.pendingReplayCount > 0
    ? ` · ${station.device.pendingReplayCount} pending${station.device.oldestPendingCapturedAt ? ` since ${new Date(station.device.oldestPendingCapturedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`
    : ''
  return `${station.device.name} · ${platform} · ${lastSeen}${pending}`
}
