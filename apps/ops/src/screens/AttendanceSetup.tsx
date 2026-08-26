import { api } from '@code2create/backend/api'
import {
  barcodeSymbologies,
  findBarcodeSymbology,
  type BarcodeSymbology,
} from '@code2create/domain'
import { TZDateMini } from '@date-fns/tz'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type FormEvent } from 'react'

import { ConfigurationEditorDisclosure } from '../components/ConfigurationEditorDisclosure'
import { ConfigurationTabs, type ConfigurationTabsVisibility } from '../components/ConfigurationTabs'
import { PendingOperationRecovery } from '../components/PendingOperationRecovery'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useMutationAttempt } from '../lib/operations'

type DraftSession = {
  id: string
  stableKey: string
  name: string
  kind: SessionInput['kind']
  requirement: SessionInput['requirement']
  expectedCohort: SessionInput['expectedCohort']
  zoneKey: string
  startsAt: string
  endsAt: string
  checkInOpensAt: string
  checkInClosesAt: string
  awayAlertMinutes: string
}

type StationMode = StationInput['mode']
type CredentialKind = StationInput['allowedCredentialKinds'][number]

type DraftStation = {
  stableKey: string
  name: string
  zoneKey: string
  mode: StationMode | ''
  sessionKey: string
  allowedCredentialKinds: CredentialKind[]
}

type DraftZone = {
  stableKey: string
  name: string
  safeCapacity: string
}

type CreateDraftArgs = FunctionArgs<typeof api.attendanceConfiguration.createDraft>
type SessionInput = CreateDraftArgs['sessions'][number]
type StationInput = CreateDraftArgs['stations'][number]
type ZoneInput = CreateDraftArgs['zones'][number]
type PendingAttendanceOperation = {
  kind: 'draft' | 'publish'
  title: string
  action: string
}

const sessionKinds: readonly { value: SessionInput['kind']; label: string }[] = [
  { value: 'hacking', label: 'Hacking session' },
  { value: 'overnight_access', label: 'Overnight access' },
  { value: 'review_preparation', label: 'Final handoff or judging preparation' },
  { value: 'briefing', label: 'Briefing' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'other', label: 'Other' },
]

const requirements: readonly { value: SessionInput['requirement']; label: string }[] = [
  { value: 'required', label: 'Required' },
  { value: 'optional', label: 'Optional' },
  { value: 'information_only', label: 'Information only' },
]

const stationModes: readonly { value: StationMode; label: string }[] = [
  { value: 'venue_entry', label: 'Venue entry' },
  { value: 'venue_exit', label: 'Venue exit' },
  { value: 'session_confirm', label: 'Session attendance' },
  { value: 'zone_entry', label: 'Session area entry' },
  { value: 'zone_exit', label: 'Session area exit' },
  { value: 'roving', label: 'Roving scanner' },
]

const credentialKinds: readonly { value: CredentialKind; label: string }[] = [
  { value: 'vit_id_barcode', label: 'VIT ID barcode' },
  { value: 'badge_qr', label: 'Event badge QR' },
  { value: 'portal_qr', label: 'Participant portal QR' },
]

const barcodeSymbologyLabels: Record<BarcodeSymbology, string> = {
  aztec: 'Aztec',
  ean13: 'EAN-13',
  ean8: 'EAN-8',
  qr: 'QR',
  pdf417: 'PDF417',
  upc_e: 'UPC-E',
  datamatrix: 'Data Matrix',
  code39: 'Code 39',
  code93: 'Code 93',
  itf14: 'ITF-14',
  codabar: 'Codabar',
  code128: 'Code 128',
  upc_a: 'UPC-A',
}

