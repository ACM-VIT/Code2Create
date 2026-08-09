import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type FormEvent } from 'react'

import { ConfigurationTabs, type ConfigurationTabsVisibility } from '../components/ConfigurationTabs'
import { Link } from 'react-router-dom'

import { LoadingLabel, SkeletonCard, SkeletonLine, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type Configuration = FunctionReturnType<typeof api.checkpointConfiguration.current>
type Plan = NonNullable<Configuration['publishedPlan']>
type Definition = Plan['definitions'][number]

type EditorDefinition = {
  checkpointKey: Definition['checkpointKey']
  phaseKey: Definition['phaseKey']
  displayName: string
  prompt: string
  followUpQuestion: string
  graceMinutes: number
}

const defaults = [
  {
    checkpointKey: 'ideation',
    phaseKey: 'ideation',
    displayName: 'Ideation update',
    prompt: 'What changed about your idea after exploring it?',
    followUpQuestion: 'What are you building first, and why?',
    graceMinutes: 240,
  },
  {
    checkpointKey: 'intermediate_update',
    phaseKey: 'intermediate_update',
    displayName: 'Intermediate update',
    prompt: 'What has your team built or learned since the last update?',
    followUpQuestion: 'What is the next concrete thing your team will finish?',
    graceMinutes: 120,
  },
  {
    checkpointKey: 'final_update',
    phaseKey: 'final_update',
    displayName: 'Final update',
    prompt: 'What did your team finish?',
    followUpQuestion: 'What should someone try or look at first?',
    graceMinutes: 60,
  },
] as const satisfies readonly EditorDefinition[]

export function CheckpointConfiguration({
  tabs,
}: {
  tabs: ConfigurationTabsVisibility
}) {
  const configuration = useQuery(api.checkpointConfiguration.current, { eventSlug })
  const createDraft = useMutation(api.checkpointConfiguration.createDraft)
  const publish = useMutation(api.checkpointConfiguration.publish)
  const validation = useQuery(
    api.checkpointConfiguration.validateDraft,
    configuration?.canValidate && configuration.draftPlan
      ? { eventSlug, draftPlanId: configuration.draftPlan.id }
      : 'skip',
  )
  const [definitions, setDefinitions] = useState<EditorDefinition[]>([])
  const [loadedPlan, setLoadedPlan] = useState('')
  const [draftReason, setDraftReason] = useState('Aligned with the participant event flow')
  const [publishReason, setPublishReason] = useState('Checked against the published event phases')
  const [publishArmed, setPublishArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!configuration) return
    const plan = configuration.draftPlan ?? configuration.publishedPlan
    const sourceKey = plan ? `${plan.id}:${plan.checksum}` : 'empty'
    if (sourceKey === loadedPlan) return
    setDefinitions(
      plan
        ? plan.definitions.map((definition) => ({
            checkpointKey: definition.checkpointKey,
            phaseKey: definition.phaseKey,
            displayName: definition.displayName,
            prompt: definition.prompt,
            followUpQuestion: definition.followUpQuestion,
            graceMinutes: definition.graceMinutes,
          }))
        : defaults.map((definition) => ({ ...definition })),
    )
    setLoadedPlan(sourceKey)
    setPublishArmed(false)
  }, [configuration, loadedPlan])

  if (configuration === undefined) return (
      <section className="intake-policy-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading the checkpoints</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={4} />
      </section>
    )

  const updateDefinition = (
    checkpointKey: EditorDefinition['checkpointKey'],
    patch: Partial<EditorDefinition>,
  ) => {
    setDefinitions((current) => current.map((definition) => (
      definition.checkpointKey === checkpointKey ? { ...definition, ...patch } : definition
    )))
  }

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createDraft({
        eventSlug,
        definitions,
        expectedEventVersion: configuration.eventVersion,
        ...(configuration.draftPlan ? { expectedDraftPlanId: configuration.draftPlan.id } : {}),
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
    const draft = configuration.draftPlan
    if (!draft || !validation?.valid) return
    setBusy(true)
    setError(null)
    try {
      await publish({
        eventSlug,
        draftPlanId: draft.id,
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
          <p className="eyebrow">Participant flow</p>
          <h1>Team update prompts</h1>
          <p className="muted">
            Three short team updates. Timing comes from the published phases; grace keeps a missed due time recoverable.
          </p>
        </div>
      </header>

      <dl className="catalog-summary phase-summary">
        <div><dt>Status</dt><dd>{configuration.publishedPlan ? 'Ready' : 'Not published'}</dd></div>
        <div><dt>Event schedule</dt><dd>{configuration.hasPublishedPhaseSchedule ? 'Ready' : 'Missing'}</dd></div>
        <div><dt>Updates</dt><dd>3</dd></div>
      </dl>

      {configuration.publishedPlan ? (
        <ol className="published-phase-list">
          {configuration.publishedPlan.definitions.map((definition) => (
            <li key={definition.checkpointKey}>
              <div><strong>{definition.displayName}</strong><span>{definition.prompt}</span></div>
              <span>{definition.graceMinutes} min grace</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="notice">No checkpoint plan is participant-visible yet.</p>
      )}

      {configuration.draftPlan ? (
        <section className="catalog-review">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Draft changes</p>
              <h2>Before publishing</h2>
            </div>
            {configuration.canPublish && validation?.valid && !publishArmed ? (
              <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>
                Review publication
              </button>
            ) : null}
          </div>
          {validation === undefined && configuration.canValidate ? <SkeletonLine width="40%" /> : null}
          {validation && !validation.valid ? (
            <ul className="issue-list">{validation.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
          ) : null}
          {validation?.valid ? <p className="notice">The complete checkpoint plan is valid.</p> : null}
          {publishArmed ? (
            <div className="publish-confirmation">
              <p>New team updates will use this wording. Teams already writing keep their current questions.</p>
              <label className="field">
                <span>Why this changed</span>
                <textarea required value={publishReason} onChange={(event) => setPublishReason(event.target.value)} />
              </label>
              {configuration.hasPublishedPhaseSchedule ? null : (
                <p className="notice">
                  Team updates are due at the end of a phase, so the schedule has to be published
                  first. <Link to="/configuration/phases">Publish the schedule</Link>, then come back.
                </p>
              )}
              <div className="offer-actions">
                <button className="secondary" disabled={busy} type="button" onClick={() => setPublishArmed(false)}>Cancel</button>
                {configuration.hasPublishedPhaseSchedule ? (
                  <button className="primary" disabled={busy} type="button" onClick={() => void publishDraft()}>
                    {busy ? 'Publishing…' : 'Publish team updates'}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {configuration.canDraft ? (
        <form className="phase-editor" onSubmit={saveDraft}>
          <div className="track-editor-heading">
            <div>
              <p className="eyebrow">{configuration.draftPlan ? 'Replace current draft' : 'Create a draft'}</p>
              <h2>Questions</h2>
            </div>
          </div>
          <div className="phase-card-list">
            {definitions.map((definition) => (
              <article className="phase-card" key={definition.checkpointKey}>
                <header>
                  <strong>{definition.displayName}</strong>
                </header>
                <div className="phase-field-grid">
                  <label className="field">
                    <span>Name</span>
                    <input required value={definition.displayName} onChange={(event) => updateDefinition(definition.checkpointKey, { displayName: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>Grace after phase end · minutes</span>
                    <input min={0} max={1440} required type="number" value={definition.graceMinutes} onChange={(event) => updateDefinition(definition.checkpointKey, { graceMinutes: event.target.valueAsNumber })} />
                  </label>
                </div>
                <label className="field">
                  <span>First question</span>
                  <textarea required value={definition.prompt} onChange={(event) => updateDefinition(definition.checkpointKey, { prompt: event.target.value })} />
                </label>
                <label className="field">
                  <span>Short reflection</span>
                  <textarea required value={definition.followUpQuestion} onChange={(event) => updateDefinition(definition.checkpointKey, { followUpQuestion: event.target.value })} />
                </label>
              </article>
            ))}
          </div>
          <section className="track-save">
            <label className="field">
              <span>Why this changed</span>
              <textarea required value={draftReason} onChange={(event) => setDraftReason(event.target.value)} />
            </label>
            {definitions.length === 3 ? null : (
              <p className="notice">
                A draft needs all three checkpoints — ideation, the intermediate update and the
                final update. {definitions.length} {definitions.length === 1 ? 'is' : 'are'} filled in.
              </p>
            )}
            <button className="primary" disabled={busy} type="submit">
              {busy ? 'Saving…' : configuration.draftPlan ? 'Replace draft' : 'Save draft'}
            </button>
          </section>
        </form>
      ) : null}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}
