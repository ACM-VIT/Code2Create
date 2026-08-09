import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

import { ConfigurationTabs, type ConfigurationTabsVisibility } from '../components/ConfigurationTabs'
import { LoadingLabel, SkeletonCard, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type Configuration = FunctionReturnType<typeof api.participantPolicyConfiguration.current>
type Policy = Configuration['publishedPolicy']['policy']
type FieldMode = Policy['phoneField']

const fieldModes: { value: FieldMode; label: string }[] = [
  { value: 'not_collected', label: 'Do not collect' },
  { value: 'optional', label: 'Optional' },
  { value: 'required', label: 'Required' },
]

export function ParticipantPolicyConfiguration({
  tabs,
}: {
  tabs: ConfigurationTabsVisibility
}) {
  const configuration = useQuery(api.participantPolicyConfiguration.current, { eventSlug })
  const createDraft = useMutation(api.participantPolicyConfiguration.createDraft)
  const publish = useMutation(api.participantPolicyConfiguration.publish)
  const validation = useQuery(
    api.participantPolicyConfiguration.validateDraft,
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
    setPolicy(source.policy)
    setLoadedPolicy(sourceKey)
    setPublishArmed(false)
  }, [configuration, loadedPolicy])

  if (configuration === undefined || policy === null) {
    return (
      <section className="intake-policy-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading the participant form</LoadingLabel>
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
          <h1>Participant form</h1>
          <p className="muted">Controls profile collection, team eligibility, consent text, and the final lock warning.</p>
        </div>
      </header>

      <dl className="catalog-summary">
        <div><dt>Status</dt><dd>Ready</dd></div>
        <div><dt>Team size</dt><dd>{configuration.publishedPolicy.policy.teamMinimumSize}–{configuration.publishedPolicy.policy.teamMaximumSize}</dd></div>
        <div><dt>Mixed teams</dt><dd>{configuration.publishedPolicy.policy.mixedParticipantClassesAllowed ? 'Allowed' : 'Not allowed'}</dd></div>
      </dl>

      {configuration.draftPolicy ? (
        <section className="catalog-review">
          <div className="section-heading">
            <div><p className="muted">Draft changes</p><h2>Before publishing</h2></div>
            {configuration.canPublish && validation?.valid && !publishArmed ? (
              <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>Review publication</button>
            ) : null}
          </div>
          {configuration.canValidate ? (
            validation === undefined ? <p className="muted">Validating draft…</p> : (
              <>
                <ul className="catalog-change-list">
                  {validation.changes.map((change) => <li key={change}>{change}</li>)}
                </ul>
                {validation.issues.length > 0 ? (
                  <ul className="catalog-issue-list">
                    {validation.issues.map((issue) => <li key={issue}>{issue}</li>)}
                  </ul>
                ) : <p className="notice">Ready to publish. Participants must accept the updated rules before creating or joining a team, or submitting their project.</p>}
              </>
            )
          ) : <p className="notice">You do not have permission to check this draft.</p>}
        </section>
      ) : null}

      {configuration.draftPolicy && configuration.canPublish && validation?.valid && publishArmed ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish these participant rules?</h2>
          <p className="muted">Open participant portals update immediately. Existing profiles keep their history, but each participant must accept the updated rules.</p>
          <label className="field">
            <span>Why this changed</span>
            <textarea required value={publishReason} onChange={(event) => setPublishReason(event.currentTarget.value)} />
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
          <PolicySection title="Team rules" description="These limits apply when a person joins and again before final submission.">
            <div className="intake-policy-grid">
              <label className="field">
                <span>Minimum members</span>
                <input required type="number" min={1} max={12} value={policy.teamMinimumSize} onChange={(event) => updatePolicy('teamMinimumSize', event.currentTarget.valueAsNumber)} />
              </label>
              <label className="field">
                <span>Maximum members</span>
                <input required type="number" min={1} max={12} value={policy.teamMaximumSize} onChange={(event) => updatePolicy('teamMaximumSize', event.currentTarget.valueAsNumber)} />
              </label>
              <label className="check-row field-wide">
                <input type="checkbox" checked={policy.mixedParticipantClassesAllowed} onChange={(event) => updatePolicy('mixedParticipantClassesAllowed', event.currentTarget.checked)} />
                <span>Allow VIT students and external participants on the same team</span>
              </label>
            </div>
          </PolicySection>

          <PolicySection title="Profile fields" description="Full name, institution, and year or current role are always required.">
            <div className="intake-policy-grid">
              <FieldModeSelect label="Phone" value={policy.phoneField} onChange={(value) => updatePolicy('phoneField', value)} />
              <FieldModeSelect label="VIT registration number" value={policy.vitRegistrationNumberField} onChange={(value) => updatePolicy('vitRegistrationNumberField', value)} />
              <FieldModeSelect label="VIT programme" value={policy.vitProgrammeField} onChange={(value) => updatePolicy('vitProgrammeField', value)} />
              <FieldModeSelect label="VIT campus" value={policy.vitCampusField} onChange={(value) => updatePolicy('vitCampusField', value)} />
              <FieldModeSelect label="External participant city" value={policy.externalCityField} onChange={(value) => updatePolicy('externalCityField', value)} />
              <FieldModeSelect label="External participant country" value={policy.externalCountryField} onChange={(value) => updatePolicy('externalCountryField', value)} />
            </div>
          </PolicySection>

          <PolicySection title="Participant notice" description="Keep this direct. The project-question AI never receives profile fields.">
            <div className="intake-policy-grid">
              <label className="field">
                <span>Notice name</span>
                <input required minLength={3} maxLength={80} value={policy.label} onChange={(event) => updatePolicy('label', event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Privacy notice URL</span>
                <input required type="url" value={policy.privacyNoticeUrl} onChange={(event) => updatePolicy('privacyNoticeUrl', event.currentTarget.value)} />
              </label>
              <label className="field field-wide">
                <span>Profile notice</span>
                <textarea required minLength={20} maxLength={600} value={policy.profileNotice} onChange={(event) => updatePolicy('profileNotice', event.currentTarget.value)} />
              </label>
              <label className="field field-wide">
                <span>Project answer notice</span>
                <textarea required minLength={20} maxLength={800} value={policy.projectTextNotice} onChange={(event) => updatePolicy('projectTextNotice', event.currentTarget.value)} />
              </label>
            </div>
          </PolicySection>

          <PolicySection title="Submission" description="The fresh-build promise is fixed; the lock warning may be clarified without weakening it.">
            <div className="intake-policy-grid">
              <label className="field field-wide">
                <span>Fresh-project acknowledgement</span>
                <textarea disabled value={policy.freshProjectAttestation} />
              </label>
              <label className="field field-wide">
                <span>Final lock warning</span>
                <textarea required minLength={40} maxLength={400} value={policy.finalSubmissionWarning} onChange={(event) => updatePolicy('finalSubmissionWarning', event.currentTarget.value)} />
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

function FieldModeSelect({
  label,
  value,
  onChange,
}: {
  label: string
  value: FieldMode
  onChange: (value: FieldMode) => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(readFieldMode(event.currentTarget.value))}>
        {fieldModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
      </select>
    </label>
  )
}

function readFieldMode(value: string): FieldMode {
  if (value === 'not_collected' || value === 'optional' || value === 'required') return value
  throw new Error('Invalid profile field mode.')
}

function PolicySection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="intake-policy-section">
      <header><h2>{title}</h2><p className="muted">{description}</p></header>
      {children}
    </section>
  )
}
