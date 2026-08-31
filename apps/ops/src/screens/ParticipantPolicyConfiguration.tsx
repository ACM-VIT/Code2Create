import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

import { ConfigurationTabs, type ConfigurationTabsVisibility } from '../components/ConfigurationTabs'
import { ConfigurationEditorDisclosure } from '../components/ConfigurationEditorDisclosure'
import { PendingOperationRecovery } from '../components/PendingOperationRecovery'
import { LoadingLabel, SkeletonCard, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import {
  type ConfigurationOperationDescriptor,
  useConfigurationOperations,
} from '../lib/configurationOperations'

type Configuration = FunctionReturnType<typeof api.participantPolicyConfiguration.current>
type Policy = Configuration['publishedPolicy']['policy']
type HostelResidence = Policy['vitHostelResidenceCatalog'][number]
type PolicyOperationResult =
  | FunctionReturnType<typeof api.participantPolicyConfiguration.createDraft>
  | FunctionReturnType<typeof api.participantPolicyConfiguration.publish>
  | FunctionReturnType<typeof api.participantPolicyConfiguration.updateApplicationDeadlines>

const operationDescriptors = [
  {
    slot: 'participant-deadlines-update',
    title: 'Finish updating the application deadlines',
    action: 'Confirm earlier update',
  },
  {
    slot: 'participant-policy-publish',
    title: 'Finish publishing the participant rules',
    action: 'Confirm earlier publication',
  },
  {
    slot: 'participant-policy-draft',
    title: 'Finish saving the participant rules draft',
    action: 'Confirm earlier save',
  },
] satisfies readonly ConfigurationOperationDescriptor[]

export function ParticipantPolicyConfiguration({
  tabs,
}: {
  tabs: ConfigurationTabsVisibility
}) {
  const configuration = useQuery(api.participantPolicyConfiguration.current, { eventSlug })
  const createDraft = useMutation(api.participantPolicyConfiguration.createDraft)
  const publish = useMutation(api.participantPolicyConfiguration.publish)
  const updateApplicationDeadlines = useMutation(api.participantPolicyConfiguration.updateApplicationDeadlines)
  const operations = useConfigurationOperations<PolicyOperationResult>(operationDescriptors)
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
  const [externalDeadline, setExternalDeadline] = useState<string | null>(null)
  const [vitDeadline, setVitDeadline] = useState<string | null>(null)
  const [deadlineReason, setDeadlineReason] = useState('')
  const { busy, error, operationPending, pendingOperation } = operations
  const draftPending = operations.hasPending('participant-policy-draft')
  const publishPending = operations.hasPending('participant-policy-publish')
  const deadlinesPending = operations.hasPending('participant-deadlines-update')

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

  const updateHostelResidence = (index: number, patch: Partial<HostelResidence>) => {
    updatePolicy(
      'vitHostelResidenceCatalog',
      policy.vitHostelResidenceCatalog.map((residence, residenceIndex) =>
        residenceIndex === index ? { ...residence, ...patch } : residence,
      ),
    )
  }

  const addHostelResidence = () => {
    updatePolicy('vitHostelResidenceCatalog', [
      ...policy.vitHostelResidenceCatalog,
      {
        stableKey: nextHostelResidenceKey(policy.vitHostelResidenceCatalog),
        label: 'New block',
        kind: 'mens',
      },
    ])
  }

  const removeHostelResidence = (index: number) => {
    updatePolicy(
      'vitHostelResidenceCatalog',
      policy.vitHostelResidenceCatalog.filter((_, residenceIndex) => residenceIndex !== index),
    )
  }

  const saveDraft = (event: FormEvent) => {
    event.preventDefault()
    void operations.run('participant-policy-draft', (clientOperationId) => () => createDraft({
      eventSlug,
      policy,
      expectedEventVersion: configuration.eventVersion,
      ...(configuration.draftPolicy
        ? { expectedDraftPolicyId: configuration.draftPolicy.id }
        : {}),
      reason: draftReason,
      clientOperationId,
    }))
  }

  const publishDraft = () => {
    const draft = configuration.draftPolicy
    if (!draft || !validation?.valid) return
    void operations.run('participant-policy-publish', (clientOperationId) => () => publish({
      eventSlug,
      draftPolicyId: draft.id,
      expectedDraftChecksum: draft.checksum,
      expectedEventVersion: configuration.eventVersion,
      reason: publishReason,
      clientOperationId,
    }), () => setPublishArmed(false))
  }

  const saveDeadlines = (event: FormEvent) => {
    event.preventDefault()
    const externalApplicationsCloseAt = indiaInputToTimestamp(
      externalDeadline ?? indiaTimestampToInput(
        configuration.applicationDeadlines.externalApplicationsCloseAt,
      ),
    )
    const vitApplicationsCloseAt = indiaInputToTimestamp(
      vitDeadline ?? indiaTimestampToInput(
        configuration.applicationDeadlines.vitApplicationsCloseAt,
      ),
    )
    if (externalApplicationsCloseAt === null || vitApplicationsCloseAt === null) return
    void operations.run('participant-deadlines-update', (clientOperationId) => () => updateApplicationDeadlines({
      eventSlug,
      externalApplicationsCloseAt,
      vitApplicationsCloseAt,
      expectedEventVersion: configuration.eventVersion,
      reason: deadlineReason,
      clientOperationId,
    }), () => {
      setExternalDeadline(null)
      setVitDeadline(null)
      setDeadlineReason('')
    })
  }

  const confirmPendingOperation = () => {
    void operations.retryPending(() => setPublishArmed(false))
  }

  return (
    <section className="configuration-shell intake-policy-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading configuration-heading">
        <div>
          <h1>Participant form</h1>
          <p className="muted">Controls profile collection, team eligibility, consent text, and the final submission warning.</p>
        </div>
      </header>

      <form className="catalog-review" onSubmit={saveDeadlines}>
        <div className="section-heading">
          <div><p className="muted">Application window</p><h2>Submission deadlines</h2></div>
        </div>
        <div className="intake-policy-grid">
          <label className="field">
            <span>External participants · India time</span>
            <input disabled={deadlinesPending || !configuration.canPublish} required type="datetime-local" value={externalDeadline ?? indiaTimestampToInput(configuration.applicationDeadlines.externalApplicationsCloseAt)} onChange={(event) => setExternalDeadline(event.currentTarget.value)} />
          </label>
          <label className="field">
            <span>VIT students · India time</span>
            <input disabled={deadlinesPending || !configuration.canPublish} required type="datetime-local" value={vitDeadline ?? indiaTimestampToInput(configuration.applicationDeadlines.vitApplicationsCloseAt)} onChange={(event) => setVitDeadline(event.currentTarget.value)} />
          </label>
          <label className="field field-wide">
            <span>Why this changed</span>
            <input disabled={deadlinesPending || !configuration.canPublish} minLength={5} required value={deadlineReason} onChange={(event) => setDeadlineReason(event.currentTarget.value)} />
          </label>
        </div>
        {configuration.canPublish ? (
          <button className="secondary" disabled={busy || deadlineReason.trim().length < 5} type="submit">
            {deadlinesPending ? 'Confirm earlier update' : 'Update deadlines'}
          </button>
        ) : <p className="notice">You can view these deadlines but cannot change them.</p>}
      </form>

      <dl className="catalog-summary">
        <div><dt>Status</dt><dd>Ready</dd></div>
        <div><dt>Team size</dt><dd>{configuration.publishedPolicy.policy.teamMinimumSize}–{configuration.publishedPolicy.policy.teamMaximumSize}</dd></div>
        <div><dt>Team eligibility</dt><dd>VIT and external teams stay separate</dd></div>
        <div><dt>VIT residences</dt><dd>{configuration.publishedPolicy.policy.vitHostelResidenceCatalog.length}</dd></div>
      </dl>

      {pendingOperation ? (
        <PendingOperationRecovery
          action={pendingOperation.action}
          busy={busy}
          onConfirm={() => void confirmPendingOperation()}
          title={pendingOperation.title}
        />
      ) : null}

      {!operationPending && configuration.draftPolicy ? (
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
                ) : <p className="notice">Ready to publish. Participants must accept the updated rules.</p>}
              </>
            )
          ) : <p className="notice">You do not have permission to check this draft.</p>}
        </section>
      ) : null}

      {!operationPending && configuration.draftPolicy && configuration.canPublish && validation?.valid && publishArmed ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish these participant rules?</h2>
          <p className="muted">Each participant must accept the updated rules.</p>
          <label className="field">
            <span>Why this changed</span>
            <textarea disabled={publishPending} required value={publishReason} onChange={(event) => setPublishReason(event.currentTarget.value)} />
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy || publishReason.trim().length < 5} type="button" onClick={() => void publishDraft()}>
              {busy ? 'Publishing…' : publishPending ? 'Confirm earlier publication' : 'Publish policy'}
            </button>
            <button className="secondary" disabled={busy || publishPending} type="button" onClick={() => setPublishArmed(false)}>Cancel</button>
          </div>
        </section>
      ) : null}

      {!operationPending && configuration.canDraft ? (
        <ConfigurationEditorDisclosure
          defaultOpen={Boolean(configuration.draftPolicy)}
          description="Team rules, hostel blocks, notices, and the final submission warning."
          title={configuration.draftPolicy ? 'Continue participant-form draft' : 'Edit participant form'}
        >
        <form className="configuration-editor intake-policy-editor" onSubmit={saveDraft}>
          <fieldset disabled={draftPending} style={{ display: 'contents' }}>
          <PolicySection
            title="Team rules"
            description={`Checked when someone joins and again at submission. The published participant capacity is ${configuration.participantCapacity}.`}
          >
            <div className="intake-policy-grid">
              <label className="field">
                <span>Minimum members</span>
                <input required type="number" min={1} max={configuration.participantCapacity} value={policy.teamMinimumSize} onChange={(event) => updatePolicy('teamMinimumSize', event.currentTarget.valueAsNumber)} />
              </label>
              <label className="field">
                <span>Maximum members</span>
                <input required type="number" min={1} max={configuration.participantCapacity} value={policy.teamMaximumSize} onChange={(event) => updatePolicy('teamMaximumSize', event.currentTarget.valueAsNumber)} />
              </label>
              <p className="notice field-wide">VIT students and external participants form separate teams.</p>
            </div>
          </PolicySection>

          <PolicySection title="Required profile fields" description="These fields are fixed so participant records stay complete and operationally useful.">
            <p className="notice">
              Everyone provides phone, Male or Female gender, and year of study. VIT identity is
              derived from Google and VIT students choose day scholar or hosteller. External
              participants provide university and college.
            </p>
          </PolicySection>

          <PolicySection
            title="VIT hostel block catalogue"
            description="Published blocks appear for hostellers after they select Male or Female. Stable keys are stored on profiles; labels and grouping are participant-facing."
          >
            <div className="phase-card-list">
              {policy.vitHostelResidenceCatalog.map((residence, index) => (
                <article className="phase-card" key={`${residence.stableKey}:${index}`}>
                  <header className="configuration-card-heading">
                    <div>
                      <span>Hostel block {index + 1}</span>
                      <strong>{residence.label || 'Unnamed block'}</strong>
                    </div>
                    {policy.vitHostelResidenceCatalog.length > 2 ? (
                      <button className="text-button" type="button" onClick={() => removeHostelResidence(index)}>
                        Remove
                      </button>
                    ) : null}
                  </header>
                  <div className="intake-policy-grid">
                    <label className="field">
                      <span>Stable key</span>
                      <input
                        required
                        minLength={2}
                        maxLength={40}
                        pattern="[a-z][a-z0-9_]+"
                        value={residence.stableKey}
                        onChange={(event) => updateHostelResidence(index, { stableKey: event.currentTarget.value })}
                      />
                    </label>
                    <label className="field">
                      <span>Participant label</span>
                      <input
                        required
                        minLength={2}
                        maxLength={80}
                        value={residence.label}
                        onChange={(event) => updateHostelResidence(index, { label: event.currentTarget.value })}
                      />
                    </label>
                    <label className="field">
                      <span>Group</span>
                      <select
                        value={residence.kind}
                        onChange={(event) => updateHostelResidence(index, {
                          kind: readHostelResidenceKind(event.currentTarget.value),
                        })}
                      >
                        <option value="mens">Men's hostel</option>
                        <option value="ladies">Ladies' hostel</option>
                      </select>
                    </label>
                  </div>
                </article>
              ))}
            </div>
            <button
              className="secondary intake-policy-add"
              disabled={policy.vitHostelResidenceCatalog.length >= 64}
              type="button"
              onClick={addHostelResidence}
            >
              Add hostel block
            </button>
            <p className="notice">Keep at least one Men's and one Ladies' hostel block.</p>
          </PolicySection>

          <PolicySection title="Participant notice" description="The project-question AI never receives profile fields.">
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

          <PolicySection title="Submission" description="The fresh-build promise cannot be edited.">
            <div className="intake-policy-grid">
              <label className="field field-wide">
                <span>Fresh-project acknowledgement</span>
                <textarea disabled value={policy.freshProjectAttestation} />
              </label>
              <label className="field field-wide">
                <span>Final submission warning</span>
                <textarea required minLength={40} maxLength={400} value={policy.finalSubmissionWarning} onChange={(event) => updatePolicy('finalSubmissionWarning', event.currentTarget.value)} />
              </label>
            </div>
          </PolicySection>

          </fieldset>
          <section className="configuration-save">
            <label className="field">
              <span>Why this changed</span>
              <textarea disabled={draftPending} required value={draftReason} onChange={(event) => setDraftReason(event.currentTarget.value)} />
            </label>
            <button className="primary" disabled={busy || draftReason.trim().length < 5} type="submit">
              {busy ? 'Saving…' : draftPending ? 'Confirm earlier draft' : configuration.draftPolicy ? 'Replace draft' : 'Save draft'}
            </button>
          </section>
        </form>
        </ConfigurationEditorDisclosure>
      ) : null}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function indiaInputToTimestamp(value: string) {
  const timestamp = Date.parse(`${value}:00+05:30`)
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null
}

function indiaTimestampToInput(timestamp: number) {
  return new Date(timestamp + 5.5 * 60 * 60 * 1_000).toISOString().slice(0, 16)
}

function readHostelResidenceKind(value: string): HostelResidence['kind'] {
  if (value === 'mens' || value === 'ladies') return value
  throw new Error('Invalid VIT residence group.')
}

function nextHostelResidenceKey(catalog: Policy['vitHostelResidenceCatalog']) {
  const stableKeys = new Set(catalog.map((residence) => residence.stableKey))
  for (let suffix = 1; suffix <= 64; suffix += 1) {
    const candidate = `hostel_${suffix}`
    if (!stableKeys.has(candidate)) return candidate
  }
  throw new Error('The VIT hostel block catalogue is full.')
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
