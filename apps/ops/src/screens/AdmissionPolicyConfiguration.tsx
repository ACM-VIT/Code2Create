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

type CurrentConfiguration = FunctionReturnType<typeof api.admissionPolicyConfiguration.current>
type AdmissionConfiguration = CurrentConfiguration['publishedRelease']['configuration']
type Criterion = AdmissionConfiguration['criteria'][number]
type ReasonCode = AdmissionConfiguration['decisionReasonCodes'][number]
type AdmissionDecision = ReasonCode['allowedDecisions'][number]
type AdmissionPolicyOperationResult =
  | FunctionReturnType<typeof api.admissionPolicyConfiguration.createDraft>
  | FunctionReturnType<typeof api.admissionPolicyConfiguration.publish>

const decisions: { value: AdmissionDecision; label: string }[] = [
  { value: 'accept', label: 'Accept' },
  { value: 'waitlist', label: 'Waitlist' },
  { value: 'decline', label: 'Decline' },
  { value: 'needs_information', label: 'Needs information' },
]

const guidanceFields: {
  key: keyof Criterion['guidanceByBand']
  label: string
}[] = [
  { key: 'firstYear', label: 'First year' },
  { key: 'earlyYear', label: 'Second or early year' },
  { key: 'laterYear', label: 'Later year' },
  { key: 'postgraduateOrProfessional', label: 'Postgraduate or professional' },
  { key: 'mixedOrExternal', label: 'Mixed or external team' },
]

const operationDescriptors = [
  {
    slot: 'admission-policy-publish',
    title: 'Finish publishing the admission policy',
    action: 'Confirm earlier publication',
  },
  {
    slot: 'admission-policy-draft',
    title: 'Finish saving the admission policy draft',
    action: 'Confirm earlier save',
  },
] satisfies readonly ConfigurationOperationDescriptor[]

