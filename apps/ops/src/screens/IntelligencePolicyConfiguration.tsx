import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'

import { ConfigurationTabs, type ConfigurationTabsVisibility } from '../components/ConfigurationTabs'
import { LoadingLabel, SkeletonCard, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type Configuration = FunctionReturnType<typeof api.operationsIntelligencePolicyConfiguration.current>
type Policy = Configuration['publishedPolicy']['policy']
type Severity = Policy['triggerSeverities'][number]
type Area = Policy['triggerAreas'][number]

const severityOptions = ['critical', 'attention', 'watch'] satisfies readonly Severity[]
const areaOptions = [
  'system',
  'intake',
  'admissions',
  'attendance',
  'reviews',
  'communications',
  'integrations',
  'scores',
  'synesthesia',
] satisfies readonly Area[]

export function IntelligencePolicyConfiguration({
  tabs,
}: {
  tabs: ConfigurationTabsVisibility
}) {
  const configuration = useQuery(api.operationsIntelligencePolicyConfiguration.current, { eventSlug })
  const createDraft = useMutation(api.operationsIntelligencePolicyConfiguration.createDraft)
  const publish = useMutation(api.operationsIntelligencePolicyConfiguration.publish)
  const validation = useQuery(
    api.operationsIntelligencePolicyConfiguration.validateDraft,
    configuration?.canValidate && configuration.draftPolicy
      ? { eventSlug, draftPolicyId: configuration.draftPolicy.id }
      : 'skip',
  )
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [loadedPolicy, setLoadedPolicy] = useState('')
  const [draftReason, setDraftReason] = useState('')
  const [publishReason, setPublishReason] = useState('')
  const [publishArmed, setPublishArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!configuration) return
    const source = configuration.draftPolicy ?? configuration.publishedPolicy
    const sourceKey = `${source.id}:${source.checksum}`
    if (sourceKey === loadedPolicy) return
    setPolicy(clonePolicy(source.policy))
    setLoadedPolicy(sourceKey)
    setPublishArmed(false)
  }, [configuration, loadedPolicy])

  if (configuration === undefined || policy === null) {
    return (
      <section className="intake-policy-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading the operations brief settings</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={4} />
      </section>
    )
  }

  const updatePolicy = <Key extends keyof Policy>(key: Key, value: Policy[Key]) => {
    setPolicy((current) => current ? { ...current, [key]: value } : current)
  }

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createDraft({
        eventSlug,
        policy,
        expectedEventVersion: configuration.eventVersion,
        ...(configuration.draftPolicy
          ? { expectedDraftPolicyId: configuration.draftPolicy.id }
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
    const draft = configuration.draftPolicy
    if (!draft || !validation?.valid) return
    setBusy(true)
    setError(null)
    try {
      await publish({
        eventSlug,
        draftPolicyId: draft.id,
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
    <section className="track-config-shell intake-policy-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading track-config-heading">
        <div>
          <p className="eyebrow">Event setup</p>
          <h1>Operations briefs</h1>
          <p className="muted">
            Create a short brief when something important changes. A brief can suggest a next step, but it cannot change the event.
          </p>
        </div>
      </header>

      <dl className="catalog-summary">
        <div><dt>Setup</dt><dd>Ready</dd></div>
        <div><dt>Automatic briefs</dt><dd>{configuration.publishedPolicy.policy.enabled ? 'On' : 'Off'}</dd></div>
        <div>
          <dt>Today</dt>
          <dd>{configuration.automation?.briefsStartedToday ?? 0} of {configuration.publishedPolicy.policy.maximumBriefsPerLocalDay}</dd>
        </div>
      </dl>

      {configuration.draftPolicy ? (
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
                  <p className="notice">Ready to publish. The new rules apply together.</p>
                )}
              </>
            )
          ) : (
            <p className="notice">You do not have permission to check or publish this draft.</p>
          )}
        </section>
      ) : null}

      {configuration.draftPolicy && configuration.canPublish && validation?.valid && publishArmed ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish these operations brief rules?</h2>
          <p className="muted">
            These rules replace the current ones immediately. Existing briefs remain in the dashboard.
          </p>
          <label className="field">
            <span>Why this changed</span>
            <textarea required value={publishReason} onChange={(event) => setPublishReason(event.target.value)} />
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy || publishReason.trim().length < 5} type="button" onClick={() => void publishDraft()}>
              {busy ? 'Publishing…' : 'Publish policy'}
            </button>
            <button className="secondary" disabled={busy} type="button" onClick={() => setPublishArmed(false)}>Cancel</button>
          </div>
        </section>
      ) : null}

      {configuration.canDraft ? (
        <form className="track-editor intake-policy-editor" onSubmit={saveDraft}>
          <PolicySection
            title="When to create a brief"
            description="A selected kind of problem must change before the system creates another brief."
          >
            <label className="intelligence-enable">
              <input
                checked={policy.enabled}
                type="checkbox"
                onChange={(event) => updatePolicy('enabled', event.currentTarget.checked)}
              />
              <span>Create operations briefs automatically</span>
            </label>
            <ChoiceSet
              label="Problem level"
              options={severityOptions}
              values={policy.triggerSeverities}
              onChange={(values) => updatePolicy('triggerSeverities', values)}
            />
            <ChoiceSet
              label="Event areas"
              options={areaOptions}
              values={policy.triggerAreas}
              onChange={(values) => updatePolicy('triggerAreas', values)}
            />
          </PolicySection>

          <PolicySection
            title="Repeat limits"
            description="Keep repeated briefs useful and bounded during a busy event."
          >
            <div className="intake-policy-number-grid">
              <NumberField label="Wait between briefs · minutes" min={15} max={360} value={policy.cooldownMinutes} onChange={(value) => updatePolicy('cooldownMinutes', value)} />
              <NumberField label="Maximum briefs per day" min={1} max={24} value={policy.maximumBriefsPerLocalDay} onChange={(value) => updatePolicy('maximumBriefsPerLocalDay', value)} />
              <NumberField label="Keep each brief current · minutes" min={15} max={240} value={policy.relevanceMinutes} onChange={(value) => updatePolicy('relevanceMinutes', value)} />
            </div>
          </PolicySection>

          <PolicySection
            title="Owner"
            description="Briefs appear only to operations staff who have permission to read them."
          >
            <div className="intake-policy-grid">
              <label className="field">
                <span>Responsible team or person</span>
                <input required minLength={2} maxLength={80} value={policy.accountableOwner} onChange={(event) => updatePolicy('accountableOwner', event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Audience</span>
                <input disabled value="Operations dashboard" />
              </label>
            </div>
          </PolicySection>

          <section className="track-save">
            <label className="field">
              <span>Why this changed</span>
              <textarea required value={draftReason} onChange={(event) => setDraftReason(event.currentTarget.value)} />
            </label>
            <button className="primary" disabled={busy || draftReason.trim().length < 5} type="submit">
              {busy ? 'Saving…' : configuration.draftPolicy ? 'Replace draft' : 'Save draft'}
            </button>
          </section>
        </form>
      ) : null}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function PolicySection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="intake-policy-section">
      <header><h2>{title}</h2><p className="muted">{description}</p></header>
      {children}
    </section>
  )
}

