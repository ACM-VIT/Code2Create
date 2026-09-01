import { api } from '@code2create/backend/api'
import { TZDateMini } from '@date-fns/tz'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useState, type FormEvent } from 'react'

import { ConfigurationTabs, type ConfigurationTabsVisibility } from '../components/ConfigurationTabs'
import { ConfigurationEditorDisclosure } from '../components/ConfigurationEditorDisclosure'
import { PendingOperationRecovery } from '../components/PendingOperationRecovery'
import { LoadingLabel, SkeletonCard, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import {
  type ConfigurationOperationDescriptor,
  useConfigurationOperations,
} from '../lib/configurationOperations'
import { useVersionedState } from '@code2create/web-forms'

type Configuration = FunctionReturnType<typeof api.integrationPolicyConfiguration.current>
type Policy = Configuration['publishedPolicy']['policy']
type IntegrationPolicyOperationResult =
  | FunctionReturnType<typeof api.integrationPolicyConfiguration.createDraft>
  | FunctionReturnType<typeof api.integrationPolicyConfiguration.publish>

const operationDescriptors = [
  {
    slot: 'integration-policy-publish',
    title: 'Finish publishing the code and design policy',
    action: 'Confirm earlier publication',
  },
  {
    slot: 'integration-policy-draft',
    title: 'Finish saving the code and design policy draft',
    action: 'Confirm earlier save',
  },
] satisfies readonly ConfigurationOperationDescriptor[]

type EditorPolicy = Omit<
  Policy,
  | 'maxActiveGitHubRepositoriesPerTeam'
  | 'maxActiveFigmaFilesPerTeam'
  | 'githubFreezeAt'
  | 'figmaFreezeAt'
> & {
  maxActiveGitHubRepositoriesPerTeam: string
  maxActiveFigmaFilesPerTeam: string
  githubFreezeAt: string
  figmaFreezeAt: string
}

export function IntegrationPolicyConfiguration({
  tabs,
}: {
  tabs: ConfigurationTabsVisibility
}) {
  const configuration = useQuery(api.integrationPolicyConfiguration.current, { eventSlug })
  const createDraft = useMutation(api.integrationPolicyConfiguration.createDraft)
  const publish = useMutation(api.integrationPolicyConfiguration.publish)
  const operations = useConfigurationOperations<IntegrationPolicyOperationResult>(
    operationDescriptors,
  )
  const validation = useQuery(
    api.integrationPolicyConfiguration.validateDraft,
    configuration?.canValidate && configuration.draftPolicy
      ? { eventSlug, draftPolicyId: configuration.draftPolicy.id }
      : 'skip',
  )
  const source = configuration
    ? configuration.draftPolicy ?? configuration.publishedPolicy
    : null
  const sourceKey = source ? `${source.id}:${source.checksum}` : 'loading'
  const policyState = useVersionedState<EditorPolicy | null>(
    sourceKey,
    source && configuration ? toEditorPolicy(source.policy, configuration.timezone) : null,
  )
  const policy = policyState.value
  const setPolicy = policyState.update
  const [draftReason, setDraftReason] = useState('')
  const [publishReason, setPublishReason] = useState('')
  const publishState = useVersionedState(sourceKey, false)
  const publishArmed = publishState.value
  const setPublishArmed = publishState.replace
  const { busy, error, operationPending, pendingOperation } = operations
  const draftPending = operations.hasPending('integration-policy-draft')
  const publishPending = operations.hasPending('integration-policy-publish')

  if (configuration === undefined || policy === null) {
    return (
      <section className="intake-policy-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading code and design policy</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={4} />
      </section>
    )
  }

  const updatePolicy = <Key extends keyof EditorPolicy>(key: Key, value: EditorPolicy[Key]) => {
    setPolicy((current) => current ? { ...current, [key]: value } : current)
  }

  const saveDraft = (event: FormEvent) => {
    event.preventDefault()
    void operations.run('integration-policy-draft', (clientOperationId) => () => createDraft({
      eventSlug,
      policy: fromEditorPolicy(policy, configuration.timezone),
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
    void operations.run('integration-policy-publish', (clientOperationId) => () => publish({
      eventSlug,
      draftPolicyId: draft.id,
      expectedDraftChecksum: draft.checksum,
      expectedEventVersion: configuration.eventVersion,
      reason: publishReason,
      clientOperationId,
    }), () => setPublishArmed(false))
  }

  const confirmPendingOperation = () => {
    void operations.retryPending(() => setPublishArmed(false))
  }

  const published = configuration.publishedPolicy.policy
  return (
    <section className="configuration-shell intake-policy-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading configuration-heading">
        <div>
          <h1>Code and design policy</h1>
          <p className="muted">
            Controls the required GitHub topic, per-team connection limits, and exact change freezes.
          </p>
        </div>
      </header>

      <dl className="catalog-summary">
        <div><dt>Release</dt><dd>{published.policyVersion}</dd></div>
        <div><dt>Required topic</dt><dd>{published.requiredGitHubTopic}</dd></div>
        <div>
          <dt>Per team</dt>
          <dd>
            {published.maxActiveGitHubRepositoriesPerTeam} GitHub ·{' '}
            {published.maxActiveFigmaFilesPerTeam} Figma
          </dd>
        </div>
        <div>
          <dt>GitHub changes</dt>
          <dd>{freezeLabel(published.githubFreezeAt, configuration.timezone)}</dd>
        </div>
        <div>
          <dt>Figma changes</dt>
          <dd>{freezeLabel(published.figmaFreezeAt, configuration.timezone)}</dd>
        </div>
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
              <p className="muted">Checking connected teams and policy integrity…</p>
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
                  <p className="notice">Ready to publish against the current connected-team counts.</p>
                )}
              </>
            )
          ) : (
            <p className="notice">You do not have permission to check this draft.</p>
          )}
        </section>
      ) : null}

      {!operationPending && configuration.draftPolicy && configuration.canPublish && validation?.valid && publishArmed ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish this code and design policy?</h2>
          <p className="muted">
            Limits and freezes take effect as soon as this is published. Changing the required
            GitHub topic rechecks every active repository in the background.
          </p>
          <label className="field">
            <span>Why this changed</span>
            <textarea
              disabled={publishPending}
              required
              value={publishReason}
              onChange={(event) => setPublishReason(event.currentTarget.value)}
            />
          </label>
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || publishReason.trim().length < 5}
              type="button"
              onClick={() => void publishDraft()}
            >
              {busy
                ? 'Publishing…'
                : publishPending
                  ? 'Confirm earlier publication'
                  : 'Publish policy'}
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
          description="Repository evidence, Figma files, per-team limits, and change-freeze times."
          title={configuration.draftPolicy ? 'Continue code-and-design draft' : 'Edit code and design policy'}
        >
          <form className="configuration-editor intake-policy-editor" onSubmit={saveDraft}>
          <fieldset disabled={draftPending} style={{ display: 'contents' }}>
            <PolicySection
              title="GitHub evidence"
              description="The topic is checked against every connected repository. Existing repositories are rechecked after a topic change."
            >
              <div className="intake-policy-grid">
                <label className="field">
                  <span>Policy release</span>
                  <input
                    required
                    minLength={1}
                    maxLength={80}
                    value={policy.policyVersion}
                    onChange={(event) => updatePolicy('policyVersion', event.currentTarget.value)}
                  />
                </label>
                <label className="field">
                  <span>Required repository topic</span>
                  <input
                    required
                    maxLength={50}
                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    value={policy.requiredGitHubTopic}
                    onChange={(event) => updatePolicy('requiredGitHubTopic', event.currentTarget.value)}
                  />
                  <small>Lowercase letters, numbers, and single hyphens.</small>
                </label>
                <label className="field">
                  <span>Active repositories per team</span>
                  <input
                    required
                    type="number"
                    min="1"
                    max="20"
                    step="1"
                    value={policy.maxActiveGitHubRepositoriesPerTeam}
                    onChange={(event) => updatePolicy(
                      'maxActiveGitHubRepositoriesPerTeam',
                      event.currentTarget.value,
                    )}
                  />
                </label>
                <label className="field">
                  <span>GitHub freeze · {configuration.timezone}</span>
                  <input
                    type="datetime-local"
                    value={policy.githubFreezeAt}
                    onChange={(event) => updatePolicy('githubFreezeAt', event.currentTarget.value)}
                  />
                </label>
              </div>
            </PolicySection>

            <PolicySection
              title="Figma evidence"
              description="Leave a freeze empty to keep team changes open. At the selected minute, server commands reject further changes."
            >
              <div className="intake-policy-grid">
                <label className="field">
                  <span>Active files per team</span>
                  <input
                    required
                    type="number"
                    min="1"
                    max="10"
                    step="1"
                    value={policy.maxActiveFigmaFilesPerTeam}
                    onChange={(event) => updatePolicy(
                      'maxActiveFigmaFilesPerTeam',
                      event.currentTarget.value,
                    )}
                  />
                </label>
                <label className="field">
                  <span>Figma freeze · {configuration.timezone}</span>
                  <input
                    type="datetime-local"
                    value={policy.figmaFreezeAt}
                    onChange={(event) => updatePolicy('figmaFreezeAt', event.currentTarget.value)}
                  />
                </label>
              </div>
            </PolicySection>
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
            <button
              className="primary"
              disabled={busy || draftReason.trim().length < 5}
              type="submit"
            >
              {busy
                ? 'Saving…'
                : draftPending
                  ? 'Confirm earlier draft'
                  : configuration.draftPolicy
                    ? 'Replace draft'
                    : 'Save draft'}
            </button>
          </section>
          </form>
        </ConfigurationEditorDisclosure>
      ) : (
        <p className="notice">You can view this policy but cannot create a draft.</p>
      )}

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
    policyVersion: policy.policyVersion,
    requiredGitHubTopic: policy.requiredGitHubTopic,
    maxActiveGitHubRepositoriesPerTeam: String(policy.maxActiveGitHubRepositoriesPerTeam),
    maxActiveFigmaFilesPerTeam: String(policy.maxActiveFigmaFilesPerTeam),
    githubFreezeAt: policy.githubFreezeAt === undefined
      ? ''
      : timestampInput(policy.githubFreezeAt, timezone),
    figmaFreezeAt: policy.figmaFreezeAt === undefined
      ? ''
      : timestampInput(policy.figmaFreezeAt, timezone),
  }
}