export function AttendanceSetup({ tabs }: { tabs: ConfigurationTabsVisibility }) {
  const publicState = useQuery(api.system.getPublicShellState, { eventSlug })
  const configuration = useQuery(api.attendanceConfiguration.current, { eventSlug })
  const createDraft = useMutation(api.attendanceConfiguration.createDraft)
  const publish = useMutation(api.attendanceConfiguration.publish)
  const [planName, setPlanName] = useState('Code2Create hacking sessions')
  const [zones, setZones] = useState<DraftZone[]>(() => [newZone('Main hack hall', 'main_hack_hall')])
  const [barcodeSymbology, setBarcodeSymbology] = useState<BarcodeSymbology | ''>('')
  const [offlineQueueMaxScans, setOfflineQueueMaxScans] = useState('8')
  const [offlineQueueMaxAgeSeconds, setOfflineQueueMaxAgeSeconds] = useState('180')
  const [sessions, setSessions] = useState<DraftSession[]>(() => [newSession('main_hack_hall')])
  const [stations, setStations] = useState<DraftStation[]>(() => [
    newStation('main_hack_hall', 'Main hall entrance'),
  ])
  const [loadedSource, setLoadedSource] = useState('')
  const [draftReason, setDraftReason] = useState('Prepared for event-day attendance rehearsal')
  const [publishReason, setPublishReason] = useState('Published after attendance rehearsal')
  const [publishArmed, setPublishArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draftAttempt = useMutationAttempt<FunctionReturnType<typeof api.attendanceConfiguration.createDraft>>()
  const publishAttempt = useMutationAttempt<FunctionReturnType<typeof api.attendanceConfiguration.publish>>()
  const draftPending = draftAttempt.hasPending('attendance-plan-draft')
  const publishPending = publishAttempt.hasPending('attendance-plan-publish')
  const pendingOperation: PendingAttendanceOperation | null = publishPending
    ? {
        kind: 'publish',
        title: 'Finish publishing the check-in plan',
        action: 'Confirm earlier publication',
      }
    : draftPending
      ? {
          kind: 'draft',
          title: 'Finish saving the check-in plan draft',
          action: 'Confirm earlier save',
        }
      : null
  const operationPending = pendingOperation !== null

  useEffect(() => {
    const source = configuration?.editorSource
    const timezone = publicState?.event?.timezone
    if (!source || !timezone) return
    const sourceKey = `${source.planVersionId}:${source.version}`
    if (sourceKey === loadedSource) return
    setPlanName(source.name)
    setZones(source.zones.map((zone) => ({
      stableKey: zone.stableKey,
      name: zone.name,
      safeCapacity: zone.safeCapacity === undefined ? '' : `${zone.safeCapacity}`,
    })))
    setBarcodeSymbology(source.vitBarcodeSymbologies[0] ?? '')
    setOfflineQueueMaxScans(`${source.offlineQueueMaxScans}`)
    setOfflineQueueMaxAgeSeconds(`${source.offlineQueueMaxAgeSeconds}`)
    setSessions(source.sessions.map((session) => ({
      id: session.stableKey,
      stableKey: session.stableKey,
      name: session.name,
      kind: session.kind,
      requirement: session.requirement,
      expectedCohort: session.expectedCohort,
      zoneKey: session.zoneKey,
      startsAt: localDateTimeValue(session.startsAt, timezone),
      endsAt: localDateTimeValue(session.endsAt, timezone),
      checkInOpensAt: localDateTimeValue(session.checkInOpensAt, timezone),
      checkInClosesAt: localDateTimeValue(session.checkInClosesAt, timezone),
      awayAlertMinutes: session.awayAlertAfterMinutes === undefined ? '' : `${session.awayAlertAfterMinutes}`,
    })))
    setStations(source.stations.map((station) => ({
      stableKey: station.stableKey,
      name: station.name,
      zoneKey: station.zoneKey,
      mode: station.mode ?? '',
      sessionKey: station.sessionKey ?? '',
      allowedCredentialKinds: [...(station.allowedCredentialKinds ?? [])],
    })))
    setLoadedSource(sourceKey)
    setPublishArmed(false)
  }, [configuration, loadedSource, publicState])

  if (publicState === undefined || configuration === undefined) {
    return <p className="muted">Loading attendance setup…</p>
  }
  const timezone = publicState.event?.timezone
  if (!timezone) return <p className="notice error">The event timezone is not configured.</p>
  const stationConfigurationRequired = configuration.editorSource?.stations.some(
    (station) => station.mode === undefined || station.allowedCredentialKinds === undefined,
  ) ?? false

  const updateSession = (id: string, patch: Partial<DraftSession>) => {
    setSessions((current) => current.map((session) => session.id === id ? { ...session, ...patch } : session))
  }

  const removeZone = (stableKey: string) => {
    const remaining = zones.filter((zone) => zone.stableKey !== stableKey)
    const replacement = remaining[0]
    if (!replacement) return
    setZones(remaining)
    setSessions((current) => current.map((session) => (
      session.zoneKey === stableKey ? { ...session, zoneKey: replacement.stableKey } : session
    )))
    setStations((current) => current.map((station) => (
      station.zoneKey === stableKey
        ? { ...station, zoneKey: replacement.stableKey, sessionKey: '' }
        : station
    )))
  }

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || operationPending) return
    setBusy(true)
    setError(null)
    try {
      await draftAttempt.run('attendance-plan-draft', () => {
      if (!barcodeSymbology) {
        throw new Error('Select the barcode format confirmed during a real VIT ID rehearsal.')
      }
      const zoneInputs: ZoneInput[] = zones.map((zone, index) => {
        const capacity = positiveInteger(zone.safeCapacity, `Zone ${index + 1} safe capacity`)
        return {
          stableKey: zone.stableKey,
          name: zone.name,
          ...(capacity !== undefined ? { safeCapacity: capacity } : {}),
        }
      })
      const zoneKeys = new Set(zoneInputs.map((zone) => zone.stableKey))
      const sessionInputs: SessionInput[] = sessions.map((session, index) => {
        const startsAt = zonedTimestamp(session.startsAt, timezone, 'Session start')
        const endsAt = zonedTimestamp(session.endsAt, timezone, 'Session end')
        if (endsAt <= startsAt) throw new Error(`${session.name || `Session ${index + 1}`} must end after it starts.`)
        const awayAlertAfterMinutes = positiveInteger(session.awayAlertMinutes, 'Away alert')
        const checkInOpensAt = zonedTimestamp(session.checkInOpensAt, timezone, 'Check-in start')
        const checkInClosesAt = zonedTimestamp(session.checkInClosesAt, timezone, 'Check-in close')
        if (checkInOpensAt > startsAt || checkInClosesAt < startsAt || checkInClosesAt > endsAt) {
          throw new Error(`${session.name || `Session ${index + 1}`} needs a check-in window that opens by the start and closes during the session.`)
        }
        if (!zoneKeys.has(session.zoneKey)) {
          throw new Error(`${session.name || `Session ${index + 1}`} needs an available event area.`)
        }
        return {
          stableKey: session.stableKey,
          name: session.name,
          kind: session.kind,
          requirement: session.requirement,
          expectedCohort: session.expectedCohort,
          zoneKey: session.zoneKey,
          startsAt,
          endsAt,
          checkInOpensAt,
          checkInClosesAt,
          ...(awayAlertAfterMinutes !== undefined ? { awayAlertAfterMinutes } : {}),
        }
      })
      const sessionByKey = new Map(sessionInputs.map((session) => [session.stableKey, session]))
      const stationInputs: StationInput[] = stations.map((station, index) => {
        if (!zoneKeys.has(station.zoneKey)) {
          throw new Error(`${station.name || `Station ${index + 1}`} needs an available event area.`)
        }
        if (station.allowedCredentialKinds.length === 0) {
          throw new Error(`${station.name || `Station ${index + 1}`} needs at least one credential method.`)
        }
        const mode = station.mode
        if (!mode) {
          throw new Error(`${station.name || `Station ${index + 1}`} needs an explicit scanner action.`)
        }
        const needsSession = mode === 'session_confirm' ||
          mode === 'zone_entry' ||
          mode === 'zone_exit'
        const session = station.sessionKey ? sessionByKey.get(station.sessionKey) : undefined
        if (needsSession && !session) {
          throw new Error(`${station.name || `Station ${index + 1}`} needs a session.`)
        }
        if (session && session.zoneKey !== station.zoneKey) {
          throw new Error(`${station.name || `Station ${index + 1}`} must use a session in its event area.`)
        }
        return {
          stableKey: station.stableKey,
          name: station.name,
          zoneKey: station.zoneKey,
          mode,
          ...(session ? { sessionKey: session.stableKey } : {}),
          allowedCredentialKinds: station.allowedCredentialKinds,
        }
      })
      const pendingScanLimit = requiredPositiveInteger(offlineQueueMaxScans, 'Offline queue size')
      const pendingScanAgeSeconds = requiredPositiveInteger(offlineQueueMaxAgeSeconds, 'Offline queue age')
      if (pendingScanLimit > 25) throw new Error('Keep the offline queue at 25 scans or fewer per phone.')
      if (pendingScanAgeSeconds < 30 || pendingScanAgeSeconds > 600) {
        throw new Error('Keep offline scans for 30 to 600 seconds.')
      }
      const draftArgs = {
        eventSlug,
        name: planName,
        vitBarcodeSymbologies: [barcodeSymbology],
        vitBarcodeNormalizationVersion: 'trim-v1',
        offlineQueueMaxScans: pendingScanLimit,
        offlineQueueMaxAgeSeconds: pendingScanAgeSeconds,
        zones: zoneInputs,
        sessions: sessionInputs,
        stations: stationInputs,
        expectedEventVersion: configuration.eventVersion,
        reason: draftReason,
        clientOperationId: crypto.randomUUID(),
      }
      return () => createDraft(draftArgs)
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const publishDraft = async () => {
    if (busy || operationPending || !configuration.draftPlan) return
    const draftPlan = configuration.draftPlan
    setBusy(true)
    setError(null)
    try {
      await publishAttempt.run('attendance-plan-publish', () => {
        const publishArgs = {
          eventSlug,
          planVersionId: draftPlan.id,
          expectedEventVersion: configuration.eventVersion,
          reason: publishReason,
          clientOperationId: crypto.randomUUID(),
        }
        return () => publish(publishArgs)
      })
      setPublishArmed(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const confirmPendingOperation = async () => {
    if (busy || pendingOperation === null) return
    setBusy(true)
    setError(null)
    try {
      if (pendingOperation.kind === 'publish') {
        await publishAttempt.retryPending('attendance-plan-publish')
        setPublishArmed(false)
      } else {
        await draftAttempt.retryPending('attendance-plan-draft')
      }
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="attendance-shell setup-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading">
        <div>
          <h1>Check-in plan</h1>
          <p className="muted">Times are entered in {timezone}. Assign each scanner phone to the hacking sessions it will cover.</p>
        </div>
      </header>

      {configuration.publishedPlan ? (
        <p className="notice">Current plan: {configuration.publishedPlan.name}</p>
      ) : null}

      {stationConfigurationRequired ? (
        <p className="notice error" role="alert">
          This plan predates explicit scanner actions. Choose an action and credential methods for every station, save a replacement draft, and publish it before assigning phones.
        </p>
      ) : null}

      {pendingOperation ? (
        <PendingOperationRecovery
          action={pendingOperation.action}
          busy={busy}
          onConfirm={() => void confirmPendingOperation()}
          title={pendingOperation.title}
        />
      ) : null}

      {!operationPending && configuration.draftPlan ? (
        <section className="draft-summary">
          <div>
            <p className="eyebrow">Current draft</p>
            <h2>{configuration.draftPlan.name}</h2>
            <p className="muted">
              {configuration.draftPlan.sessionCount} sessions · {configuration.draftPlan.stationCount} phone stations
            </p>
          </div>
          {configuration.canPublish && !publishArmed ? (
            <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>Review publication</button>
          ) : null}
        </section>
      ) : null}

      {!operationPending && configuration.draftPlan && configuration.canPublish && publishArmed ? (
        <section className="publish-confirmation">
          <h2>Publish this plan?</h2>
          <p className="muted">
            Publishing makes these sessions and phone stations authoritative. If a plan is already live, its phone assignments are disabled and must be provisioned again. A preparing or open session must finish first.
          </p>
          <label className="field">
            <span>Why this changed</span>
            <textarea disabled={publishPending} value={publishReason} onChange={(event) => setPublishReason(event.target.value)} />
          </label>
          <div className="button-row">
            <button className="primary" type="button" disabled={busy || publishReason.trim().length < 5} onClick={() => void publishDraft()}>
              {busy ? 'Publishing…' : publishPending ? 'Confirm earlier publication' : 'Publish plan'}
            </button>
            <button className="secondary" type="button" disabled={busy || publishPending} onClick={() => setPublishArmed(false)}>Cancel</button>
          </div>
        </section>
      ) : null}

      {!operationPending && configuration.canConfigure ? (
        <ConfigurationEditorDisclosure
          defaultOpen={Boolean(configuration.draftPlan)}
          description="Hacking sessions, phone scanner stations, barcode credentials, and offline replay limits."
          title={configuration.draftPlan ? 'Continue check-in-plan draft' : 'Edit check-in plan'}
        >
          <form className="setup-form" onSubmit={saveDraft}>
          <fieldset disabled={draftPending} style={{ display: 'contents' }}>
          <section className="setup-section">
            <h2>Plan</h2>
            <div className="form-grid">
              <Field label="Plan name">
                <input required value={planName} onChange={(event) => setPlanName(event.target.value)} />
              </Field>
              <Field label="Tested VIT ID barcode format">
                <select
                  required
                  value={barcodeSymbology}
                  onChange={(event) => setBarcodeSymbology(findBarcodeSymbology(event.target.value) ?? '')}
                >
                  <option value="">Choose after card rehearsal</option>
                  {barcodeSymbologies.map((symbology) => (
                    <option key={symbology} value={symbology}>{barcodeName(symbology)}</option>
                  ))}
                </select>
              </Field>
              <Field label="Offline queue · scans" hint="1–25 per phone">
                <input
                  required
                  inputMode="numeric"
                  value={offlineQueueMaxScans}
                  onChange={(event) => setOfflineQueueMaxScans(event.target.value)}
                />
              </Field>
              <Field label="Offline queue · seconds" hint="30–600">
                <input
                  required
                  inputMode="numeric"
                  value={offlineQueueMaxAgeSeconds}
                  onChange={(event) => setOfflineQueueMaxAgeSeconds(event.target.value)}
                />
              </Field>
            </div>
            <p className="muted">During a short outage, each assigned phone keeps only this small encrypted queue. VIT IDs and event badges can replay; short-lived participant portal codes still need an online connection.</p>
          </section>

          <section className="setup-section">
            <div className="section-heading">
              <div>
                <h2>Event areas</h2>
                <p className="muted">Use the real hall or controlled area names that scanner staff will see. {zones.length} of {configuration.limits.maximumZones} areas.</p>
              </div>
              <button className="secondary" type="button" disabled={zones.length >= configuration.limits.maximumZones} onClick={() => setZones((current) => [...current, newZone(`Area ${current.length + 1}`)])}>Add area</button>
            </div>
            <div className="session-editor-list">
              {zones.map((zone, index) => (
                <article className="session-editor" key={zone.stableKey}>
                  <div className="session-editor-heading">
                    <span>Area {index + 1}</span>
                    {zones.length > 1 ? (
                      <button className="text-button" type="button" onClick={() => removeZone(zone.stableKey)}>Remove</button>
                    ) : null}
                  </div>
                  <div className="form-grid session-fields">
                    <Field label="Name">
                      <input required maxLength={80} value={zone.name} onChange={(event) => setZones((current) => current.map((item) => item.stableKey === zone.stableKey ? { ...item, name: event.target.value } : item))} />
                    </Field>
                    <Field label="Safe capacity" hint="Optional">
                      <input inputMode="numeric" value={zone.safeCapacity} onChange={(event) => setZones((current) => current.map((item) => item.stableKey === zone.stableKey ? { ...item, safeCapacity: event.target.value } : item))} />
                    </Field>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="setup-section">
            <div className="section-heading">
              <div>
                <h2>Scanner stations</h2>
                <p className="muted">Give each phone one explicit transition and only the credential methods tested at that station. {stations.length} of {configuration.limits.maximumStations} stations.</p>
              </div>
              <button
                className="secondary"
                type="button"
                disabled={stations.length >= configuration.limits.maximumStations}
                onClick={() => setStations((current) => [
                  ...current,
                  newStation(zones[0]?.stableKey ?? 'main_hack_hall', `Scanner ${current.length + 1}`),
                ])}
              >
                Add station
              </button>
            </div>
            <div className="session-editor-list">
              {stations.map((station, index) => {
                const matchingSessions = sessions.filter((session) => session.zoneKey === station.zoneKey)
                const needsSession = station.mode === 'session_confirm' || station.mode === 'zone_entry' || station.mode === 'zone_exit'
                const offersSession = needsSession || station.mode === 'roving'
                return (
                  <article className="session-editor" key={station.stableKey}>
                    <div className="session-editor-heading">
                      <span>Station {index + 1}</span>
                      {stations.length > 1 ? (
                        <button className="text-button" type="button" onClick={() => setStations((current) => current.filter((candidate) => candidate.stableKey !== station.stableKey))}>Remove</button>
                      ) : null}
                    </div>
                    <div className="form-grid session-fields">
                      <Field label="Name">
                        <input required maxLength={80} value={station.name} onChange={(event) => updateStation(station.stableKey, { name: event.target.value }, setStations)} />
                      </Field>
                      <Field label="Event area">
                        <select value={station.zoneKey} onChange={(event) => updateStation(station.stableKey, { zoneKey: event.target.value, sessionKey: '' }, setStations)}>
                          {zones.map((zone) => <option key={zone.stableKey} value={zone.stableKey}>{zone.name}</option>)}
                        </select>
                      </Field>
                      <Field label="Scanner action">
                        <select
                          required
                          value={station.mode}
                          onChange={(event) => {
                            const mode = stationMode(event.target.value)
                            const sessionScoped = mode === 'session_confirm' || mode === 'zone_entry' || mode === 'zone_exit' || mode === 'roving'
                            updateStation(station.stableKey, { mode, sessionKey: sessionScoped ? station.sessionKey : '' }, setStations)
                          }}
                        >
                          <option value="">Choose scanner action</option>
                          {stationModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                        </select>
                      </Field>
                      {offersSession ? (
                        <Field label="Session" {...(needsSession ? {} : { hint: 'Optional for session or area transitions' })}>
                          <select required={needsSession} value={station.sessionKey} onChange={(event) => updateStation(station.stableKey, { sessionKey: event.target.value }, setStations)}>
                            <option value="">Choose session</option>
                            {matchingSessions.map((session) => <option key={session.stableKey} value={session.stableKey}>{session.name || 'Unnamed session'}</option>)}
                          </select>
                        </Field>
                      ) : null}
                    </div>
                    <fieldset className="configuration-advanced">
                      <legend>Accepted credentials</legend>
                      <div className="button-row">
                        {credentialKinds.map((credential) => (
                          <label key={credential.value}>
                            <input
                              type="checkbox"
                              checked={station.allowedCredentialKinds.includes(credential.value)}
                              onChange={(event) => updateStation(station.stableKey, {
                                allowedCredentialKinds: event.target.checked
                                  ? [...station.allowedCredentialKinds, credential.value]
                                  : station.allowedCredentialKinds.filter((value) => value !== credential.value),
                              }, setStations)}
                            />
                            {credential.label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </article>
                )
              })}
            </div>
          </section>

          <section className="setup-section">
            <div className="section-heading">
              <div>
                <h2>Hacking sessions</h2>
                <p className="muted">Each session has its own check-in window. A participant can match at most {configuration.limits.maximumSimultaneousSessionsPerParticipant} simultaneous sessions. {sessions.length} of {configuration.limits.maximumSessions} sessions.</p>
              </div>
              <button className="secondary" type="button" disabled={sessions.length >= configuration.limits.maximumSessions} onClick={() => setSessions((current) => [...current, newSession(zones[0]?.stableKey ?? 'main_hack_hall')])}>Add session</button>
            </div>
            <div className="session-editor-list">
              {sessions.map((session, index) => (
                <article className="session-editor" key={session.id}>
                  <div className="session-editor-heading">
                    <span>Session {index + 1}</span>
                    {sessions.length > 1 ? (
                      <button className="text-button" type="button" onClick={() => setSessions((current) => current.filter((candidate) => candidate.id !== session.id))}>Remove</button>
                    ) : null}
                  </div>
                  <div className="form-grid session-fields">
                    <Field label="Name">
                      <input required maxLength={60} value={session.name} onChange={(event) => updateSession(session.id, { name: event.target.value })} />
                    </Field>
                    <Field label="Purpose">
                      <select value={session.kind} onChange={(event) => updateSession(session.id, { kind: sessionKind(event.target.value, session.kind) })}>
                        {sessionKinds.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
                      </select>
                    </Field>
                    <Field label="Attendance">
                      <select value={session.requirement} onChange={(event) => updateSession(session.id, { requirement: sessionRequirement(event.target.value, session.requirement) })}>
                        {requirements.map((requirement) => <option key={requirement.value} value={requirement.value}>{requirement.label}</option>)}
                      </select>
                    </Field>
                    {zones.length > 1 ? (
                      <Field label="Event area">
                        <select value={session.zoneKey} onChange={(event) => updateSession(session.id, { zoneKey: event.target.value })}>
                          {zones.map((zone) => <option key={zone.stableKey} value={zone.stableKey}>{zone.name}</option>)}
                        </select>
                      </Field>
                    ) : null}
                    <Field label={`Start · ${timezone}`}>
                      <input required type="datetime-local" value={session.startsAt} onChange={(event) => updateSession(session.id, { startsAt: event.target.value })} />
                    </Field>
                    <Field label={`End · ${timezone}`}>
                      <input required type="datetime-local" value={session.endsAt} onChange={(event) => updateSession(session.id, { endsAt: event.target.value })} />
                    </Field>
                    <Field label="Away alert · minutes" hint="Optional">
                      <input inputMode="numeric" value={session.awayAlertMinutes} onChange={(event) => updateSession(session.id, { awayAlertMinutes: event.target.value })} />
                    </Field>
                  </div>
                  <details className="configuration-advanced">
                    <summary>Check-in window</summary>
                    <div className="form-grid session-fields">
                      <Field label={`Opens · ${timezone}`}>
                        <input required type="datetime-local" value={session.checkInOpensAt} onChange={(event) => updateSession(session.id, { checkInOpensAt: event.target.value })} />
                      </Field>
                      <Field label={`Closes · ${timezone}`}>
                        <input required type="datetime-local" value={session.checkInClosesAt} onChange={(event) => updateSession(session.id, { checkInClosesAt: event.target.value })} />
                      </Field>
                    </div>
                  </details>
                </article>
              ))}
            </div>
          </section>

          </fieldset>
          <section className="configuration-save final-setup-section">
            <Field label="Why this changed">
              <textarea disabled={draftPending} required value={draftReason} onChange={(event) => setDraftReason(event.target.value)} />
            </Field>
            <button className="primary" type="submit" disabled={busy || sessions.length === 0 || stations.length === 0}>
              {busy ? 'Saving…' : draftPending ? 'Confirm earlier draft' : configuration.draftPlan ? 'Replace draft' : 'Create draft'}
            </button>
          </section>
          </form>
        </ConfigurationEditorDisclosure>
      ) : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}{hint ? <small>{hint}</small> : null}</span>
      {children}
    </label>
  )
}

function newZone(name: string, stableKey = `area_${crypto.randomUUID().replaceAll('-', '_')}`): DraftZone {
  return {
    stableKey,
    name,
    safeCapacity: '',
  }
}

function newStation(zoneKey: string, name: string): DraftStation {
  return {
    stableKey: `station_${crypto.randomUUID().replaceAll('-', '_')}`,
    name,
    zoneKey,
    mode: '',
    sessionKey: '',
    allowedCredentialKinds: [],
  }
}

function updateStation(
  stableKey: string,
  patch: Partial<DraftStation>,
  setStations: React.Dispatch<React.SetStateAction<DraftStation[]>>,
) {
  setStations((current) => current.map((station) => (
    station.stableKey === stableKey ? { ...station, ...patch } : station
  )))
}

function stationMode(value: string): StationMode | '' {
  return stationModes.find((mode) => mode.value === value)?.value ?? ''
}

function newSession(zoneKey: string): DraftSession {
  const stableKey = `session_${crypto.randomUUID().replaceAll('-', '_')}`
  return {
    id: stableKey,
    stableKey,
    name: '',
    kind: 'hacking',
    requirement: 'required',
    expectedCohort: { kind: 'all_admitted' },
    zoneKey,
    startsAt: '',
    endsAt: '',
    checkInOpensAt: '',
    checkInClosesAt: '',
    awayAlertMinutes: '20',
  }
}

function sessionKind(value: string, fallback: SessionInput['kind']): SessionInput['kind'] {
  return sessionKinds.find((kind) => kind.value === value)?.value ?? fallback
}

function sessionRequirement(
  value: string,
  fallback: SessionInput['requirement'],
): SessionInput['requirement'] {
  return requirements.find((requirement) => requirement.value === value)?.value ?? fallback
}

function localDateTimeValue(value: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value))
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  const hour = parts.find((part) => part.type === 'hour')?.value
  const minute = parts.find((part) => part.type === 'minute')?.value
  if (!year || !month || !day || !hour || !minute) {
    throw new Error(`Could not show an attendance time in ${timezone}.`)
  }
  return `${year}-${month}-${day}T${hour}:${minute}`
}

function zonedTimestamp(value: string, timezone: string, label: string) {
  const [datePart, timePart] = value.split('T')
  const datePieces = datePart?.split('-')
  const timePieces = timePart?.split(':')
  const year = Number(datePieces?.[0])
  const month = Number(datePieces?.[1])
  const day = Number(datePieces?.[2])
  const hour = Number(timePieces?.[0])
  const minute = Number(timePieces?.[1])
  if ([year, month, day, hour, minute].some((part) => !Number.isInteger(part))) {
    throw new Error(`${label} is incomplete.`)
  }
  const timestamp = new TZDateMini(year, month - 1, day, hour, minute, timezone).getTime()
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is not valid in ${timezone}.`)
  return timestamp
}

function positiveInteger(value: string, label: string) {
  if (!value.trim()) return undefined
  return requiredPositiveInteger(value, label)
}

function requiredPositiveInteger(value: string, label: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive whole number.`)
  return parsed
}

function barcodeName(value: BarcodeSymbology) {
  return barcodeSymbologyLabels[value]
}