function ChoiceSet<Value extends string>({
  label,
  options,
  values,
  onChange,
}: {
  label: string
  options: readonly Value[]
  values: Value[]
  onChange: (values: Value[]) => void
}) {
  return (
    <fieldset className="intelligence-choice-set">
      <legend>{label}</legend>
      <div className="intake-purpose-list">
        {options.map((option) => (
          <label key={option}>
            <input
              checked={values.includes(option)}
              disabled={values.length === 1 && values.includes(option)}
              type="checkbox"
              onChange={(event) => onChange(toggleValue(values, option, event.currentTarget.checked))}
            />
            <span>{humanize(option)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function NumberField({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string
  min: number
  max: number
  value: number
  onChange: (value: number) => void
}) {
  const update = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.currentTarget.valueAsNumber
    if (Number.isSafeInteger(next)) onChange(next)
  }
  return (
    <label className="field">
      <span>{label}</span>
      <input max={max} min={min} required type="number" value={value} onChange={update} />
    </label>
  )
}

function toggleValue<Value>(values: Value[], value: Value, selected: boolean) {
  if (selected) return values.includes(value) ? values : [...values, value]
  return values.filter((candidate) => candidate !== value)
}

function clonePolicy(policy: Policy): Policy {
  return {
    ...policy,
    triggerSeverities: [...policy.triggerSeverities],
    triggerAreas: [...policy.triggerAreas],
  }
}

function humanize(value: string) {
  const labels: Readonly<Record<string, string>> = {
    admissions: 'Applications',
    attention: 'Needs attention',
    attendance: 'Check-in and presence',
    communications: 'Participant messages',
    critical: 'Urgent',
    intake: 'Project intake',
    integrations: 'Code and design',
    reviews: 'Judging',
    scores: 'Results',
    synesthesia: 'Music desk',
    system: 'Platform',
    watch: 'Watch',
  }
  const label = labels[value] ?? value.replaceAll('_', ' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}
