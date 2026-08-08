import { api } from '@code2create/backend/api'
import {
  barcodeSymbologies,
  findBarcodeSymbology,
  type BarcodeSymbology,
} from '@code2create/domain'
import { TZDateMini } from '@date-fns/tz'
import type { FunctionArgs } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

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
  scannerCount: string
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

export function AttendanceSetup() {
  const publicState = useQuery(api.system.getPublicState, { eventSlug })
  const configuration = useQuery(api.attendanceConfiguration.current, { eventSlug })
  const createDraft = useMutation(api.attendanceConfiguration.createDraft)
  const publish = useMutation(api.attendanceConfiguration.publish)
  const [planName, setPlanName] = useState('Code2Create hacking sessions')
  const [zones, setZones] = useState<DraftZone[]>(() => [newZone('Main hack hall', 'main_hack_hall')])
  const [barcodeSymbology, setBarcodeSymbology] = useState<BarcodeSymbology | ''>('')
  const [offlineQueueMaxScans, setOfflineQueueMaxScans] = useState('8')
  const [offlineQueueMaxAgeSeconds, setOfflineQueueMaxAgeSeconds] = useState('180')
  const [venueEntryScannerCount, setVenueEntryScannerCount] = useState('1')
  const [venueExitScannerCount, setVenueExitScannerCount] = useState('1')
  const [preservedStations, setPreservedStations] = useState<StationInput[]>([])
  const [sessions, setSessions] = useState<DraftSession[]>(() => [newSession('main_hack_hall')])
  const [loadedSource, setLoadedSource] = useState('')
  const [draftReason, setDraftReason] = useState('Prepared for event-day attendance rehearsal')
  const [publishReason, setPublishReason] = useState('Published after attendance rehearsal')
  const [publishArmed, setPublishArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    setVenueEntryScannerCount(`${source.stations.filter((station) => station.mode === 'venue_entry').length}`)
    setVenueExitScannerCount(`${source.stations.filter((station) => station.mode === 'venue_exit').length}`)
    setPreservedStations(source.stations.filter((station) => (
      station.mode !== 'roving' && station.mode !== 'venue_entry' && station.mode !== 'venue_exit'
    )))
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
      scannerCount: `${source.stations.filter((station) => (
        station.mode === 'roving' && station.sessionKey === session.stableKey
      )).length}`,
    })))
    setLoadedSource(sourceKey)
    setPublishArmed(false)
  }, [configuration, loadedSource, publicState])

  if (publicState === undefined || configuration === undefined) {
    return <p className="muted">Loading attendance setup…</p>
  }
  const timezone = publicState.event?.timezone
  if (!timezone) return <p className="notice error">The event timezone is not configured.</p>

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
  }

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault()
    if (!barcodeSymbology) {
      setError('Select the barcode format confirmed during a real VIT ID rehearsal.')
      return
    }
    setBusy(true)
    setError(null)
    try {
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
      const sessionKeys = new Set(sessionInputs.map((session) => session.stableKey))
      const sessionStations: StationInput[] = sessions.flatMap((session) => {
        const scannerCount = requiredPositiveInteger(session.scannerCount, 'Scanner count')
        if (scannerCount > 8) throw new Error('Use no more than eight scanner phones per session.')
        return Array.from({ length: scannerCount }, (_, stationIndex) => ({
          stableKey: `${session.stableKey}_scanner_${stationIndex + 1}`,
          name: `${session.name} scanner ${stationIndex + 1}`,
          zoneKey: session.zoneKey,
          sessionKey: session.stableKey,
          mode: 'roving',
          allowedCredentialKinds: ['vit_id_barcode', 'badge_qr', 'portal_qr'],
        }))
      })
      const venueZoneKey = zoneInputs[0]?.stableKey
      if (!venueZoneKey) throw new Error('Add at least one event area.')
      const venueStations = [
        ...venueStationInputs(
          'venue_arrivals',
          'Venue arrivals',
          'venue_entry',
          requiredNonnegativeInteger(venueEntryScannerCount, 'Venue arrival phones'),
          venueZoneKey,
        ),
        ...venueStationInputs(
          'venue_departures',
          'Venue departures',
          'venue_exit',
          requiredNonnegativeInteger(venueExitScannerCount, 'Venue departure phones'),
          venueZoneKey,
        ),
      ]
      const stationInputs: StationInput[] = [
        ...preservedStations.filter((station) => (
          station.sessionKey === undefined || sessionKeys.has(station.sessionKey)
        )),
        ...venueStations,
        ...sessionStations,
      ]
      const pendingScanLimit = requiredPositiveInteger(offlineQueueMaxScans, 'Offline queue size')
      const pendingScanAgeSeconds = requiredPositiveInteger(offlineQueueMaxAgeSeconds, 'Offline queue age')
      if (pendingScanLimit > 25) throw new Error('Keep the offline queue at 25 scans or fewer per phone.')
      if (pendingScanAgeSeconds < 30 || pendingScanAgeSeconds > 600) {
        throw new Error('Keep offline scans for 30 to 600 seconds.')
      }
      await createDraft({
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
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const publishDraft = async () => {
    if (!configuration.draftPlan) return
    setBusy(true)
    setError(null)
    try {
      await publish({
        eventSlug,
        planVersionId: configuration.draftPlan.id,
        expectedEventVersion: configuration.eventVersion,
        reason: publishReason,
        clientOperationId: crypto.randomUUID(),
      })
      setPublishArmed(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="attendance-shell setup-shell">
      <Link className="back-link" to="/attendance">← Attendance</Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Event setup</p>
          <h1>Check-in schedule</h1>
          <p className="muted">Times are entered in {timezone}. Assign each scanner phone to the hacking sessions it will cover.</p>
        </div>
      </header>

      {configuration.publishedPlan ? (
        <p className="notice">Current plan: {configuration.publishedPlan.name}</p>
      ) : null}

      {configuration.draftPlan ? (
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

      {configuration.draftPlan && configuration.canPublish && publishArmed ? (
        <section className="publish-confirmation">
          <h2>Publish this plan?</h2>
          <p className="muted">
            Publishing makes these sessions and phone stations authoritative. If a plan is already live, its phone assignments are disabled and must be provisioned again. A preparing or open session must finish first.
          </p>
          <label className="field">
            <span>Why this changed</span>
            <textarea value={publishReason} onChange={(event) => setPublishReason(event.target.value)} />
          </label>
          <div className="button-row">
            <button className="primary" type="button" disabled={busy || publishReason.trim().length < 5} onClick={() => void publishDraft()}>
              {busy ? 'Publishing…' : 'Publish plan'}
            </button>
            <button className="secondary" type="button" disabled={busy} onClick={() => setPublishArmed(false)}>Cancel</button>
          </div>
        </section>
      ) : null}

      {configuration.canConfigure ? (
        <form className="setup-form" onSubmit={saveDraft}>
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
              <Field label="Venue arrival phones">
                <input required inputMode="numeric" value={venueEntryScannerCount} onChange={(event) => setVenueEntryScannerCount(event.target.value)} />
              </Field>
              <Field label="Venue departure phones">
                <input required inputMode="numeric" value={venueExitScannerCount} onChange={(event) => setVenueExitScannerCount(event.target.value)} />
              </Field>
            </div>
            <p className="muted">During a short outage, each assigned phone keeps only this small encrypted queue. VIT IDs and event badges can replay; short-lived participant portal codes still need an online connection.</p>
          </section>

          <section className="setup-section">
            <div className="section-heading">
              <div>
                <h2>Event areas</h2>
                <p className="muted">Use the real hall or controlled area names that scanner staff will see.</p>
              </div>
              <button className="secondary" type="button" onClick={() => setZones((current) => [...current, newZone(`Area ${current.length + 1}`)])}>Add area</button>
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
                <h2>Hacking sessions</h2>
                <p className="muted">Each session has its own check-in window and assigned scanner phones.</p>
              </div>
              <button className="secondary" type="button" onClick={() => setSessions((current) => [...current, newSession(zones[0]?.stableKey ?? 'main_hack_hall')])}>Add session</button>
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
                    <Field label="Scanner phones">
                      <input required inputMode="numeric" value={session.scannerCount} onChange={(event) => updateSession(session.id, { scannerCount: event.target.value })} />
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

          <section className="setup-section final-setup-section">
            <Field label="Why this changed">
              <textarea required value={draftReason} onChange={(event) => setDraftReason(event.target.value)} />
            </Field>
            <button className="primary" type="submit" disabled={busy || sessions.length === 0}>
              {busy ? 'Saving…' : configuration.draftPlan ? 'Replace draft' : 'Create draft'}
            </button>
          </section>
        </form>
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
    scannerCount: '2',
  }
}

function venueStationInputs(
  stableKeyPrefix: string,
  name: string,
  mode: 'venue_entry' | 'venue_exit',
  count: number,
  zoneKey: string,
): StationInput[] {
  return Array.from({ length: count }, (_, index) => ({
    stableKey: `${stableKeyPrefix}_${index + 1}`,
    name: `${name} ${index + 1}`,
    zoneKey,
    mode,
    allowedCredentialKinds: ['vit_id_barcode', 'badge_qr', 'portal_qr'],
  }))
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

function requiredNonnegativeInteger(value: string, label: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be zero or a positive whole number.`)
  return parsed
}

function barcodeName(value: BarcodeSymbology) {
  if (value === 'qr') return 'QR'
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
