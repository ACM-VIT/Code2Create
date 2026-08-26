import { api } from '@code2create/backend/api'
import { floorAreaLabels, floorAreas, floorMappingStateLabels } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Link } from 'react-router-dom'

import { ConfigurationEditorDisclosure } from '../components/ConfigurationEditorDisclosure'
import { ConfigurationTabs, type ConfigurationTabsVisibility } from '../components/ConfigurationTabs'
import { LoadingLabel, SkeletonCard, SkeletonList, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'

type FloorOverviewResult = NonNullable<FunctionReturnType<typeof api.floorOperations.overview>>
type FloorZoneView = FloorOverviewResult['zones'][number]
type FloorOperationResult =
  | FunctionReturnType<typeof api.floorConfiguration.createDraft>
  | FunctionReturnType<typeof api.floorConfiguration.publish>
  | FunctionReturnType<typeof api.floorConfiguration.freeze>
type LandmarkInput = { stableKey: string; name: string; x: number; y: number; displayOrder: number }
type ZoneInput = {
  stableKey: string
  name: string
  widthMeters: number
  depthMeters: number
  displayOrder: number
  landmarks: LandmarkInput[]
}
type LandmarkEditor = Omit<LandmarkInput, 'displayOrder' | 'x' | 'y'> & { x: string; y: string }
type ZoneEditor = Omit<ZoneInput, 'depthMeters' | 'displayOrder' | 'landmarks' | 'widthMeters'> & {
  widthMeters: string
  depthMeters: string
  landmarks: LandmarkEditor[]
}
type SelectedLandmark = {
  zoneKey: ZoneEditor['stableKey']
  landmarkKey: LandmarkEditor['stableKey']
}

export function FloorOverview({
  canReadLocations,
  canReadConfiguration,
  tabs,
  view,
}: {
  canReadLocations: boolean
  canReadConfiguration: boolean
  tabs: ConfigurationTabsVisibility | null
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
  const operations = useOperationRunner<FloorOperationResult>()
  const [planName, setPlanName] = useState('Code2Create hall map')
  const [zones, setZones] = useState<ZoneEditor[]>(() => [newEditorZone()])
  const [loadedPlan, setLoadedPlan] = useState('')
  const [draftReason, setDraftReason] = useState('Prepared from the verified hall layout')
  const [publishReason, setPublishReason] = useState('Published after walking the hall layout')
  const [freezeReason, setFreezeReason] = useState('All accepted teams were physically mapped and checked')
  const [publishArmed, setPublishArmed] = useState(false)
  const [freezeArmed, setFreezeArmed] = useState(false)
  const [selectedLandmark, setSelectedLandmark] = useState<SelectedLandmark | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!configuration || view !== 'configuration') return
    const source = configuration.draftPlan ?? configuration.publishedPlan
    const sourceKey = source ? `${source.id}:${source.version}` : 'new-plan'
    if (sourceKey === loadedPlan) return
    setPlanName(source?.name ?? 'Code2Create hall map')
    setZones(source ? toEditorZones(source.zones) : [newEditorZone()])
    setSelectedLandmark(null)
    setLoadedPlan(sourceKey)
  }, [configuration, loadedPlan, view])

  if (
    (canReadConfiguration && configuration === undefined) ||
    (view === 'operations' && canReadLocations && overview === undefined)
  ) {
    return (
      <section className="floor-shell">
        {tabs ? <ConfigurationTabs visibility={tabs} /> : null}
        <LoadingLabel>Loading the hall map</LoadingLabel>
        <SkeletonCard lines={2} />
        <SkeletonStats columns={4} />
        <SkeletonList rows={3} />
      </section>
    )
  }

  const freezeReadiness = configuration?.freezeReadiness
  const mapReadyToFreeze =
    freezeReadiness?.ready ??
    (overview?.eligibleTeamCount !== undefined &&
      overview.eligibleTeamCount > 0 &&
      overview.unmappedTeams !== undefined &&
      overview.unmappedTeams.length === 0)

  const updateZone = (stableKey: string, patch: Partial<ZoneEditor>) => {
    setZones((current) => current.map((zone) => (
      zone.stableKey === stableKey ? { ...zone, ...patch } : zone
    )))
  }

  const updateLandmark = (
    zoneKey: string,
    landmarkKey: string,
    patch: Partial<LandmarkEditor>,
  ) => {
    setZones((current) => current.map((zone) => (
      zone.stableKey === zoneKey
        ? {
            ...zone,
            landmarks: zone.landmarks.map((landmark) => (
              landmark.stableKey === landmarkKey ? { ...landmark, ...patch } : landmark
            )),
          }
        : zone
    )))
  }

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault()
    if (!configuration) return
    setBusy(true)
    setError(null)
    try {
      await operations.run('floor-plan-draft', (clientOperationId) => () => createDraft({
        eventSlug,
        name: planName,
        zones: toZoneInputs(zones),
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
      {tabs ? <ConfigurationTabs visibility={tabs} /> : null}
      <header className="page-heading">
        <div>
          <p className="eyebrow">{view === 'operations' ? 'Hall operations' : 'Event setup'}</p>
          <h1>{view === 'operations' ? 'Hall' : 'Hall layout'}</h1>
          <p className="muted">
            {view === 'operations'
              ? 'See where teams are sitting and which teams still need to be placed.'
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
        <FloorOperationsWorkspace overview={overview} />
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
        <section className="floor-plan-summary">
          <div>
            <span>Published plan</span>
            <h2>{configuration.publishedPlan.name}</h2>
          </div>
          <dl>
            <div><dt>Zones</dt><dd>{configuration.publishedPlan.zoneCount}</dd></div>
            <div><dt>Landmarks</dt><dd>{configuration.publishedPlan.landmarkCount}</dd></div>
            <div><dt>Team mapping</dt><dd>{floorMappingStateLabels[configuration.publishedPlan.mappingState]}</dd></div>
          </dl>
        </section>
      ) : null}

      {view === 'configuration' && configuration?.draftPlan ? (
        <section className="floor-plan-summary floor-plan-draft">
          <div>
            <span>Draft plan {configuration.draftPlan.planNumber}</span>
            <h2>{configuration.draftPlan.name}</h2>
          </div>
          <dl>
            <div><dt>Zones</dt><dd>{configuration.draftPlan.zoneCount}</dd></div>
            <div><dt>Landmarks</dt><dd>{configuration.draftPlan.landmarkCount}</dd></div>
            <div><dt>Status</dt><dd>Not visible to floor staff</dd></div>
          </dl>
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

      {view === 'configuration' && configuration?.publishedPlan?.mappingState === 'open' && configuration.canFreeze && freezeReadiness && !freezeReadiness.ready ? (
        <p className="notice">
          {freezeReadiness.eligibleTeamCount === 0
            ? 'Locations cannot be frozen until at least one admitted team is confirmed.'
            : `${freezeReadiness.unmappedTeamCount} ${freezeReadiness.unmappedTeamCount === 1 ? 'team still needs' : 'teams still need'} a recorded location before you can freeze the map.`}
        </p>
      ) : null}

      {view === 'configuration' && mapReadyToFreeze && configuration?.publishedPlan?.mappingState === 'open' && configuration.canFreeze ? (
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
        <ConfigurationEditorDisclosure
          defaultOpen={Boolean(configuration.draftPlan)}
          description="Zone dimensions and fixed landmarks used by the floor team to place teams accurately."
          title={configuration.draftPlan ? 'Continue hall-layout draft' : 'Edit hall layout'}
        >
          <form className="floor-setup" onSubmit={saveDraft}>
            <div className="configuration-editor-fields">
              <div>
                <h2>
                  {configuration.draftPlan
                    ? 'Replace draft'
                    : configuration.publishedPlan
                      ? 'Create replacement draft'
                      : 'Create hall layout'}
                </h2>
                <p className="section-note">
                  Use the room names staff know. Dimensions can be paced out; they do not need to be surveyed.
                </p>
              </div>
              <label className="field"><span>Plan name</span><input required value={planName} onChange={(event) => setPlanName(event.target.value)} /></label>
              <section className="floor-zone-editor-section">
                <div className="section-heading">
                  <div>
                    <h2>Hall zones</h2>
                    <p className="muted">Each zone needs one fixed landmark so staff know which way the phone map faces.</p>
                  </div>
                  <button className="secondary" type="button" onClick={() => setZones((current) => [...current, newEditorZone()])}>Add zone</button>
                </div>
                <div className="floor-zone-editor-list">
                  {zones.map((zone, zoneIndex) => (
                    <article className="configuration-card floor-zone-editor" key={zone.stableKey}>
                      <header className="section-heading">
                        <div>
                          <span className="eyebrow">Zone {zoneIndex + 1}</span>
                          <h3>{zone.name || 'Unnamed zone'}</h3>
                        </div>
                        {zones.length > 1 ? (
                          <button className="text-button" type="button" onClick={() => setZones((current) => current.filter((candidate) => candidate.stableKey !== zone.stableKey))}>Remove zone</button>
                        ) : null}
                      </header>
                      <div className="floor-zone-field-grid">
                        <label className="field">
                          <span>Name staff will see</span>
                          <input required maxLength={80} value={zone.name} onChange={(event) => updateZone(zone.stableKey, { name: event.currentTarget.value })} />
                        </label>
                        <label className="field">
                          <span>Width · metres</span>
                          <input required inputMode="decimal" min={2} max={300} step="0.1" type="number" value={zone.widthMeters} onChange={(event) => updateZone(zone.stableKey, { widthMeters: event.currentTarget.value })} />
                        </label>
                        <label className="field">
                          <span>Depth · metres</span>
                          <input required inputMode="decimal" min={2} max={300} step="0.1" type="number" value={zone.depthMeters} onChange={(event) => updateZone(zone.stableKey, { depthMeters: event.currentTarget.value })} />
                        </label>
                      </div>
                      <FloorZoneEditorPreview
                        onMove={(landmarkKey, x, y) => {
                          setSelectedLandmark({ zoneKey: zone.stableKey, landmarkKey })
                          updateLandmark(zone.stableKey, landmarkKey, {
                            x: formatPreviewCoordinate(x),
                            y: formatPreviewCoordinate(y),
                          })
                        }}
                        selectedLandmarkKey={
                          selectedLandmark?.zoneKey === zone.stableKey
                            ? selectedLandmark.landmarkKey
                            : null
                        }
                        zone={zone}
                      />
                      <section className="floor-landmark-editor">
                        <div className="section-heading">
                          <div>
                            <h4>Fixed landmarks</h4>
                            <p className="muted">Use doors, pillars, stage corners, or other points that will not move.</p>
                          </div>
                          <button className="secondary" type="button" onClick={() => updateZone(zone.stableKey, { landmarks: [...zone.landmarks, newEditorLandmark()] })}>Add landmark</button>
                        </div>
                        <div className="floor-landmark-list">
                          {zone.landmarks.map((landmark, landmarkIndex) => (
                            <div
                              className="floor-landmark-row"
                              data-selected={selectedLandmark?.zoneKey === zone.stableKey && selectedLandmark.landmarkKey === landmark.stableKey}
                              key={landmark.stableKey}
                              onFocus={() => setSelectedLandmark({ zoneKey: zone.stableKey, landmarkKey: landmark.stableKey })}
                            >
                              <label className="field">
                                <span>Landmark {landmarkIndex + 1}</span>
                                <input required maxLength={80} value={landmark.name} onChange={(event) => updateLandmark(zone.stableKey, landmark.stableKey, { name: event.currentTarget.value })} />
                              </label>
                              <label className="field">
                                <span>Across from left · %</span>
                                <input required inputMode="decimal" min={0} max={100} step="0.1" type="number" value={landmark.x} onChange={(event) => updateLandmark(zone.stableKey, landmark.stableKey, { x: event.currentTarget.value })} />
                              </label>
                              <label className="field">
                                <span>Down from top · %</span>
                                <input required inputMode="decimal" min={0} max={100} step="0.1" type="number" value={landmark.y} onChange={(event) => updateLandmark(zone.stableKey, landmark.stableKey, { y: event.currentTarget.value })} />
                              </label>
                              <div className="floor-landmark-actions">
                                <button
                                  aria-pressed={selectedLandmark?.zoneKey === zone.stableKey && selectedLandmark.landmarkKey === landmark.stableKey}
                                  className="text-button"
                                  type="button"
                                  onClick={() => setSelectedLandmark({ zoneKey: zone.stableKey, landmarkKey: landmark.stableKey })}
                                >
                                  Move on map
                                </button>
                                {zone.landmarks.length > 1 ? (
                                  <button className="text-button" type="button" onClick={() => updateZone(zone.stableKey, { landmarks: zone.landmarks.filter((candidate) => candidate.stableKey !== landmark.stableKey) })}>Remove</button>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    </article>
                  ))}
                </div>
              </section>
            </div>
            <section className="configuration-save">
              <label className="field"><span>Why this changed</span><textarea value={draftReason} onChange={(event) => setDraftReason(event.target.value)} /></label>
              <button className="primary" disabled={busy || zones.length === 0} type="submit">{busy ? 'Saving…' : 'Save draft'}</button>
            </section>
          </form>
        </ConfigurationEditorDisclosure>
      ) : null}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function FloorOperationsWorkspace({ overview }: { overview: FloorOverviewResult }) {
  const [selectedZoneId, setSelectedZoneId] = useState<FloorZoneView['id'] | null>(null)
  const [teamSearch, setTeamSearch] = useState('')
  const selectedZone = overview.zones.find((zone) => zone.id === selectedZoneId) ?? overview.zones[0]
  const query = teamSearch.trim().toLocaleLowerCase('en-IN')
  const waitingTeams = overview.unmappedTeams?.filter((team) => (
    query.length === 0 || team.name.toLocaleLowerCase('en-IN').includes(query)
  ))
  const recentPlacements = overview.zones
    .flatMap((zone) => zone.teams.map((team) => ({ ...team, zoneName: zone.name })))
    .sort((left, right) => right.mappedAt - left.mappedAt)
    .slice(0, 5)
  const total = overview.eligibleTeamCount
  const placed = overview.visibleMappedCount
  const progress = total === undefined || total === 0 ? 0 : Math.round((placed / total) * 100)

  if (!selectedZone) {
    return <div className="health-empty"><strong>No hall zone is visible to this account.</strong></div>
  }

  return (
    <div className="floor-operations-workspace">
      <section className="floor-mapping-progress">
        <div>
          <span className="floor-mapping-state">{floorMappingStateLabels[overview.plan.mappingState]}</span>
          <h2>{floorProgressHeading(overview)}</h2>
          <p>Floor staff place a team by scanning its dashboard QR in the reviewer app.</p>
        </div>
        <div className="floor-progress-count">
          <strong>{placed}</strong>
          <span>{total === undefined ? 'placed in your zones' : `of ${total} placed`}</span>
        </div>
        {total !== undefined ? (
          <div
            aria-label={`${placed} of ${total} teams placed`}
            aria-valuemax={total}
            aria-valuemin={0}
            aria-valuenow={placed}
            className="floor-progress-track"
            role="progressbar"
          >
            <span style={{ width: `${progress}%` }} />
          </div>
        ) : null}
      </section>

      <div className="floor-operations-grid">
        <main className="floor-operations-map">
          {overview.zones.length > 1 ? (
            <nav aria-label="Hall zones" className="floor-zone-switcher">
              {overview.zones.map((zone) => (
                <button
                  aria-pressed={zone.id === selectedZone.id}
                  className={zone.id === selectedZone.id ? 'stage-chip active' : 'stage-chip'}
                  key={zone.id}
                  type="button"
                  onClick={() => setSelectedZoneId(zone.id)}
                >
                  {zone.name} <span>{zone.teams.length}</span>
                </button>
              ))}
            </nav>
          ) : null}
          <FloorZoneMap zone={selectedZone} />
        </main>

        <aside className="floor-operations-rail">
          {overview.unmappedTeams ? (
            <section className="floor-worklist">
              <header>
                <div>
                  <h2>Waiting to be placed</h2>
                  <p>These teams do not have a recorded seat yet.</p>
                </div>
                <span>{overview.unmappedTeams.length}</span>
              </header>
              {overview.unmappedTeams.length > 6 ? (
                <label className="field floor-team-search">
                  <span className="visually-hidden">Find a waiting team</span>
                  <input
                    placeholder="Find a team"
                    type="search"
                    value={teamSearch}
                    onChange={(event) => setTeamSearch(event.currentTarget.value)}
                  />
                </label>
              ) : null}
              {waitingTeams && waitingTeams.length > 0 ? (
                <ol className="floor-team-list">
                  {waitingTeams.map((team) => <li key={team.id}>{team.name}</li>)}
                </ol>
              ) : (
                <p className="floor-worklist-empty">
                  {overview.unmappedTeams.length === 0 ? 'Every team has a location.' : 'No waiting team matches that search.'}
                </p>
              )}
            </section>
          ) : null}

          <section className="floor-worklist">
            <header>
              <div>
                <h2>Recently placed</h2>
                <p>Latest locations visible to you.</p>
              </div>
            </header>
            {recentPlacements.length > 0 ? (
              <ol className="floor-recent-list">
                {recentPlacements.map((placement) => (
                  <li key={placement.teamId}>
                    <strong>{placement.teamName}</strong>
                    <span>{floorAreaLabels[placement.area]} · {placement.zoneName}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="floor-worklist-empty">The first scanned team will appear here.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}

function FloorZoneEditorPreview({
  onMove,
  selectedLandmarkKey,
  zone,
}: {
  onMove: (landmarkKey: string, x: number, y: number) => void
  selectedLandmarkKey: string | null
  zone: ZoneEditor
}) {
  const selectedLandmark = zone.landmarks.find((landmark) => landmark.stableKey === selectedLandmarkKey)
    ?? zone.landmarks[0]
  if (!selectedLandmark) return null

  const moveLandmark = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = clamp(((event.clientX - bounds.left) / bounds.width) * 100, 0, 100)
    const y = clamp(((event.clientY - bounds.top) / bounds.height) * 100, 0, 100)
    onMove(selectedLandmark.stableKey, x, y)
  }

  return (
    <section className="floor-layout-preview-section">
      <div className="floor-layout-preview-heading">
        <div>
          <h4>Preview</h4>
          <p>Moving <strong>{selectedLandmark.name || 'the selected landmark'}</strong>. Click the room to place it.</p>
        </div>
        <span>{previewDimension(zone.widthMeters)}m × {previewDimension(zone.depthMeters)}m</span>
      </div>
      <div className="floor-layout-preview-frame">
        <button
          aria-label={`Move ${selectedLandmark.name || 'the selected landmark'} on the ${zone.name || 'zone'} preview`}
          className="floor-map floor-layout-preview"
          style={{ aspectRatio: `${previewDimension(zone.widthMeters)} / ${previewDimension(zone.depthMeters)}` }}
          type="button"
          onClick={moveLandmark}
        >
          {floorAreas.map((area) => (
            <span className="floor-map-area" key={area}><span>{floorAreaLabels[area]}</span></span>
          ))}
          {zone.landmarks.map((landmark, landmarkIndex) => (
            <span
              className="floor-map-landmark"
              data-horizontal={mapLabelAnchor(previewCoordinate(landmark.x))}
              data-selected={landmark.stableKey === selectedLandmark.stableKey}
              key={landmark.stableKey}
              style={{
                left: `${previewCoordinate(landmark.x)}%`,
                top: `${previewCoordinate(landmark.y)}%`,
              }}
            >
              {landmark.name || `Landmark ${landmarkIndex + 1}`}
            </span>
          ))}
        </button>
      </div>
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
            data-horizontal={mapLabelAnchor(landmark.x)}
            key={landmark.id}
            style={{ left: `${landmark.x}%`, top: `${landmark.y}%` }}
          >
            {landmark.name}
          </div>
        ))}
        {zone.teams.map((team) => (
          <div
            className="floor-map-team"
            data-horizontal={mapLabelAnchor(team.x)}
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

function floorProgressHeading(overview: FloorOverviewResult) {
  const unmapped = overview.unmappedTeams?.length
  if (unmapped === undefined || overview.eligibleTeamCount === undefined) {
    return overview.visibleMappedCount === 0
      ? 'Start placing teams in your zones'
      : `${overview.visibleMappedCount} ${overview.visibleMappedCount === 1 ? 'team is' : 'teams are'} placed in your zones`
  }
  if (overview.eligibleTeamCount === 0) {
    return 'No team is ready to place yet'
  }
  if (unmapped === 0) {
    return `All ${overview.eligibleTeamCount} teams are placed`
  }
  return `${unmapped} ${unmapped === 1 ? 'team needs' : 'teams need'} a location`
}

function loadBand(teamCount: number, zoneTeamCount: number): 'empty' | 'some' | 'busy' {
  if (teamCount === 0) return 'empty'
  return teamCount * 9 >= zoneTeamCount * 2 ? 'busy' : 'some'
}

function newEditorLandmark(): LandmarkEditor {
  return {
    stableKey: `landmark_${crypto.randomUUID().replaceAll('-', '_')}`,
    name: '',
    x: '50',
    y: '50',
  }
}

function newEditorZone(): ZoneEditor {
  return {
    stableKey: `zone_${crypto.randomUUID().replaceAll('-', '_')}`,
    name: '',
    widthMeters: '20',
    depthMeters: '20',
    landmarks: [newEditorLandmark()],
  }
}

function toEditorZones(zones: ZoneInput[]): ZoneEditor[] {
  return zones.map((zone) => ({
    stableKey: zone.stableKey,
    name: zone.name,
    widthMeters: String(zone.widthMeters),
    depthMeters: String(zone.depthMeters),
    landmarks: zone.landmarks.map((landmark) => ({
      stableKey: landmark.stableKey,
      name: landmark.name,
      x: String(landmark.x),
      y: String(landmark.y),
    })),
  }))
}

function toZoneInputs(zones: ZoneEditor[]): ZoneInput[] {
  if (zones.length === 0) throw new Error('Add at least one hall zone.')
  return zones.map((zone, zoneIndex) => {
    if (zone.landmarks.length === 0) throw new Error(`${zone.name || `Zone ${zoneIndex + 1}`} needs a fixed landmark.`)
    return {
      stableKey: zone.stableKey,
      name: zone.name,
      widthMeters: boundedNumber(zone.widthMeters, `${zone.name || `Zone ${zoneIndex + 1}`} width`, 2, 300),
      depthMeters: boundedNumber(zone.depthMeters, `${zone.name || `Zone ${zoneIndex + 1}`} depth`, 2, 300),
      displayOrder: zoneIndex,
      landmarks: zone.landmarks.map((landmark, landmarkIndex) => ({
        stableKey: landmark.stableKey,
        name: landmark.name,
        x: boundedNumber(landmark.x, `${landmark.name || `Landmark ${landmarkIndex + 1}`} horizontal position`, 0, 100),
        y: boundedNumber(landmark.y, `${landmark.name || `Landmark ${landmarkIndex + 1}`} vertical position`, 0, 100),
        displayOrder: landmarkIndex,
      })),
    }
  })
}

function boundedNumber(value: string, label: string, minimum: number, maximum: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be from ${minimum} through ${maximum}.`)
  }
  return parsed
}

function previewDimension(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 2 ? Math.min(parsed, 300) : 20
}

function previewCoordinate(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : 50
}

function formatPreviewCoordinate(value: number) {
  return String(Math.round(value * 10) / 10)
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

function mapLabelAnchor(x: number): 'left' | 'center' | 'right' {
  if (x < 15) return 'left'
  if (x > 85) return 'right'
  return 'center'
}
