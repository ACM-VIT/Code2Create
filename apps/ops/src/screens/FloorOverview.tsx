import { api } from '@code2create/backend/api'
import { floorAreaLabels, floorMappingStateLabels } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import Papa from 'papaparse'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { LoadingLabel, SkeletonCard, SkeletonList, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'

type FloorOverviewResult = NonNullable<FunctionReturnType<typeof api.floorOperations.overview>>
type FloorZoneView = FloorOverviewResult['zones'][number]
type CsvRow = Record<string, string | undefined>
type LandmarkInput = { stableKey: string; name: string; x: number; y: number; displayOrder: number }
type ZoneInput = {
  stableKey: string
  name: string
  widthMeters: number
  depthMeters: number
  displayOrder: number
  landmarks: LandmarkInput[]
}

const csvHeader = 'zone_key,zone_name,zone_width_m,zone_depth_m,landmark_key,landmark_name,x,y'

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
  const operations = useOperationRunner()
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
    return (
      <section className="floor-shell">
        <LoadingLabel>Loading the hall map</LoadingLabel>
        <SkeletonCard lines={2} />
        <SkeletonStats columns={4} />
        <SkeletonList rows={3} />
      </section>
    )
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
      await operations.run('floor-plan-draft', (clientOperationId) => () => createDraft({
        eventSlug,
        name: planName,
        zones: parseFloorCsv(csv),
        expectedEventVersion: configuration.eventVersion,
        reason: draftReason,
        clientOperationId,
      }))
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const publishDraft = async () => {
    if (!configuration?.draftPlan) return
    const { draftPlan } = configuration
    setBusy(true)
    setError(null)
    try {
      await operations.run('floor-plan-publish', (clientOperationId) => () => publish({
        eventSlug,
        planVersionId: draftPlan.id,
        expectedPlanVersion: draftPlan.version,
        expectedEventVersion: configuration.eventVersion,
        reason: publishReason,
        clientOperationId,
      }))
      setPublishArmed(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const freezeMap = async () => {
    if (!configuration?.publishedPlan) return
    const { publishedPlan } = configuration
    setBusy(true)
    setError(null)
    try {
      await operations.run('floor-plan-freeze', (clientOperationId) => () => freeze({
        eventSlug,
        planVersionId: publishedPlan.id,
        expectedPlanVersion: publishedPlan.version,
        reason: freezeReason,
        clientOperationId,
      }))
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
              ? 'Floor staff scan the QR on each team’s dashboard, then touch roughly where the team is sitting.'
              : 'Define each zone’s size and the fixed landmarks floor staff steer by. Tables move; landmarks do not.'}
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
          <section className="stage-block">
            <FloorLead overview={overview} />
          </section>

          {overview.unmappedTeams && overview.unmappedTeams.length > 0 ? (
            <details className="floor-unmapped" open>
              <summary>
                The {overview.unmappedTeams.length} {overview.unmappedTeams.length === 1 ? 'team' : 'teams'} nobody can find yet
              </summary>
              <ul>{overview.unmappedTeams.map((team) => <li key={team.id}>{team.name}</li>)}</ul>
            </details>
          ) : null}

          <dl className="catalog-summary">
            {overview.unmappedTeams ? (
              <div><dt>Still to place</dt><dd>{overview.unmappedTeams.length}</dd></div>
            ) : null}
            <div>
              <dt>Placed on this map</dt>
              <dd>
                {overview.eligibleTeamCount === undefined
                  ? overview.visibleMappedCount
                  : `${overview.visibleMappedCount} of ${overview.eligibleTeamCount}`}
              </dd>
            </div>
            <div><dt>Busiest part of the hall</dt><dd>{busiestArea(overview)}</dd></div>
          </dl>
          <p className="floor-state">
            {overview.plan.mappingState === 'frozen'
              ? `${floorMappingStateLabels.frozen}. Correcting a location now needs the override permission.`
              : floorMappingStateLabels.open}
          </p>

          {overview.plan.mappingState === 'open'
            && configuration?.canFreeze
            && configuration.publishedPlan?.mappingState === 'open'
            && !mapReadyToFreeze
            && overview.unmappedTeams
            && overview.unmappedTeams.length > 0 ? (
            <p className="notice">
              The map cannot be frozen yet: nobody has recorded where {overview.unmappedTeams.length}{' '}
              {overview.unmappedTeams.length === 1 ? 'team is' : 'teams are'} sitting.
            </p>
          ) : null}

          <div className="floor-zone-list">
            {overview.zones.map((zone) => <FloorZoneMap key={zone.id} zone={zone} />)}
          </div>
        </>
      ) : view === 'operations' && canReadLocations ? (
        <div className="health-empty">
          <strong>No hall layout is published, so floor staff have no room to place teams in.</strong>
          <span>
            {canReadConfiguration
              ? 'Scanning a team’s QR fails until a layout is published.'
              : 'Scanning a team’s QR fails until an organizer publishes a layout.'}
          </span>
        </div>
      ) : null}

      {view === 'configuration' && configuration?.publishedPlan ? (
        <section className="draft-summary floor-draft-summary">
          <div>
            <p className="eyebrow">Published</p>
            <h2>{configuration.publishedPlan.name}</h2>
            <p className="muted">
              {configuration.publishedPlan.zoneCount} zones · {configuration.publishedPlan.landmarkCount} landmarks · {floorMappingStateLabels[configuration.publishedPlan.mappingState]}
            </p>
          </div>
        </section>
      ) : null}

      {view === 'configuration' && configuration?.draftPlan ? (
        <section className="draft-summary floor-draft-summary">
          <div>
            <p className="eyebrow">Draft plan {configuration.draftPlan.planNumber}</p>
            <h2>{configuration.draftPlan.name}</h2>
            <p className="muted">
              {configuration.draftPlan.zoneCount} zones · {configuration.draftPlan.landmarkCount} landmarks · floor staff cannot use it until it is published
            </p>
          </div>
          {configuration.canPublish && !publishArmed ? (
            <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>Publish draft</button>
          ) : null}
        </section>
      ) : null}

      {view === 'configuration' && configuration?.draftPlan && configuration.canPublish && publishArmed ? (
        <section className="publish-confirmation">
          <h2>Publish this hall plan?</h2>
          <p className="muted">Publishing opens team mapping. The plan cannot be replaced once a team is placed.</p>
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
            <p className="muted">
              Correcting a location afterwards needs the override permission and a written reason.
            </p>
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
            <p className="eyebrow">Hall zones</p>
            <h2>
              {configuration.draftPlan
                ? 'Replace draft'
                : configuration.publishedPlan
                  ? 'Create replacement draft'
                  : 'Create hall layout'}
            </h2>
            <p className="section-note">
              One row per landmark. Rows sharing a zone_key become one zone, and x and y are
              percentages across and along that zone’s rectangle.
            </p>
          </div>
          <label className="field"><span>Plan name</span><input required value={planName} onChange={(event) => setPlanName(event.target.value)} /></label>
          <label className="field">
            <span>Zones and landmarks · spreadsheet rows</span>
            <textarea className="floor-csv" required spellCheck={false} value={csv} onChange={(event) => setCsv(event.target.value)} />
          </label>
          <p className="fine-print">
            Columns: zone_key, zone_name, zone_width_m, zone_depth_m, landmark_key, landmark_name, x, y.
            Width and depth are paced metres. Every zone needs at least one landmark, because a mapper
            holding a blank rectangle cannot tell which way it faces.
          </p>
          <label className="field"><span>Why this changed</span><textarea value={draftReason} onChange={(event) => setDraftReason(event.target.value)} /></label>
          <button className="primary" disabled={busy || csv.trim() === csvHeader} type="submit">{busy ? 'Saving…' : 'Save draft'}</button>
        </form>
      ) : null}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function FloorZoneMap({ zone }: { zone: FloorZoneView }) {
  const crowded = [...zone.areas].sort((left, right) => right.teamCount - left.teamCount)[0]
  return (
    <article className="floor-zone">
      <div className="floor-zone-heading">
        <h2>{zone.name}</h2>
        <span>
          {zone.teams.length === 0
            ? `No team placed yet · about ${zone.widthMeters}m by ${zone.depthMeters}m`
            : `${zone.teams.length} ${zone.teams.length === 1 ? 'team' : 'teams'} · busiest ${
                crowded && crowded.teamCount > 0 ? floorAreaLabels[crowded.area].toLocaleLowerCase('en-IN') : 'nowhere yet'
              }`}
        </span>
      </div>
      <div
        className="floor-map"
        aria-label={`${zone.name} team locations`}
        style={{ aspectRatio: `${zone.widthMeters} / ${zone.depthMeters}` }}
      >
        {zone.areas.map((area) => (
          <div
            className="floor-map-area"
            key={area.area}
            data-load={loadBand(area.teamCount, zone.teams.length)}
            title={`${floorAreaLabels[area.area]}: ${area.teamCount} ${area.teamCount === 1 ? 'team' : 'teams'}`}
          >
            <span>{floorAreaLabels[area.area]}</span>
          </div>
        ))}
        {zone.landmarks.map((landmark) => (
          <div
            className="floor-map-landmark"
            key={landmark.id}
            style={{ left: `${landmark.x}%`, top: `${landmark.y}%` }}
          >
            {landmark.name}
          </div>
        ))}
        {zone.teams.map((team) => (
          <div
            className="floor-map-team"
            key={team.teamId}
            style={{ left: `${team.x}%`, top: `${team.y}%` }}
            title={`${team.teamName}: ${floorAreaLabels[team.area]}`}
          >
            <span>{team.teamName}</span>
          </div>
        ))}
      </div>
    </article>
  )
}

function FloorLead({ overview }: { overview: FloorOverviewResult }) {
  const unmapped = overview.unmappedTeams?.length
  if (unmapped === undefined || overview.eligibleTeamCount === undefined) {
    return (
      <>
        <p>
          {overview.visibleMappedCount === 0
            ? 'No team has been placed in the zones you can see.'
            : `${overview.visibleMappedCount} ${overview.visibleMappedCount === 1 ? 'team is' : 'teams are'} placed in the zones you can see.`}
        </p>
        <p className="muted">
          You read only your own zones, so hall-wide counts are not available.
        </p>
      </>
    )
  }
  if (overview.eligibleTeamCount === 0) {
    return (
      <>
        <p>No team is ready to be placed yet.</p>
        <p className="muted">Teams appear here once they are admitted and confirmed.</p>
      </>
    )
  }
  if (unmapped === 0) {
    return (
      <>
        <p>All {overview.eligibleTeamCount} teams have a recorded place in the hall.</p>
        <p className="muted">
          {overview.plan.mappingState === 'frozen'
            ? 'The map is frozen. Changing a location needs the override permission.'
            : 'Freeze the map to stop it drifting.'}
        </p>
      </>
    )
  }
  return (
    <>
      <p>
        {unmapped === overview.eligibleTeamCount
          ? `Nobody has recorded where any of the ${overview.eligibleTeamCount} teams are sitting, so floor staff cannot find any of them.`
          : `${unmapped} of the ${overview.eligibleTeamCount} teams have no recorded place in the hall, so floor staff cannot find them.`}
      </p>
    </>
  )
}

function busiestArea(overview: FloorOverviewResult) {
  const ranked = overview.zones
    .flatMap((zone) => zone.areas.map((area) => ({ zoneName: zone.name, ...area })))
    .sort((left, right) => right.teamCount - left.teamCount)[0]
  if (!ranked || ranked.teamCount === 0) return 'Nowhere yet'
  return `${floorAreaLabels[ranked.area]}, ${ranked.zoneName} · ${ranked.teamCount}`
}

function loadBand(teamCount: number, zoneTeamCount: number): 'empty' | 'some' | 'busy' {
  if (teamCount === 0) return 'empty'
  return teamCount * 9 >= zoneTeamCount * 2 ? 'busy' : 'some'
}

function parseFloorCsv(source: string): ZoneInput[] {
  const result = Papa.parse<CsvRow>(source, { header: true, skipEmptyLines: 'greedy' })
  const parseError = result.errors[0]
  if (parseError) throw new Error(`CSV row ${parseError.row === undefined ? '?' : parseError.row + 2}: ${parseError.message}`)
  if (result.data.length === 0) throw new Error('Add at least one hall landmark.')
  const zonesByKey = new Map<string, ZoneInput>()
  result.data.forEach((row, index) => {
    const rowNumber = index + 2
    const stableKey = requiredCell(row, 'zone_key', rowNumber)
    const name = requiredCell(row, 'zone_name', rowNumber)
    const widthMeters = metres(row, 'zone_width_m', rowNumber)
    const depthMeters = metres(row, 'zone_depth_m', rowNumber)
    const priorZone = zonesByKey.get(stableKey)
    if (
      priorZone &&
      (priorZone.name !== name ||
        priorZone.widthMeters !== widthMeters ||
        priorZone.depthMeters !== depthMeters)
    ) {
      throw new Error(`CSV row ${rowNumber}: zone ${stableKey} is described two different ways.`)
    }
    const zone =
      priorZone ??
      { stableKey, name, widthMeters, depthMeters, displayOrder: zonesByKey.size, landmarks: [] }
    zone.landmarks.push({
      stableKey: requiredCell(row, 'landmark_key', rowNumber),
      name: requiredCell(row, 'landmark_name', rowNumber),
      x: percentage(row, 'x', rowNumber),
      y: percentage(row, 'y', rowNumber),
      displayOrder: zone.landmarks.length,
    })
    zonesByKey.set(stableKey, zone)
  })
  return [...zonesByKey.values()]
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

function metres(row: CsvRow, key: string, rowNumber: number) {
  const value = Number(requiredCell(row, key, rowNumber))
  if (!Number.isFinite(value) || value < 2 || value > 300) {
    throw new Error(`CSV row ${rowNumber}: ${key} must be from 2 through 300 metres.`)
  }
  return value
}