export function AdmissionPolicyConfiguration({
  tabs,
}: {
  tabs: ConfigurationTabsVisibility
}) {
  const current = useQuery(api.admissionPolicyConfiguration.current, { eventSlug })
  const validation = useQuery(
    api.admissionPolicyConfiguration.validateDraft,
    current?.canValidate && current.draftRelease
      ? { eventSlug, draftPolicyId: current.draftRelease.policyId }
      : 'skip',
  )
  const createDraft = useMutation(api.admissionPolicyConfiguration.createDraft)
  const publish = useMutation(api.admissionPolicyConfiguration.publish)
  const operations = useConfigurationOperations<AdmissionPolicyOperationResult>(
    operationDescriptors,
  )
  const [configuration, setConfiguration] = useState<AdmissionConfiguration | null>(null)
  const [loadedRelease, setLoadedRelease] = useState('')
  const [draftReason, setDraftReason] = useState('')
  const [publishReason, setPublishReason] = useState('')
  const [publishArmed, setPublishArmed] = useState(false)
  const { busy, error, operationPending, pendingOperation } = operations
  const draftPending = operations.hasPending('admission-policy-draft')
  const publishPending = operations.hasPending('admission-policy-publish')

  useEffect(() => {
    if (!current) return
    const source = current.draftRelease ?? current.publishedRelease
    const sourceKey = `${source.policyId}:${source.policyChecksum}:${source.modelChecksum ?? 'disabled'}`
    if (sourceKey === loadedRelease) return
    setConfiguration(source.configuration)
    setLoadedRelease(sourceKey)
    setPublishArmed(false)
  }, [current, loadedRelease])

  if (current === undefined || configuration === null) {
    return (
      <section className="intake-policy-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading the admission policy</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={4} />
      </section>
    )
  }

  const update = <Key extends keyof AdmissionConfiguration>(
    key: Key,
    value: AdmissionConfiguration[Key],
  ) => setConfiguration((existing) => existing ? { ...existing, [key]: value } : existing)

  const updateCriterion = (index: number, criterion: Criterion) => {
    update('criteria', configuration.criteria.map((currentCriterion, currentIndex) => (
      currentIndex === index ? criterion : currentCriterion
    )))
  }

  const updateReason = (index: number, reason: ReasonCode) => {
    update('decisionReasonCodes', configuration.decisionReasonCodes.map((currentReason, currentIndex) => (
      currentIndex === index ? reason : currentReason
    )))
  }

  const saveDraft = (event: FormEvent) => {
    event.preventDefault()
    void operations.run('admission-policy-draft', (clientOperationId) => () => createDraft({
      eventSlug,
      configuration,
      expectedEventVersion: current.eventVersion,
      ...(current.draftRelease
        ? { expectedDraftPolicyId: current.draftRelease.policyId }
        : {}),
      reason: draftReason,
      clientOperationId,
    }))
  }

  const publishDraft = () => {
    const draft = current.draftRelease
    if (!draft || !validation?.valid || current.publicationLocked) return
    void operations.run('admission-policy-publish', (clientOperationId) => () => publish({
      eventSlug,
      draftPolicyId: draft.policyId,
      expectedPolicyChecksum: draft.policyChecksum,
      expectedModelConfigId: draft.modelConfigId,
      expectedModelChecksum: draft.modelChecksum,
      expectedEventVersion: current.eventVersion,
      reason: publishReason,
      clientOperationId,
    }), () => setPublishArmed(false))
  }

  const confirmPendingOperation = () => {
    void operations.retryPending(() => setPublishArmed(false))
  }

  const publishedConfiguration = current.publishedRelease.configuration

  return (
    <section className="configuration-shell intake-policy-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading configuration-heading">
        <div>
          <h1>Admission policy</h1>
          <p className="muted">Set how applications are reviewed before submissions open.</p>
        </div>
      </header>

      <dl className="catalog-summary admission-summary">
        <div><dt>Status</dt><dd>Published</dd></div>
        <div><dt>Reviews per application</dt><dd>{publishedConfiguration.minimumHumanReviews}</dd></div>
        <div><dt>Participant places</dt><dd>{publishedConfiguration.overallParticipantCapacity}</dd></div>
        <div><dt>AI recommendation</dt><dd>{publishedConfiguration.model ? 'On' : 'Off'}</dd></div>
      </dl>

      {current.publicationLocked ? (
        <section className="configuration-locked">
          <header>
            <div>
              <span>Current policy</span>
              <h2>{publishedConfiguration.version}</h2>
            </div>
            <span className="state-label">Locked</span>
          </header>
          <dl>
            <div>
              <dt>Application expectations</dt>
              <dd>{publishedConfiguration.criteria.map((criterion) => criterion.label).join(' · ')}</dd>
            </div>
            <div>
              <dt>Experience policy</dt>
              <dd>Five published year and study-context bands</dd>
            </div>
            <div>
              <dt>Decision reasons</dt>
              <dd>{publishedConfiguration.decisionReasonCodes.length} published reasons</dd>
            </div>
          </dl>
          <p>Applications have opened, so this release cannot change during the cycle.</p>
        </section>
      ) : null}

      {pendingOperation ? (
        <PendingOperationRecovery
          action={pendingOperation.action}
          busy={busy}
          onConfirm={() => void confirmPendingOperation()}
          title={pendingOperation.title}
        />
      ) : null}

      {!operationPending && current.draftRelease ? (
        <section className="catalog-review">
          <div className="section-heading">
            <div><p className="muted">Draft changes</p><h2>Before publishing</h2></div>
            {current.canPublish && validation?.valid && !current.publicationLocked && !publishArmed ? (
              <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>Review publication</button>
            ) : null}
          </div>
          {current.canValidate ? (
            validation === undefined ? <p className="muted">Validating draft…</p> : (
              <>
                <ul className="catalog-change-list">
                  {validation.changes.map((change) => <li key={change}>{change}</li>)}
                </ul>
                {validation.issues.length > 0 ? (
                  <ul className="catalog-issue-list">
                    {validation.issues.map((issue) => <li key={issue}>{issue}</li>)}
                  </ul>
                ) : <p className="notice">Ready to publish. The first application locks this policy.</p>}
              </>
            )
          ) : <p className="notice">You do not have permission to check this draft.</p>}
        </section>
      ) : null}

      {!operationPending && current.draftRelease && current.canPublish && validation?.valid && publishArmed && !current.publicationLocked ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish this admission policy?</h2>
          <p className="muted">The first application will lock these rules.</p>
          <label className="field">
            <span>Why this policy is ready</span>
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

      {!operationPending && current.canDraft && !current.publicationLocked ? (
        <ConfigurationEditorDisclosure
          defaultOpen={Boolean(current.draftRelease)}
          description="Capacity, experience-adjusted expectations, and decision reasons."
          title={current.draftRelease ? 'Continue admission-policy draft' : 'Edit admission policy'}
        >
        <form className="configuration-editor intake-policy-editor" onSubmit={saveDraft}>
          <fieldset disabled={draftPending} style={{ display: 'contents' }}>
          <PolicySection title="Basics" description="These limits apply to the whole admissions round.">
            <div className="intake-policy-grid">
              <label className="field">
                <span>Policy name</span>
                <input required minLength={1} maxLength={80} value={configuration.version} onChange={(event) => update('version', event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Reviews required per application</span>
                <input required type="number" min={1} max={5} value={configuration.minimumHumanReviews} onChange={(event) => update('minimumHumanReviews', event.currentTarget.valueAsNumber)} />
              </label>
              <label className="field">
                <span>Total participant places</span>
                <input required type="number" min={1} value={configuration.overallParticipantCapacity} onChange={(event) => update('overallParticipantCapacity', event.currentTarget.valueAsNumber)} />
              </label>
            </div>
          </PolicySection>

          <PolicySection title="Application expectations" description="Expect more from experienced teams. These are not judging scores.">
            <div className="configuration-card-stack">
              {configuration.criteria.map((criterion, index) => (
                <section className="catalog-review" key={`${criterion.criterionKey}:${index}`}>
                  <div className="section-heading">
                    <h3>{criterion.label || `Expectation ${index + 1}`}</h3>
                    {configuration.criteria.length > 1 ? (
                      <button className="text-button" type="button" onClick={() => update('criteria', configuration.criteria.filter((_, currentIndex) => currentIndex !== index))}>Remove</button>
                    ) : null}
                  </div>
                  <div className="intake-policy-grid">
                    <label className="field">
                      <span>Expectation</span>
                      <input required value={criterion.label} onChange={(event) => updateCriterion(index, { ...criterion, label: event.currentTarget.value })} />
                    </label>
                    {guidanceFields.map((field) => (
                      <label className="field field-wide" key={field.key}>
                        <span>{field.label}</span>
                        <textarea
                          required
                          minLength={20}
                          maxLength={600}
                          value={criterion.guidanceByBand[field.key]}
                          onChange={(event) => updateCriterion(index, {
                            ...criterion,
                            guidanceByBand: { ...criterion.guidanceByBand, [field.key]: event.currentTarget.value },
                          })}
                        />
                      </label>
                    ))}
                  </div>
                </section>
              ))}
              {configuration.criteria.length < 12 ? (
                <button className="secondary" type="button" onClick={() => update('criteria', [...configuration.criteria, newCriterion(configuration.criteria.length + 1)])}>Add criterion</button>
              ) : null}
            </div>
          </PolicySection>

          <PolicySection title="Decision reasons" description="Organizers pick one reason for every decision.">
            <div className="configuration-card-stack">
              {configuration.decisionReasonCodes.map((reason, index) => (
                <section className="catalog-review" key={`${reason.key}:${index}`}>
                  <div className="section-heading">
                    <h3>{reason.label || `Reason ${index + 1}`}</h3>
                    {configuration.decisionReasonCodes.length > 4 ? (
                      <button className="text-button" type="button" onClick={() => update('decisionReasonCodes', configuration.decisionReasonCodes.filter((_, currentIndex) => currentIndex !== index))}>Remove</button>
                    ) : null}
                  </div>
                  <div className="intake-policy-grid">
                    <label className="field">
                      <span>Reason shown to organizers</span>
                      <input required value={reason.label} onChange={(event) => updateReason(index, { ...reason, label: event.currentTarget.value })} />
                    </label>
                    <div className="field field-wide">
                      <span>Allowed decisions</span>
                      <div className="button-row">
                        {decisions.map((decision) => (
                          <label className="check-row" key={decision.value}>
                            <input
                              type="checkbox"
                              checked={reason.allowedDecisions.includes(decision.value)}
                              onChange={(event) => updateReason(index, {
                                ...reason,
                                allowedDecisions: event.currentTarget.checked
                                  ? [...reason.allowedDecisions, decision.value]
                                  : reason.allowedDecisions.filter((value) => value !== decision.value),
                              })}
                            />
                            <span>{decision.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              ))}
              {configuration.decisionReasonCodes.length < 20 ? (
                <button className="secondary" type="button" onClick={() => update('decisionReasonCodes', [...configuration.decisionReasonCodes, newReason(configuration.decisionReasonCodes.length + 1)])}>Add reason</button>
              ) : null}
            </div>
          </PolicySection>

          </fieldset>
          <section className="configuration-save">
            <label className="field">
              <span>Why this changed</span>
              <textarea disabled={draftPending} required value={draftReason} onChange={(event) => setDraftReason(event.currentTarget.value)} />
            </label>
            <button className="primary" disabled={busy || draftReason.trim().length < 5} type="submit">
              {busy ? 'Saving…' : draftPending ? 'Confirm earlier draft' : current.draftRelease ? 'Replace draft' : 'Save draft'}
            </button>
          </section>
        </form>
        </ConfigurationEditorDisclosure>
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
  children: ReactNode
}) {
  return (
    <section className="catalog-review">
      <div className="section-heading"><div><h2>{title}</h2><p className="muted">{description}</p></div></div>
      {children}
    </section>
  )
}

function newCriterion(position: number): Criterion {
  return {
    criterionKey: `criterion_${position}`,
    label: `Criterion ${position}`,
    guidanceByBand: {
      firstYear: 'State the welcoming first-year expectation for this criterion.',
      earlyYear: 'State the expectation for students in their early years.',
      laterYear: 'State the stronger expectation for later-year students.',
      postgraduateOrProfessional: 'State the expectation for postgraduate or professional teams.',
      mixedOrExternal: 'State the fair expectation for mixed or external teams.',
    },
  }
}

function newReason(position: number): ReasonCode {
  return {
    key: `decision_reason_${position}`,
    label: `Decision reason ${position}`,
    allowedDecisions: ['needs_information'],
  }
}
