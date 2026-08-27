import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { type FormEvent, useDeferredValue, useEffect, useMemo, useState } from 'react'

import { ConfigurationTabs, type ConfigurationTabsVisibility } from '../components/ConfigurationTabs'
import { ConfigurationEditorDisclosure } from '../components/ConfigurationEditorDisclosure'
import { AutonomyPolicyFields } from '../components/intelligence'
import { PendingOperationRecovery } from '../components/PendingOperationRecovery'
import { LoadingLabel, SkeletonCard, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import {
  type ConfigurationOperationDescriptor,
  useConfigurationOperations,
} from '../lib/configurationOperations'
import {
  allAutonomyRecommendationKinds,
  cloneAutonomyPolicy,
  type AutonomyPolicy,
} from '../lib/autonomyPolicy'

type AutonomyPolicyOperationResult =
  | FunctionReturnType<typeof api.operationsAutonomyPolicyConfiguration.createDraft>
  | FunctionReturnType<typeof api.operationsAutonomyPolicyConfiguration.publish>
  | FunctionReturnType<typeof api.operationsAutonomyPolicyConfiguration.disable>

const operationDescriptors = [
  {
    slot: 'autonomy-disable',
    title: 'Finish stopping autonomy',
    action: 'Confirm earlier stop',
  },
  {
    slot: 'autonomy-policy-publish',
    title: 'Finish publishing the policy',
    action: 'Confirm earlier publication',
  },
  {
    slot: 'autonomy-policy-draft',
    title: 'Finish saving the policy draft',
    action: 'Confirm earlier save',
  },
] satisfies readonly ConfigurationOperationDescriptor[]

export function IntelligencePolicyConfiguration({
  tabs,
}: {
  tabs: ConfigurationTabsVisibility
}) {
  const configuration = useQuery(api.operationsAutonomyPolicyConfiguration.current, { eventSlug })
  const [ownerSearch, setOwnerSearch] = useState('')
  const deferredOwnerSearch = useDeferredValue(ownerSearch.trim())
  const ownerOptionsPage = usePaginatedQuery(
    api.operationsAutonomyPolicyConfiguration.ownerOptionsPage,
    {
      eventSlug,
      ...(deferredOwnerSearch.length === 0 ? {} : { search: deferredOwnerSearch }),
    },
    { initialNumItems: 20 },
  )
  const createDraft = useMutation(api.operationsAutonomyPolicyConfiguration.createDraft)
  const publish = useMutation(api.operationsAutonomyPolicyConfiguration.publish)
  const disable = useMutation(api.operationsAutonomyPolicyConfiguration.disable)
  const operations = useConfigurationOperations<AutonomyPolicyOperationResult>(
    operationDescriptors,
  )
  const validation = useQuery(
    api.operationsAutonomyPolicyConfiguration.validateDraft,
    configuration?.canValidate && configuration.draftPolicy
      ? { eventSlug, draftPolicyId: configuration.draftPolicy.id }
      : 'skip',
  )
  const [policy, setPolicy] = useState<AutonomyPolicy | null>(null)
  const [loadedPolicy, setLoadedPolicy] = useState('')
  const [draftReason, setDraftReason] = useState('')
  const [publishReason, setPublishReason] = useState('')
  const [disableReason, setDisableReason] = useState('')
  const [publishArmed, setPublishArmed] = useState(false)
  const [disableArmed, setDisableArmed] = useState(false)
  const { busy, error, operationPending, pendingOperation } = operations
  const draftPending = operations.hasPending('autonomy-policy-draft')
  const publishPending = operations.hasPending('autonomy-policy-publish')
  const disablePending = operations.hasPending('autonomy-disable')
  const ownerOptions = useMemo(() => {
    if (!configuration) return ownerOptionsPage.results
    const byId = new Map(
      [configuration.selectedOwner, ...ownerOptionsPage.results].map((owner) => [
        owner.eventAccessSubjectId,
        owner,
      ]),
    )
    return [...byId.values()]
  }, [configuration, ownerOptionsPage.results])

  useEffect(() => {
    if (!configuration) return
    const source = configuration.draftPolicy ?? configuration.publishedPolicy
    const sourceKey = `${source.id}:${source.checksum}`
    if (sourceKey === loadedPolicy) return
    setPolicy(cloneAutonomyPolicy(source.policy))
    setLoadedPolicy(sourceKey)
    setPublishArmed(false)
  }, [configuration, loadedPolicy])

  if (configuration === undefined || policy === null) {
    return (
      <section className="intake-policy-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading autonomous operations settings</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={5} />
      </section>
    )
  }

  const updatePolicy = <Key extends keyof AutonomyPolicy>(
    key: Key,
    value: AutonomyPolicy[Key],
  ) => {
    setPolicy((current) => current ? { ...current, [key]: value } : current)
  }

  const updateMode = (mode: AutonomyPolicy['mode']) => {
    setPolicy((current) => {
      if (current === null) return current
      if (mode === 'observe') {
        return {
          ...current,
          mode,
          allowedRecommendationKinds: [],
        }
      }
      const selectedOwner = ownerOptions.find(
        (owner) => owner.eventAccessSubjectId === current.accountableOwnerEventAccessSubjectId,
      )
      const recommendationOwner = selectedOwner?.canGenerate
        ? selectedOwner
        : ownerOptions.find((owner) => owner.canGenerate)
      return {
        ...current,
        mode,
        ...(recommendationOwner === undefined
          ? {}
          : { accountableOwnerEventAccessSubjectId: recommendationOwner.eventAccessSubjectId }),
        allowedRecommendationKinds: current.allowedRecommendationKinds.length > 0
          ? current.allowedRecommendationKinds
          : [...allAutonomyRecommendationKinds],
      }
    })
  }

  const saveDraft = (event: FormEvent) => {
    event.preventDefault()
    void operations.run('autonomy-policy-draft', (clientOperationId) => () => createDraft({
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
    void operations.run('autonomy-policy-publish', (clientOperationId) => () => publish({
      eventSlug,
      draftPolicyId: draft.id,
      expectedDraftChecksum: draft.checksum,
      expectedEventVersion: configuration.eventVersion,
      reason: publishReason,
      clientOperationId,
    }), () => setPublishArmed(false))
  }

  const disableAutonomy = () => {
    if (configuration.scheduler.lifecycle.kind !== 'active') return
    void operations.run('autonomy-disable', (clientOperationId) => () => disable({
      eventSlug,
      reason: disableReason,
      clientOperationId,
    }), () => setDisableArmed(false))
  }

  const confirmPendingOperation = () => {
    void operations.retryPending(() => {
      setPublishArmed(false)
      setDisableArmed(false)
    })
  }

  const schedulerActive = configuration.scheduler.lifecycle.kind === 'active'

  return (
    <section className="configuration-shell intake-policy-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading configuration-heading">
        <div>
          <h1>Operations agent</h1>
          <p className="muted">
            Monitors the live event and prepares typed recommendations. It cannot run consequential
            event commands.
          </p>
        </div>
      </header>

      <dl className="catalog-summary">
        <div><dt>State</dt><dd>{schedulerActive ? 'Monitoring' : 'Stopped'}</dd></div>
        <div>
          <dt>Mode</dt>
          <dd>
            {configuration.publishedPolicy.policy.mode === 'recommend'
              ? 'Observe and recommend'
              : 'Observe only'}
          </dd>
        </div>
        <div><dt>Scheduled review</dt><dd>Every {configuration.publishedPolicy.policy.scheduleIntervalMinutes} min</dd></div>
      </dl>

      {pendingOperation ? (
        <PendingOperationRecovery
          action={pendingOperation.action}
          busy={busy}
          onConfirm={() => void confirmPendingOperation()}
          title={pendingOperation.title}
        />
      ) : null}

      {!operationPending && schedulerActive && configuration.canPublish ? (
        <section className="catalog-review">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Kill switch</p>
              <h2>Stop unattended monitoring</h2>
            </div>
            {!disableArmed ? (
              <button className="secondary" type="button" onClick={() => setDisableArmed(true)}>
                Stop autonomy
              </button>
            ) : null}
          </div>
          <p className="muted">
            Stopping cancels the current run and prevents new runs. Re-enabling requires publishing
            a new policy.
          </p>
          {disableArmed ? (
            <div className="publish-confirmation catalog-publish">
              <label className="field">
                <span>Why autonomy is being stopped</span>
                <textarea
                  disabled={disablePending}
                  required
                  value={disableReason}
                  onChange={(event) => setDisableReason(event.currentTarget.value)}
                />
              </label>
              <div className="button-row">
                <button
                  className="primary"
                  disabled={busy || disableReason.trim().length < 5}
                  type="button"
                  onClick={() => void disableAutonomy()}
                >
                  {busy ? 'Stopping…' : disablePending ? 'Confirm earlier stop' : 'Stop autonomy'}
                </button>
                <button
                  className="secondary"
                  disabled={busy || disablePending}
                  type="button"
                  onClick={() => setDisableArmed(false)}
                >
                  Keep running
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {!operationPending && configuration.draftPolicy ? (
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
            ) : validation.issues.length > 0 ? (
              <ul className="catalog-issue-list">
                {validation.issues.map((issue) => <li key={issue}>{issue}</li>)}
              </ul>
            ) : (
              <p className="notice">Ready to publish.</p>
            )
          ) : (
            <p className="notice">You do not have permission to check or publish this draft.</p>
          )}
        </section>
      ) : null}

      {!operationPending && configuration.draftPolicy && configuration.canPublish && validation?.valid && publishArmed ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish this autonomy policy?</h2>
          <p className="muted">
            The current scheduler is superseded immediately. Any current run is canceled before the
            new policy begins.
          </p>
          <label className="field">
            <span>Why this changed</span>
            <textarea
              disabled={publishPending}
              required
              value={publishReason}
              onChange={(event) => setPublishReason(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || publishReason.trim().length < 5}
              type="button"
              onClick={() => void publishDraft()}
            >
              {busy ? 'Publishing…' : publishPending ? 'Confirm earlier publication' : 'Publish policy'}
            </button>
            <button
              className="secondary"
              disabled={busy || publishPending}
              type="button"
              onClick={() => setPublishArmed(false)}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {!operationPending && configuration.canDraft ? (
        <ConfigurationEditorDisclosure
          defaultOpen={Boolean(configuration.draftPolicy)}
          description="Autonomy mode, action boundaries, approvals, escalation, and the accountable owner."
          title={configuration.draftPolicy ? 'Continue operations-agent draft' : 'Edit operations agent'}
        >
          <form className="configuration-editor intake-policy-editor" onSubmit={saveDraft}>
          <fieldset disabled={draftPending} style={{ display: 'contents' }}>
            <AutonomyPolicyFields
              policy={policy}
              ownerCanLoadMore={ownerOptionsPage.status === 'CanLoadMore'}
              ownerLoading={
                ownerOptionsPage.status === 'LoadingFirstPage'
                || ownerOptionsPage.status === 'LoadingMore'
              }
              ownerOptions={ownerOptions}
              ownerSearch={ownerSearch}
              onChange={updatePolicy}
              onLoadMoreOwners={() => ownerOptionsPage.loadMore(20)}
              onModeChange={updateMode}
              onOwnerSearchChange={setOwnerSearch}
            />
          </fieldset>

          <section className="configuration-save">
            <label className="field">
              <span>Why this changed</span>
              <textarea
                disabled={draftPending}
                required
                value={draftReason}
                onChange={(event) => setDraftReason(event.currentTarget.value)}
              />
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
