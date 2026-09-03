import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useState, type ChangeEvent, type FormEvent } from 'react'

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

type Configuration = FunctionReturnType<typeof api.intakePolicyConfiguration.current>
type Policy = Configuration['publishedPolicy']['policy']
type Purpose = Policy['allowedPurposeKeys'][number]
type AnswerLength = Policy['fallbackQuestions'][number]['answerLength']
type IntakePolicyOperationResult =
  | FunctionReturnType<typeof api.intakePolicyConfiguration.createDraft>
  | FunctionReturnType<typeof api.intakePolicyConfiguration.publish>

const purposeOptions = [
  'user',
  'problem',
  'experience',
  'event_goal',
  'tradeoff',
  'risk',
] satisfies readonly Purpose[]

const answerLengthOptions = ['short', 'medium'] satisfies readonly AnswerLength[]

const operationDescriptors = [
  {
    slot: 'intake-policy-publish',
    title: 'Finish publishing the idea questions',
    action: 'Confirm earlier publication',
  },
  {
    slot: 'intake-policy-draft',
    title: 'Finish saving the draft idea questions',
    action: 'Confirm earlier save',
  },
] satisfies readonly ConfigurationOperationDescriptor[]

export function IntakePolicyConfiguration({
  tabs,
}: {
  tabs: ConfigurationTabsVisibility
}) {
  const configuration = useQuery(api.intakePolicyConfiguration.current, { eventSlug })
  const createDraft = useMutation(api.intakePolicyConfiguration.createDraft)
  const publish = useMutation(api.intakePolicyConfiguration.publish)
  const operations = useConfigurationOperations<IntakePolicyOperationResult>(operationDescriptors)
  const validation = useQuery(
    api.intakePolicyConfiguration.validateDraft,
    configuration?.canValidate && configuration.draftPolicy
      ? { eventSlug, draftPolicyId: configuration.draftPolicy.id }
      : 'skip',
  )
  const source = configuration
    ? configuration.draftPolicy ?? configuration.publishedPolicy
    : null
  const sourceKey = source ? `${source.id}:${source.checksum}` : 'loading'
  const policyState = useVersionedState<Policy | null>(
    sourceKey,
    source ? clonePolicy(source.policy) : null,
  )
  const policy = policyState.value
  const setPolicy = policyState.update
  const [draftReason, setDraftReason] = useState('Refined the participant introduction')
  const [publishReason, setPublishReason] = useState('Validated for new participant intakes')
  const publishState = useVersionedState(sourceKey, false)
  const publishArmed = publishState.value
  const setPublishArmed = publishState.replace
  const { busy, error, operationPending, pendingOperation } = operations
  const draftPending = operations.hasPending('intake-policy-draft')
  const publishPending = operations.hasPending('intake-policy-publish')

  if (configuration === undefined || policy === null) {
    return (
      <section className="intake-policy-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading the idea questions</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={4} />
      </section>
    )
  }

  const updatePolicy = <Key extends keyof Policy>(key: Key, value: Policy[Key]) => {
    setPolicy((current) => current ? { ...current, [key]: value } : current)
  }

  const updateFallback = (
    fallbackIndex: number,
    patch: Partial<Policy['fallbackQuestions'][number]>,
  ) => {
    setPolicy((current) => current ? {
      ...current,
      fallbackQuestions: current.fallbackQuestions.map((question, questionIndex) => (
        questionIndex === fallbackIndex ? { ...question, ...patch } : question
      )),
    } : current)
  }

  const updatePattern = (
    index: number,
    patch: Partial<Policy['commonIdeaPatterns'][number]>,
  ) => {
    setPolicy((current) => current ? {
      ...current,
      commonIdeaPatterns: current.commonIdeaPatterns.map((pattern, patternIndex) => (
        patternIndex === index ? { ...pattern, ...patch } : pattern
      )),
    } : current)
  }

  const saveDraft = (event: FormEvent) => {
    event.preventDefault()
    void operations.run('intake-policy-draft', (clientOperationId) => () => createDraft({
      eventSlug,
      policy: withGeneratedPatternKeys(policy),
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
    void operations.run('intake-policy-publish', (clientOperationId) => () => publish({
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

  return (
    <section className="configuration-shell intake-policy-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading configuration-heading">
        <div>
          <p className="eyebrow">Participant introduction</p>
          <h1>Idea questions</h1>
          <p className="muted">
            Controls the short project introduction. Teams already writing keep their current questions.
          </p>
        </div>
      </header>

      <dl className="catalog-summary">
        <div><dt>Status</dt><dd>Ready</dd></div>
        <div><dt>Where questions come from</dt><dd>AI, with a backup question</dd></div>
        <div><dt>Teams writing</dt><dd>{configuration.publishedPolicy.activeDraftCount}</dd></div>
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
              <p className="eyebrow">Draft changes</p>
              <h2>Before publishing</h2>
            </div>
            {configuration.canPublish && validation?.valid && !publishArmed ? (
              <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>
                Review before publishing
              </button>
            ) : null}
          </div>

          {configuration.canValidate ? (
            validation === undefined ? (
              <p className="muted">Checking the draft…</p>
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
                    Ready to publish. {validation.pinnedParticipantDraftCount} team {validation.pinnedParticipantDraftCount === 1 ? 'keeps' : 'teams keep'} the current questions.
                  </p>
                )}
              </>
            )
          ) : (
            <p className="notice">You do not have permission to check or publish this draft.</p>
          )}
        </section>
      ) : null}

      {!operationPending && configuration.draftPolicy && configuration.canPublish && validation?.valid && publishArmed ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish these idea questions?</h2>
          <p className="muted">New project drafts use these questions immediately.</p>
          <label className="field">
            <span>Why this changed</span>
            <textarea disabled={publishPending} required value={publishReason} onChange={(event) => setPublishReason(event.target.value)} />
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy || publishReason.trim().length < 5} type="button" onClick={() => void publishDraft()}>
              {busy ? 'Publishing…' : publishPending ? 'Confirm earlier publication' : 'Publish questions'}
            </button>
            <button className="secondary" disabled={busy || publishPending} type="button" onClick={() => setPublishArmed(false)}>Cancel</button>
          </div>
        </section>
      ) : null}

      {!operationPending && configuration.canDraft ? (
        <ConfigurationEditorDisclosure
          defaultOpen={Boolean(configuration.draftPolicy)}
          description="What participants read, answer limits, question goals, and backup questions."
          title={configuration.draftPolicy ? 'Continue idea-question draft' : 'Edit idea questions'}
        >
        <form className="configuration-editor intake-policy-editor" onSubmit={saveDraft}>
          <fieldset disabled={draftPending} style={{ display: 'contents' }}>
          <div className="configuration-editor-heading">
            <div>
              <p className="eyebrow">{configuration.draftPolicy ? 'Replace current draft' : 'Create a draft'}</p>
              <h2>What participants read</h2>
              <p className="muted">The greeting and first question cannot be changed here.</p>
            </div>
          </div>

          <div className="intake-policy-grid">
            <label className="field"><span>Greeting</span><input disabled value={policy.openingText} /></label>
            <label className="field"><span>First question</span><input disabled value={policy.initialPrompt} /></label>
          </div>
          <label className="field">
            <span>Help text</span>
            <textarea required value={policy.initialHelpText} onChange={(event) => updatePolicy('initialHelpText', event.target.value)} />
          </label>

          <PolicySection title="Answer limits" description="How much a team can write at each step.">
            <div className="intake-policy-number-grid">
              <NumberField label="Idea minimum · characters" min={10} max={200} value={policy.initialIdeaMinLength} onChange={(value) => updatePolicy('initialIdeaMinLength', value)} />
              <NumberField label="Idea maximum · characters" min={500} max={8000} value={policy.initialIdeaMaxLength} onChange={(value) => updatePolicy('initialIdeaMaxLength', value)} />
              <NumberField label="Answer minimum · characters" min={1} max={100} value={policy.followUpAnswerMinLength} onChange={(value) => updatePolicy('followUpAnswerMinLength', value)} />
              <NumberField label="Answer maximum · characters" min={200} max={2000} value={policy.followUpAnswerMaxLength} onChange={(value) => updatePolicy('followUpAnswerMaxLength', value)} />
              <NumberField label="Question maximum · characters" min={40} max={140} value={policy.questionMaxLength} onChange={(value) => updatePolicy('questionMaxLength', value)} />
              <label className="field">
                <span>Fixed questions</span>
                <input disabled value="Two" />
              </label>
            </div>
            <p className="muted intake-policy-note">Every introduction has four questions: two fixed, then two about the project. If the AI doesn’t answer within 20 seconds, a backup question is used instead.</p>
          </PolicySection>

          <PolicySection title="Goals for the AI questions" description="Every extra question is built around one of these goals.">
            <div className="intake-purpose-list">
              {purposeOptions.map((purpose) => (
                <label key={purpose}>
                  <input
                    checked={policy.allowedPurposeKeys.includes(purpose)}
                    type="checkbox"
                    onChange={(event) => updatePolicy(
                      'allowedPurposeKeys',
                      event.target.checked
                        ? [...policy.allowedPurposeKeys, purpose]
                        : policy.allowedPurposeKeys.filter((candidate) => candidate !== purpose),
                    )}
                  />
                  <span>{humanize(purpose)}</span>
                </label>
              ))}
            </div>
          </PolicySection>

          <PolicySection title="Question wording" description="Questions 1 and 2 are fixed. If the AI misses its deadline or gives an unusable question, the team gets one of these backup questions for 3 and 4 instead.">
            <div className="phase-card-list">
              {policy.fallbackQuestions.map((question, questionIndex) => {
                const variantNumber = policy.fallbackQuestions
                  .slice(0, questionIndex + 1)
                  .filter((candidate) => candidate.ordinal === question.ordinal)
                  .length
                return (
                  <article className="phase-card" key={`${question.ordinal}:${questionIndex}`}>
                    <header><span>{question.ordinal <= 2 ? `Fixed question ${question.ordinal}` : `Question ${question.ordinal}, variant ${variantNumber}`}</span><strong>{question.text}</strong></header>
                    <label className="field"><span>Question</span><input required value={question.text} onChange={(event) => updateFallback(questionIndex, { text: event.target.value })} /></label>
                    <div className="intake-policy-grid">
                      <label className="field">
                        <span>Purpose</span>
                        <select value={question.purposeKey} onChange={(event) => updateFallback(questionIndex, { purposeKey: parsePurpose(event.target.value) })}>
                          {purposeOptions.map((purpose) => <option key={purpose} value={purpose}>{humanize(purpose)}</option>)}
                        </select>
                      </label>
                      <label className="field">
                        <span>Answer length</span>
                        <select value={question.answerLength} onChange={(event) => updateFallback(questionIndex, { answerLength: parseAnswerLength(event.target.value) })}>
                          {answerLengthOptions.map((length) => <option key={length} value={length}>{humanize(length)}</option>)}
                        </select>
                      </label>
                    </div>
                  </article>
                )
              })}
            </div>
          </PolicySection>

          <PolicySection title="Tone" description="One phrase per line. The required safety wording can’t be removed.">
            <label className="field">
              <span>Words to avoid</span>
              <textarea className="intake-policy-lines" required value={policy.blockedTerms.join('\n')} onChange={(event) => updatePolicy('blockedTerms', event.target.value.split('\n'))} />
            </label>
          </PolicySection>

          <PolicySection title="Ideas that come up every year" description="Optional guidance for ideas that come up every year.">
            <div className="phase-card-list">
              {policy.commonIdeaPatterns.map((pattern, index) => (
                <article className="phase-card" key={index}>
                  <header className="configuration-card-heading">
                    <div><span>Pattern {index + 1}</span><strong>{pattern.description || 'New pattern'}</strong></div>
                    <button className="text-button" type="button" onClick={() => updatePolicy('commonIdeaPatterns', policy.commonIdeaPatterns.filter((_, patternIndex) => patternIndex !== index))}>Remove</button>
                  </header>
                  <label className="field"><span>Description</span><textarea required value={pattern.description} onChange={(event) => updatePattern(index, { description: event.target.value })} /></label>
                  <label className="field"><span>How the questions should sound</span><textarea required value={pattern.supportiveQuestionGuidance} onChange={(event) => updatePattern(index, { supportiveQuestionGuidance: event.target.value })} /></label>
                </article>
              ))}
            </div>
            <button
              className="secondary intake-policy-add"
              disabled={policy.commonIdeaPatterns.length >= 20}
              type="button"
              onClick={() => updatePolicy('commonIdeaPatterns', [...policy.commonIdeaPatterns, { stableKey: nextPatternKey(policy.commonIdeaPatterns), description: '', supportiveQuestionGuidance: '' }])}
            >
              Add pattern
            </button>
          </PolicySection>

          </fieldset>
          <section className="configuration-save">
            <label className="field"><span>Why this changed</span><textarea disabled={draftPending} required value={draftReason} onChange={(event) => setDraftReason(event.target.value)} /></label>
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

function clonePolicy(policy: Policy): Policy {
  return {
    ...policy,
    allowedPurposeKeys: [...policy.allowedPurposeKeys],
    fallbackQuestions: policy.fallbackQuestions.map((question) => ({ ...question })),
    blockedTerms: [...policy.blockedTerms],
    commonIdeaPatterns: policy.commonIdeaPatterns.map((pattern) => ({ ...pattern })),
    model: policy.model.mode === 'deterministic' ? { mode: 'deterministic' } : { ...policy.model },
  }
}

function parsePurpose(value: string): Purpose {
  const purpose = purposeOptions.find((candidate) => candidate === value)
  if (!purpose) throw new Error('The selected question purpose is invalid.')
  return purpose
}

function parseAnswerLength(value: string): AnswerLength {
  const length = answerLengthOptions.find((candidate) => candidate === value)
  if (!length) throw new Error('The selected answer length is invalid.')
  return length
}

function humanize(value: string) {
  const labels: Readonly<Record<string, string>> = {
    event_goal: 'What they want to finish',
    experience: 'How it works',
    medium: 'Medium',
    problem: 'Problem',
    risk: 'Risk or unknown',
    short: 'Short',
    tradeoff: 'Important choice',
    user: 'Who it helps',
  }
  const label = labels[value] ?? value.replaceAll('_', ' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function nextPatternKey(patterns: readonly Policy['commonIdeaPatterns'][number][]) {
  const existing = new Set(patterns.map((pattern) => pattern.stableKey))
  let sequence = 1
  while (existing.has(`pattern_${sequence}`)) sequence += 1
  return `pattern_${sequence}`
}

function withGeneratedPatternKeys(policy: Policy): Policy {
  return {
    ...policy,
    commonIdeaPatterns: policy.commonIdeaPatterns.map((pattern, index) => ({
      ...pattern,
      stableKey: pattern.stableKey || `pattern_${index + 1}`,
    })),
  }
}
