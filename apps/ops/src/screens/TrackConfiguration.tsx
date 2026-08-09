import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type FormEvent } from 'react'

import { ConfigurationTabs, type ConfigurationTabsVisibility } from '../components/ConfigurationTabs'
import { LoadingLabel, SkeletonCard, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type Configuration = FunctionReturnType<typeof api.intakeConfiguration.current>
type CatalogTrack = Configuration['publishedCatalog']['tracks'][number]
type TrackKind = CatalogTrack['type']

type EditorTrack = {
  clientId: string
  stableKey: string
  slug: string
  displayName: string
  description: string
  examples: string
  type: TrackKind
  eligibilityText: string
}

export function TrackConfiguration({
  tabs,
}: {
  tabs: ConfigurationTabsVisibility
}) {
  const configuration = useQuery(api.intakeConfiguration.current, { eventSlug })
  const createDraft = useMutation(api.intakeConfiguration.createDraft)
  const publish = useMutation(api.intakeConfiguration.publish)
  const validation = useQuery(
    api.intakeConfiguration.validateDraft,
    configuration?.canValidate && configuration.draftCatalog
      ? { eventSlug, draftCatalogId: configuration.draftCatalog.id }
      : 'skip',
  )
  const [tracks, setTracks] = useState<EditorTrack[]>([])
  const [loadedCatalog, setLoadedCatalog] = useState('')
  const [draftReason, setDraftReason] = useState('Updated for the published event tracks')
  const [publishReason, setPublishReason] = useState('Validated and approved for new project intakes')
  const [publishArmed, setPublishArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!configuration) return
    const catalog = configuration.draftCatalog ?? configuration.publishedCatalog
    const sourceKey = `${catalog.id}:${catalog.checksum}`
    if (sourceKey === loadedCatalog) return
    setTracks(catalog.tracks.map(toEditorTrack))
    setLoadedCatalog(sourceKey)
    setPublishArmed(false)
  }, [configuration, loadedCatalog])

  if (configuration === undefined) return (
      <section className="track-config-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading the tracks</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={4} />
      </section>
    )

  const updateTrack = (clientId: string, patch: Partial<EditorTrack>) => {
    setTracks((current) => current.map((track) => (
      track.clientId === clientId ? { ...track, ...patch } : track
    )))
  }

  const moveTrack = (clientId: string, offset: -1 | 1) => {
    setTracks((current) => {
      const sourceIndex = current.findIndex((track) => track.clientId === clientId)
      const source = current[sourceIndex]
      if (!source) return current
      const typeIndexes = current.flatMap((track, index) => track.type === source.type ? [index] : [])
      const typePosition = typeIndexes.indexOf(sourceIndex)
      const targetIndex = typeIndexes[typePosition + offset]
      if (targetIndex === undefined) return current
      const target = current[targetIndex]
      if (!target) return current
      const next = [...current]
      next[sourceIndex] = target
      next[targetIndex] = source
      return next
    })
  }

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createDraft({
        eventSlug,
        tracks: toTrackInputs(tracks),
        expectedEventVersion: configuration.eventVersion,
        ...(configuration.draftCatalog
          ? { expectedDraftCatalogId: configuration.draftCatalog.id }
          : {}),
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
    const draft = configuration.draftCatalog
    if (!draft || !validation?.valid) return
    setBusy(true)
    setError(null)
    try {
      await publish({
        eventSlug,
        draftCatalogId: draft.id,
        expectedDraftChecksum: draft.checksum,
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
    <section className="track-config-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading track-config-heading">
        <div>
          <p className="eyebrow">Participant intake</p>
          <h1>Tracks</h1>
          <p className="muted">
            New teams see the published tracks. Teams already writing keep their current list.
          </p>
        </div>
      </header>

      <dl className="catalog-summary">
        <div><dt>Status</dt><dd>Ready</dd></div>
        <div><dt>Tracks</dt><dd>{configuration.publishedCatalog.tracks.length}</dd></div>
        <div><dt>Teams writing</dt><dd>{configuration.publishedCatalog.activeDraftCount}</dd></div>
      </dl>

      {configuration.draftCatalog ? (
        <section className="catalog-review">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Draft changes</p>
              <h2>Before publishing</h2>
            </div>
            {configuration.canPublish && validation?.valid && !publishArmed ? (
              <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>
                Publish draft
              </button>
            ) : null}
          </div>

          {configuration.canValidate ? (
            validation === undefined ? (
              <p className="muted">Validating draft…</p>
            ) : (
              <>
                <ul className="catalog-change-list">
                  {validation.changes.map((change) => <li key={change}>{change}</li>)}
                </ul>
                {validation.issues.length > 0 ? (
                  <ul className="catalog-issue-list">
                    {validation.issues.map((issue) => <li key={issue}>{issue}</li>)}
                  </ul>
                ) : (
                  <p className="notice">
                    Ready to publish. {validation.pinnedParticipantDraftCount} active participant {validation.pinnedParticipantDraftCount === 1 ? 'draft keeps' : 'drafts keep'} the current track list.
                  </p>
                )}
              </>
            )
          ) : (
            <p className="notice">You do not have permission to check or publish this draft.</p>
          )}
        </section>
      ) : null}

      {configuration.draftCatalog && configuration.canPublish && validation?.valid && publishArmed ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish this track list?</h2>
          <p className="muted">
            New participant drafts use it immediately. Teams already writing keep their current track list.
          </p>
          <label className="field">
            <span>Why this changed</span>
            <textarea required value={publishReason} onChange={(event) => setPublishReason(event.target.value)} />
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy || publishReason.trim().length < 5} type="button" onClick={() => void publishDraft()}>
              {busy ? 'Publishing…' : 'Publish tracks'}
            </button>
            <button className="secondary" disabled={busy} type="button" onClick={() => setPublishArmed(false)}>Cancel</button>
          </div>
        </section>
      ) : null}

      {configuration.canDraft ? (
        <form className="track-editor" onSubmit={saveDraft}>
          <div className="track-editor-heading">
            <div>
              <p className="eyebrow">{configuration.draftCatalog ? 'Replace current draft' : 'Create a draft'}</p>
              <h2>Tracks</h2>
              <p className="muted">Keep exactly five core tracks. Sponsor tracks are optional.</p>
            </div>
            <button
              className="secondary"
              disabled={tracks.length >= 15}
              title={tracks.length >= 15 ? 'Fifteen tracks is the most a team can be asked to read through.' : undefined}
              type="button"
              onClick={() => setTracks((current) => [...current, newSponsorTrack()])}
            >
              Add sponsor track
            </button>
          </div>

          <div className="track-card-list">
            {tracks.map((track, index) => {
              const peers = tracks.filter((candidate) => candidate.type === track.type)
              const peerIndex = peers.findIndex((candidate) => candidate.clientId === track.clientId)
              return (
                <article className="track-card" key={track.clientId}>
                  <header className="track-card-heading">
                    <div>
                      <span>{track.type === 'core' ? 'Core track' : 'Sponsor track'} {peerIndex + 1}</span>
                      <strong>{track.displayName || `Track ${index + 1}`}</strong>
                    </div>
                    <div className="track-order-actions">
                      <button aria-label={`Move ${track.displayName || 'track'} up`} className="text-button" disabled={peerIndex === 0} type="button" onClick={() => moveTrack(track.clientId, -1)}>Up</button>
                      <button aria-label={`Move ${track.displayName || 'track'} down`} className="text-button" disabled={peerIndex === peers.length - 1} type="button" onClick={() => moveTrack(track.clientId, 1)}>Down</button>
                      {track.type === 'sponsor' ? (
                        <button className="text-button" type="button" onClick={() => setTracks((current) => current.filter((candidate) => candidate.clientId !== track.clientId))}>Remove</button>
                      ) : null}
                    </div>
                  </header>
                  <div className="track-field-grid">
                    <label className="field"><span>Name</span><input required value={track.displayName} onChange={(event) => updateTrack(track.clientId, { displayName: event.target.value })} /></label>
                  </div>
                  <label className="field"><span>Description</span><textarea required value={track.description} onChange={(event) => updateTrack(track.clientId, { description: event.target.value })} /></label>
                  <label className="field"><span>Examples <small>One per line, up to four</small></span><textarea required className="track-examples" value={track.examples} onChange={(event) => updateTrack(track.clientId, { examples: event.target.value })} /></label>
                  {track.type === 'sponsor' ? (
                    <label className="field"><span>Eligibility</span><textarea required className="track-eligibility" value={track.eligibilityText} onChange={(event) => updateTrack(track.clientId, { eligibilityText: event.target.value })} /></label>
                  ) : null}
                </article>
              )
            })}
          </div>

          <section className="track-save">
            <label className="field"><span>Why this changed</span><textarea required value={draftReason} onChange={(event) => setDraftReason(event.target.value)} /></label>
            {tracks.length < 5 ? (
              <p className="notice">
                Teams choose one core track, and the event runs five of them. You have {tracks.length}
                {tracks.length === 1 ? ' track' : ' tracks'} — add {5 - tracks.length} more before saving a draft.
              </p>
            ) : null}
            <button className="primary" disabled={busy} type="submit">
              {busy ? 'Saving…' : configuration.draftCatalog ? 'Replace draft' : 'Save draft'}
            </button>
          </section>
        </form>
      ) : null}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function toEditorTrack(track: CatalogTrack): EditorTrack {
  return {
    clientId: track.id,
    stableKey: track.stableKey,
    slug: track.slug,
    displayName: track.displayName,
    description: track.description,
    examples: track.examples.join('\n'),
    type: track.type,
    eligibilityText: track.eligibilityText ?? '',
  }
}

function toTrackInputs(tracks: readonly EditorTrack[]) {
  const positions: Record<TrackKind, number> = { core: 0, sponsor: 0 }
  return tracks.map((track) => {
    const displayOrder = positions[track.type]
    positions[track.type] += 1
    const examples = track.examples.split('\n').map((example) => example.trim()).filter(Boolean)
    const generated = generatedTrackIdentifiers(track.displayName, track.type, displayOrder)
    return {
      stableKey: track.stableKey || generated.stableKey,
      slug: track.slug || generated.slug,
      displayName: track.displayName,
      description: track.description,
      examples,
      displayOrder,
      type: track.type,
      ...(track.eligibilityText.trim() ? { eligibilityText: track.eligibilityText } : {}),
    }
  })
}

function generatedTrackIdentifiers(displayName: string, type: TrackKind, displayOrder: number) {
  const words = displayName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const keyBase = words.join('_').slice(0, 42) || 'track'
  const slugBase = words.join('-').slice(0, 42) || 'track'
  const position = displayOrder + 1
  return {
    stableKey: `${type}_${position}_${keyBase}`.slice(0, 60).replace(/_+$/u, ''),
    slug: `${type}-${position}-${slugBase}`.slice(0, 60).replace(/-+$/u, ''),
  }
}

function newSponsorTrack(): EditorTrack {
  return {
    clientId: crypto.randomUUID(),
    stableKey: '',
    slug: '',
    displayName: '',
    description: '',
    examples: '',
    type: 'sponsor',
    eligibilityText: '',
  }
}
