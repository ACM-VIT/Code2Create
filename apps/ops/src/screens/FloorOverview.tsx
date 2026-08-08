import { api } from '@code2create/backend/api'
import { useMutation, useQuery } from 'convex/react'
import Papa from 'papaparse'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type CsvRow = Record<string, string | undefined>
type ZoneInput = { stableKey: string; name: string; displayOrder: number }
type SpotInput = {
  stableKey: string
  zoneKey: string
  label: string
  x: number
  y: number
  accessible: boolean
  status: 'available' | 'closed'
  displayOrder: number
}

const csvHeader = 'zone_key,zone_name,spot_key,spot_label,x,y,accessible,status'

export function FloorOverview({
  canReadLocations,
  canReadConfiguration,
  view,
}: {
  canReadLocations: boolean
  canReadConfiguration: boolean
  view: 'operations' | 'configuration'
}) {
  const configuration = useQuery(
    api.floorConfiguration.current,
    canReadConfiguration ? { eventSlug } : 'skip',
  )
  const overview = useQuery(
    api.floorOperations.overview,
    view === 'operations' && canReadLocations ? { eventSlug } : 'skip',
  )
  const createDraft = useMutation(api.floorConfiguration.createDraft)
  const publish = useMutation(api.floorConfiguration.publish)
  const freeze = useMutation(api.floorConfiguration.freeze)
  const [planName, setPlanName] = useState('Code2Create hall map')
  const [csv, setCsv] = useState(csvHeader)
  const [draftReason, setDraftReason] = useState('Prepared from the verified hall layout')
  const [publishReason, setPublishReason] = useState('Published after walking the hall layout')
  const [freezeReason, setFreezeReason] = useState('All accepted teams were physically mapped and checked')
  const [publishArmed, setPublishArmed] = useState(false)
  const [freezeArmed, setFreezeArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (
    (canReadConfiguration && configuration === undefined) ||
    (view === 'operations' && canReadLocations && overview === undefined)
  ) {
    return <p className="muted">Loading hall map…</p>
  }

  const mapReadyToFreeze =
    overview?.eligibleTeamCount !== undefined &&
    overview.eligibleTeamCount > 0 &&
    overview.unmappedTeams !== undefined &&
    overview.unmappedTeams.length === 0

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault()
    if (!configuration) return
    setBusy(true)
    setError(null)
    try {
      const parsed = parseFloorCsv(csv)
      await createDraft({
        eventSlug,
        name: planName,
        zones: parsed.zones,
        spots: parsed.spots,
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
    if (!configuration?.draftPlan) return
    setBusy(true)
    setError(null)
    try {
      await publish({
        eventSlug,
        planVersionId: configuration.draftPlan.id,
        expectedPlanVersion: configuration.draftPlan.version,
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

  const freezeMap = async () => {
    if (!configuration?.publishedPlan) return
    setBusy(true)
    setError(null)
    try {
      await freeze({
        eventSlug,
        planVersionId: configuration.publishedPlan.id,
        expectedPlanVersion: configuration.publishedPlan.version,
        reason: freezeReason,
        clientOperationId: crypto.randomUUID(),
      })
      setFreezeArmed(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="floor-shell">
      {view === 'configuration' ? <Link className="back-link" to="/configuration">← Event setup</Link> : null}
      <header className="page-heading">
        <div>
          <p className="eyebrow">{view === 'operations' ? 'Hall operations' : 'Event setup'}</p>
          <h1>{view === 'operations' ? 'Hall' : 'Hall layout'}</h1>
          <p className="muted">
            {view === 'operations'
              ? 'Floor staff scan the QR on each team’s dashboard, then pin the team to its real spot.'
              : 'Define the zones and team spots that floor staff will use.'}
          </p>
        </div>
        {view === 'operations' && canReadConfiguration ? (
          <Link className="secondary compact-link" to="/floor-setup">Edit hall layout</Link>
        ) : null}
        {view === 'configuration' && canReadLocations ? (
          <Link className="secondary compact-link" to="/floor">Open live hall</Link>
        ) : null}
      </header>

      {view === 'operations' && overview ? (
        <>
          <dl className="floor-counts">
            <div><dt>Mapped here</dt><dd>{overview.visibleMappedCount}</dd></div>
            <div><dt>Available spots</dt><dd>{overview.visibleSpotCount}</dd></div>
            {overview.eligibleTeamCount !== undefined ? (
              <div><dt>Accepted teams</dt><dd>{overview.eligibleTeamCount}</dd></div>
            ) : null}
            {overview.unmappedTeams ? (
              <div><dt>Still unmapped</dt><dd>{overview.unmappedTeams.length}</dd></div>
            ) : null}
          </dl>
          <p className="floor-state">
            {overview.plan.mappingState === 'frozen'
              ? 'Frozen. Any correction now needs the separate override permission and a reason.'
              : 'Open for floor mapping. The map updates as staff phones save each scan.'}
          </p>
          <div className="floor-zone-list">
            {overview.zones.map((zone) => (
              <article className="floor-zone" key={zone.id}>
                <div className="floor-zone-heading">
                  <h2>{zone.name}</h2>
                  <span>{zone.spots.filter((spot) => spot.team).length} mapped</span>
                </div>
                <div className="floor-map" aria-label={`${zone.name} team locations`}>
                  {zone.spots.map((spot) => (
                    <div
                      className={`floor-map-spot ${spot.team ? 'occupied' : ''} ${spot.status === 'closed' ? 'closed' : ''}`}
                      key={spot.id}
                      style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
                      title={spot.team ? `${spot.label}: ${spot.team.name}` : `${spot.label}: ${spot.status}`}
                    >
                      <strong>{spot.label}</strong>
                      {spot.team ? <span>{spot.team.name}</span> : null}
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
          {overview.unmappedTeams && overview.unmappedTeams.length > 0 ? (
            <details className="floor-unmapped">
              <summary>
                {overview.unmappedTeams.length} {overview.unmappedTeams.length === 1 ? 'team still needs' : 'teams still need'} a location
              </summary>
              <ul>{overview.unmappedTeams.map((team) => <li key={team.id}>{team.name}</li>)}</ul>
            </details>
          ) : null}
        </>
      ) : view === 'operations' && canReadLocations ? (
        <p className="empty">No floor plan is published yet.</p>
      ) : null}

      {view === 'configuration' && configuration?.publishedPlan ? (
        <section className="draft-summary floor-draft-summary">
          <div>
            <p className="eyebrow">Published</p>
            <h2>{configuration.publishedPlan.name}</h2>
            <p className="muted">
              {configuration.publishedPlan.zoneCount} zones · {configuration.publishedPlan.spotCount} team spots · {configuration.publishedPlan.mappingState === 'frozen' ? 'Locations frozen' : 'Open for mapping'}
            </p>
          </div>
        </section>
      ) : null}

      {view === 'configuration' && configuration?.draftPlan ? (
        <section className="draft-summary floor-draft-summary">
          <div>
            <p className="eyebrow">Draft plan {configuration.draftPlan.planNumber}</p>
            <h2>{configuration.draftPlan.name}</h2>
            <p className="muted">{configuration.draftPlan.zoneCount} zones · {configuration.draftPlan.spotCount} spots</p>
          </div>
          {configuration.canPublish && !publishArmed ? (
            <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>Publish draft</button>
          ) : null}
        </section>
      ) : null}

      {view === 'configuration' && configuration?.draftPlan && configuration.canPublish && publishArmed ? (
        <section className="publish-confirmation">
          <h2>Publish this hall plan?</h2>
          <p className="muted">Publishing opens team mapping. A plan cannot be replaced after the first location is saved.</p>
          <label className="field"><span>Reason</span><textarea value={publishReason} onChange={(event) => setPublishReason(event.target.value)} /></label>
          <div className="button-row">
            <button className="primary" disabled={busy || publishReason.trim().length < 5} type="button" onClick={() => void publishDraft()}>{busy ? 'Publishing…' : 'Publish plan'}</button>
            <button className="secondary" disabled={busy} type="button" onClick={() => setPublishArmed(false)}>Cancel</button>
          </div>
        </section>
      ) : null}

      {view === 'operations' && mapReadyToFreeze && configuration?.publishedPlan?.mappingState === 'open' && configuration.canFreeze ? (
        freezeArmed ? (
          <section className="publish-confirmation floor-freeze">
            <h2>Freeze team locations?</h2>
            <p className="muted">This succeeds only when every accepted team has one location. Later changes require a separately granted override.</p>
            <label className="field"><span>Reason</span><textarea value={freezeReason} onChange={(event) => setFreezeReason(event.target.value)} /></label>
            <div className="button-row">
              <button className="primary" disabled={busy || freezeReason.trim().length < 5} type="button" onClick={() => void freezeMap()}>{busy ? 'Freezing…' : 'Freeze locations'}</button>
              <button className="secondary" disabled={busy} type="button" onClick={() => setFreezeArmed(false)}>Cancel</button>
            </div>
          </section>
        ) : (
          <button className="secondary floor-freeze-button" type="button" onClick={() => setFreezeArmed(true)}>Freeze completed map</button>
        )
      ) : null}

      {view === 'configuration' && configuration?.canCreate ? (
        <form className="floor-setup" onSubmit={saveDraft}>
          <div>
            <p className="eyebrow">Hall spots</p>
            <h2>
              {configuration.draftPlan
                ? 'Replace draft'
                : configuration.publishedPlan
                  ? 'Create replacement draft'
                  : 'Create hall layout'}
            </h2>
            <p className="muted">Paste rows from a spreadsheet. Coordinates are percentages across each zone canvas.</p>
          </div>
          <label className="field"><span>Plan name</span><input required value={planName} onChange={(event) => setPlanName(event.target.value)} /></label>
          <label className="field">
            <span>Hall spots · spreadsheet rows</span>
            <textarea className="floor-csv" required spellCheck={false} value={csv} onChange={(event) => setCsv(event.target.value)} />
          </label>
          <p className="fine-print">Columns: zone_key, zone_name, spot_key, spot_label, x, y, accessible, status. Status is available or closed.</p>
          <label className="field"><span>Why this changed</span><textarea value={draftReason} onChange={(event) => setDraftReason(event.target.value)} /></label>
          <button className="primary" disabled={busy || csv.trim() === csvHeader} type="submit">{busy ? 'Saving…' : 'Save draft'}</button>
        </form>
      ) : null}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function parseFloorCsv(source: string): { zones: ZoneInput[]; spots: SpotInput[] } {
  const result = Papa.parse<CsvRow>(source, { header: true, skipEmptyLines: 'greedy' })
  const parseError = result.errors[0]
  if (parseError) throw new Error(`CSV row ${parseError.row === undefined ? '?' : parseError.row + 2}: ${parseError.message}`)
  if (result.data.length === 0) throw new Error('Add at least one hall spot.')
  const zonesByKey = new Map<string, ZoneInput>()
  const spots = result.data.map((row, index): SpotInput => {
    const rowNumber = index + 2
    const zoneKey = requiredCell(row, 'zone_key', rowNumber)
    const zoneName = requiredCell(row, 'zone_name', rowNumber)
    const priorZone = zonesByKey.get(zoneKey)
    if (priorZone && priorZone.name !== zoneName) {
      throw new Error(`CSV row ${rowNumber}: zone ${zoneKey} has more than one name.`)
    }
    if (!priorZone) {
      zonesByKey.set(zoneKey, { stableKey: zoneKey, name: zoneName, displayOrder: zonesByKey.size })
    }
    return {
      stableKey: requiredCell(row, 'spot_key', rowNumber),
      zoneKey,
      label: requiredCell(row, 'spot_label', rowNumber),
      x: percentage(row, 'x', rowNumber),
      y: percentage(row, 'y', rowNumber),
      accessible: booleanCell(row, 'accessible', rowNumber),
      status: statusCell(row, rowNumber),
      displayOrder: index,
    }
  })
  return { zones: [...zonesByKey.values()], spots }
}

function requiredCell(row: CsvRow, key: string, rowNumber: number) {
  const value = row[key]?.trim()
  if (!value) throw new Error(`CSV row ${rowNumber}: ${key} is required.`)
  return value
}

function percentage(row: CsvRow, key: string, rowNumber: number) {
  const value = Number(requiredCell(row, key, rowNumber))
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`CSV row ${rowNumber}: ${key} must be from 0 through 100.`)
  }
  return value
}

function booleanCell(row: CsvRow, key: string, rowNumber: number) {
  const value = requiredCell(row, key, rowNumber).toLowerCase()
  if (value === 'true' || value === 'yes' || value === '1') return true
  if (value === 'false' || value === 'no' || value === '0') return false
  throw new Error(`CSV row ${rowNumber}: ${key} must be true or false.`)
}

function statusCell(row: CsvRow, rowNumber: number): 'available' | 'closed' {
  const value = requiredCell(row, 'status', rowNumber).toLowerCase()
  if (value === 'available' || value === 'closed') return value
  throw new Error(`CSV row ${rowNumber}: status must be available or closed.`)
}