function fromEditorPolicy(policy: EditorPolicy, timezone: string): Policy {
  return {
    policyVersion: policy.policyVersion,
    requiredGitHubTopic: policy.requiredGitHubTopic,
    maxActiveGitHubRepositoriesPerTeam: wholeNumber(
      policy.maxActiveGitHubRepositoriesPerTeam,
      'Active GitHub repositories per team',
    ),
    maxActiveFigmaFilesPerTeam: wholeNumber(
      policy.maxActiveFigmaFilesPerTeam,
      'Active Figma files per team',
    ),
    ...(policy.githubFreezeAt
      ? { githubFreezeAt: zonedTimestamp(policy.githubFreezeAt, timezone, 'GitHub freeze time') }
      : {}),
    ...(policy.figmaFreezeAt
      ? { figmaFreezeAt: zonedTimestamp(policy.figmaFreezeAt, timezone, 'Figma freeze time') }
      : {}),
  }
}

function wholeNumber(value: string, label: string) {
  const number = Number(value)
  if (!Number.isInteger(number)) throw new Error(`${label} must be a whole number.`)
  return number
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

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function freezeLabel(timestamp: number | undefined, timezone: string) {
  if (timestamp === undefined) return 'Open'
  return `Freezes ${new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(timestamp)}`
}
