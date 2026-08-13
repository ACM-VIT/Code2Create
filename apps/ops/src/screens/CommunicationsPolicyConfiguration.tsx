import { api } from '@code2create/backend/api'
import { TZDateMini } from '@date-fns/tz'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type FormEvent } from 'react'

import { ConfigurationTabs, type ConfigurationTabsVisibility } from '../components/ConfigurationTabs'
import { LoadingLabel, SkeletonCard, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'

type Configuration = FunctionReturnType<typeof api.communicationsPolicyConfiguration.current>
type Policy = Configuration['publishedPolicy']['policy']
type NextStep = Policy['nextSteps'][number]
type EditorStep = Omit<NextStep, 'dueAt'> & { dueAt: string }
type EditorPolicy = Omit<Policy, 'nextSteps'> & { nextSteps: EditorStep[] }

export function CommunicationsPolicyConfiguration({
  tabs,
}: {
  tabs: ConfigurationTabsVisibility
}) {
  const configuration = useQuery(api.communicationsPolicyConfiguration.current, { eventSlug })
  const createDraft = useMutation(api.communicationsPolicyConfiguration.createDraft)
  const publish = useMutation(api.communicationsPolicyConfiguration.publish)
  const operations = useOperationRunner()
  const validation = useQuery(
    api.communicationsPolicyConfiguration.validateDraft,
    configuration?.canValidate && configuration.draftPolicy
      ? { eventSlug, draftPolicyId: configuration.draftPolicy.id }
      : 'skip',
  )
  const [policy, setPolicy] = useState<EditorPolicy | null>(null)
  const [loadedPolicy, setLoadedPolicy] = useState('')
  const [draftReason, setDraftReason] = useState('')
  const [publishReason, setPublishReason] = useState('')
  const [publishArmed, setPublishArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draftPending = operations.hasPending('communications-policy-draft')
  const publishPending = operations.hasPending('communications-policy-publish')

  useEffect(() => {
    if (!configuration) return
    const source = configuration.draftPolicy ?? configuration.publishedPolicy
    const sourceKey = `${source.id}:${source.checksum}`
    if (sourceKey === loadedPolicy) return
    setPolicy(toEditorPolicy(source.policy, configuration.timezone))
    setLoadedPolicy(sourceKey)
    setPublishArmed(false)
  }, [configuration, loadedPolicy])

  if (configuration === undefined || policy === null) {
    return (
      <section className="intake-policy-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading what accepted teams are told</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={4} />
      </section>
    )
  }

  const updatePolicy = <Key extends keyof EditorPolicy>(key: Key, value: EditorPolicy[Key]) => {
    setPolicy((current) => current ? { ...current, [key]: value } : current)
  }

  const updateStep = (index: number, patch: Partial<EditorStep>) => {
    updatePolicy('nextSteps', policy.nextSteps.map((step, stepIndex) => (
      stepIndex === index ? { ...step, ...patch } : step
    )))
  }

  const updateStepActionUrl = (index: number, actionUrl: string) => {
    updatePolicy('nextSteps', policy.nextSteps.map((step, stepIndex) => {
      if (stepIndex !== index) return step
      if (actionUrl) return { ...step, actionUrl }
      const { actionUrl: _removed, ...withoutActionUrl } = step
      return withoutActionUrl
    }))
  }

  const addStep = () => {
    updatePolicy('nextSteps', [
      ...policy.nextSteps,
      {
        stableKey: `next_step_${policy.nextSteps.length + 1}`,
        title: '',
        detail: '',
        dueAt: '',
      },
    ])
  }

  const removeStep = (index: number) => {
    updatePolicy('nextSteps', policy.nextSteps.filter((_, stepIndex) => stepIndex !== index))
  }

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await operations.run('communications-policy-draft', (clientOperationId) => () => createDraft({
        eventSlug,
        policy: fromEditorPolicy(policy, configuration.timezone),
        expectedEventVersion: configuration.eventVersion,
        ...(configuration.draftPolicy
          ? { expectedDraftPolicyId: configuration.draftPolicy.id }
          : {}),
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
    const draft = configuration.draftPolicy
    if (!draft || !validation?.valid) return
    setBusy(true)
    setError(null)
    try {
      await operations.run('communications-policy-publish', (clientOperationId) => () => publish({
        eventSlug,
        draftPolicyId: draft.id,
        expectedDraftChecksum: draft.checksum,
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

  return (
    <section className="track-config-shell intake-policy-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading track-config-heading">
        <div>
          <h1>Accepted team details</h1>
          <p className="muted">Controls the venue, next steps, Discord link, and email wording.</p>
        </div>
      </header>

      <dl className="catalog-summary">
        <div><dt>Status</dt><dd>Ready</dd></div>
        <div><dt>Venue</dt><dd>{configuration.publishedPolicy.policy.venueName}</dd></div>
        <div>
          <dt>Event window</dt>
          <dd>{formatWindow(
            configuration.publishedPolicy.policy.startsAt,
            configuration.publishedPolicy.policy.endsAt,
            configuration.timezone,
          )}</dd>
        </div>
      </dl>

      {configuration.draftPolicy ? (
        <section className="catalog-review">
          <div className="section-heading">
            <div>
              <p className="muted">Draft changes</p>
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
                  <p className="notice">Ready to publish. Queued email keeps its current wording.</p>
                )}
              </>
            )
          ) : (
            <p className="notice">You do not have permission to check this draft.</p>
          )}
        </section>
      ) : null}

      {configuration.draftPolicy && configuration.canPublish && validation?.valid && publishArmed ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish these accepted-team details?</h2>
          <p className="muted">Accepted and offer-stage teams see the changes immediately.</p>
          <label className="field">
            <span>Why this changed</span>
            <textarea disabled={publishPending} required value={publishReason} onChange={(event) => setPublishReason(event.currentTarget.value)} />
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy || publishReason.trim().length < 5} type="button" onClick={() => void publishDraft()}>
              {busy ? 'Publishing…' : publishPending ? 'Confirm earlier publication' : 'Publish details'}
            </button>
            <button className="secondary" disabled={busy || publishPending} type="button" onClick={() => setPublishArmed(false)}>Cancel</button>
          </div>
        </section>
      ) : null}

      {configuration.canDraft ? (
        <form className="track-editor intake-policy-editor" onSubmit={saveDraft}>
          <fieldset disabled={draftPending} style={{ display: 'contents' }}>
          <PolicySection title="Event details" description="Dates follow the event window and cannot be changed here.">
            <div className="intake-policy-grid">
              <label className="field">
                <span>Venue name</span>
                <input required minLength={2} maxLength={120} value={policy.venueName} onChange={(event) => updatePolicy('venueName', event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Venue address</span>
                <input maxLength={300} value={policy.venueAddress ?? ''} onChange={(event) => updatePolicy('venueAddress', event.currentTarget.value || undefined)} />
              </label>
              <label className="field">
                <span>Map URL</span>
                <input type="url" value={policy.venueMapUrl ?? ''} onChange={(event) => updatePolicy('venueMapUrl', event.currentTarget.value || undefined)} />
              </label>
              <label className="field">
                <span>Event window</span>
                <input disabled value={formatWindow(policy.startsAt, policy.endsAt, configuration.timezone)} />
              </label>
            </div>
          </PolicySection>

          <PolicySection title="Next steps" description="Shown in this order to accepted and offer-stage teams.">
            <div className="communications-step-list">
              {policy.nextSteps.map((step, index) => (
                <fieldset className="communications-step" key={`${step.stableKey}:${index}`}>
                  <legend>Step {index + 1}</legend>
                  <div className="intake-policy-grid">
                    <label className="field">
                      <span>Title</span>
                      <input required minLength={2} maxLength={80} value={step.title} onChange={(event) => updateStep(index, { title: event.currentTarget.value })} />
                    </label>
                    <label className="field field-wide">
                      <span>Detail</span>
                      <textarea required minLength={5} maxLength={300} value={step.detail} onChange={(event) => updateStep(index, { detail: event.currentTarget.value })} />
                    </label>
                    <label className="field">
                      <span>Action URL</span>
                      <input value={step.actionUrl ?? ''} onChange={(event) => updateStepActionUrl(index, event.currentTarget.value)} />
                    </label>
                    <label className="field">
                      <span>Due time</span>
                      <input type="datetime-local" value={step.dueAt} onChange={(event) => updateStep(index, { dueAt: event.currentTarget.value })} />
                    </label>
                  </div>
                  {policy.nextSteps.length > 1 ? (
                    <button className="text-button" type="button" onClick={() => removeStep(index)}>Remove step</button>
                  ) : null}
                </fieldset>
              ))}
            </div>
            {policy.nextSteps.length < 8 ? <button className="secondary" type="button" onClick={addStep}>Add step</button> : null}
          </PolicySection>

          <PolicySection title="Discord" description="This link is returned only to accepted and offer-stage teams.">
            <div className="intake-policy-grid">
              <label className="field">
                <span>Invite URL</span>
                <input required type="url" value={policy.discordUrl} onChange={(event) => updatePolicy('discordUrl', event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Button label</span>
                <input required minLength={2} maxLength={60} value={policy.discordLabel} onChange={(event) => updatePolicy('discordLabel', event.currentTarget.value)} />
              </label>
            </div>
          </PolicySection>

          <PolicySection title="Verified email" description="The message stays generic. Details live in the portal.">
            <div className="intake-policy-grid">
              <label className="field">
                <span>Provider</span>
                <input disabled value="Cloudflare Email Service" />
              </label>
              <label className="field">
                <span>Subject</span>
                <input required minLength={5} maxLength={120} value={policy.notificationSubject} onChange={(event) => updatePolicy('notificationSubject', event.currentTarget.value)} />
              </label>
              <label className="field field-wide">
                <span>Introduction</span>
                <textarea required minLength={10} maxLength={300} value={policy.notificationIntro} onChange={(event) => updatePolicy('notificationIntro', event.currentTarget.value)} />
              </label>
            </div>
          </PolicySection>

          </fieldset>
          <section className="track-save">
            <label className="field">
              <span>Why this changed</span>
              <textarea disabled={draftPending} required value={draftReason} onChange={(event) => setDraftReason(event.currentTarget.value)} />
            </label>
            <button className="primary" disabled={busy || draftReason.trim().length < 5} type="submit">
              {busy ? 'Saving…' : draftPending ? 'Confirm earlier draft' : configuration.draftPolicy ? 'Replace draft' : 'Save draft'}
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

function toEditorPolicy(policy: Policy, timezone: string): EditorPolicy {
  return {
    ...policy,
    nextSteps: policy.nextSteps.map((step) => ({
      ...step,
      dueAt: step.dueAt === undefined ? '' : timestampInput(step.dueAt, timezone),
    })),
  }
}

function fromEditorPolicy(policy: EditorPolicy, timezone: string): Policy {
  return {
    ...policy,
    nextSteps: policy.nextSteps.map((step) => {
      const { dueAt, ...fields } = step
      return {
        ...fields,
        ...(dueAt ? { dueAt: zonedTimestamp(dueAt, timezone, `${step.title || step.stableKey} due time`) } : {}),
      }
    }),
  }
}

function timestampInput(timestamp: number, timezone: string) {
  const date = new TZDateMini(timestamp, timezone)
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-') +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
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
  const date = new TZDateMini(year, month - 1, day, hour, minute, timezone)
  if (
    !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    throw new Error(`${label} is not a valid local time in ${timezone}.`)
  }
  return date.getTime()
}

function formatWindow(startsAt: number, endsAt: number, timezone: string) {
  const format = new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  return `${format.format(startsAt)} – ${format.format(endsAt)}`
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}
