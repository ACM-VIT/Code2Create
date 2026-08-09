import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'

import { ConfigurationTabs, type ConfigurationTabsVisibility } from '../components/ConfigurationTabs'
import { LoadingLabel, SkeletonCard, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type Configuration = FunctionReturnType<typeof api.intakePolicyConfiguration.current>
type Policy = Configuration['publishedPolicy']['policy']
type Purpose = Policy['allowedPurposeKeys'][number]
type AnswerLength = Policy['fallbackQuestions'][number]['answerLength']
type AssistedModel = Extract<Policy['model'], { mode: 'assisted' }>

const purposeOptions = [
  'user',
  'problem',
  'experience',
  'event_goal',
  'tradeoff',
  'risk',
  'track_fit',
] satisfies readonly Purpose[]

const answerLengthOptions = ['short', 'medium'] satisfies readonly AnswerLength[]

const assistedModelTemplate: AssistedModel = {
  mode: 'assisted',
  modelId: '',
  systemInstruction:
    'Generate one short, supportive follow-up question for a hackathon team. Use only the supplied source and catalog identifiers. Never score, rank, reject, discourage, request personal information, or penalise a team for choosing another track.',
  instructionVersion: 'intake-instruction-v1',
  schemaVersion: 'intake-output-v1',
  redactionVersion: 'intake-redaction-v1',
  questionPolicyVersion: 'intake-question-policy-v1',
  evaluationSuiteVersion: 'intake-evaluation-v1',
  maxOutputTokens: 600,
  timeoutMs: 8_000,
}

export function IntakePolicyConfiguration({
  tabs,
}: {
  tabs: ConfigurationTabsVisibility
}) {
  const configuration = useQuery(api.intakePolicyConfiguration.current, { eventSlug })
  const createDraft = useMutation(api.intakePolicyConfiguration.createDraft)
  const publish = useMutation(api.intakePolicyConfiguration.publish)
  const validation = useQuery(
    api.intakePolicyConfiguration.validateDraft,
    configuration?.canValidate && configuration.draftPolicy
      ? { eventSlug, draftPolicyId: configuration.draftPolicy.id }
      : 'skip',
  )
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [loadedPolicy, setLoadedPolicy] = useState('')
  const [draftReason, setDraftReason] = useState('Refined the participant introduction')
  const [publishReason, setPublishReason] = useState('Validated for new participant intakes')
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
    ordinal: number,
    patch: Partial<Policy['fallbackQuestions'][number]>,
  ) => {
    setPolicy((current) => current ? {
      ...current,
      fallbackQuestions: current.fallbackQuestions.map((question) => (
        question.ordinal === ordinal ? { ...question, ...patch } : question
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

  const updateAssistedModel = (patch: Partial<AssistedModel>) => {
    setPolicy((current) => {
      if (!current || current.model.mode !== 'assisted') return current
      return { ...current, model: { ...current.model, ...patch } }
    })
  }

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createDraft({
        eventSlug,
        policy: withGeneratedPatternKeys(policy),
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
          <p className="eyebrow">Participant introduction</p>
          <h1>Idea questions</h1>
          <p className="muted">
            Controls the short project introduction. Teams already writing keep the questions they started with.
          </p>
        </div>
      </header>

      <dl className="catalog-summary">
        <div><dt>Status</dt><dd>Ready</dd></div>
        <div><dt>Question source</dt><dd>{configuration.publishedPolicy.policy.model.mode === 'assisted' ? 'AI-assisted' : 'Fixed'}</dd></div>
        <div><dt>Teams writing</dt><dd>{configuration.publishedPolicy.activeDraftCount}</dd></div>
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

      {configuration.draftPolicy && configuration.canPublish && validation?.valid && publishArmed ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish these idea questions?</h2>
          <p className="muted">
            New project drafts use it immediately. Existing drafts and their generated questions do not change.
          </p>
          <label className="field">
            <span>Why this changed</span>
            <textarea required value={publishReason} onChange={(event) => setPublishReason(event.target.value)} />
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy || publishReason.trim().length < 5} type="button" onClick={() => void publishDraft()}>
              {busy ? 'Publishing…' : 'Publish questions'}
            </button>
            <button className="secondary" disabled={busy} type="button" onClick={() => setPublishArmed(false)}>Cancel</button>
          </div>
        </section>
      ) : null}

      {configuration.canDraft ? (
        <form className="track-editor intake-policy-editor" onSubmit={saveDraft}>
          <div className="track-editor-heading">
            <div>
              <p className="eyebrow">{configuration.draftPolicy ? 'Replace current draft' : 'Create a draft'}</p>
              <h2>Participant copy</h2>
              <p className="muted">The greeting and first question are event-wide product language.</p>
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

          <PolicySection title="Answer limits" description="Enough room to explain an idea without turning intake into a deck.">
            <div className="intake-policy-number-grid">
              <NumberField label="Idea minimum · characters" min={10} max={200} value={policy.initialIdeaMinLength} onChange={(value) => updatePolicy('initialIdeaMinLength', value)} />
              <NumberField label="Idea maximum · characters" min={500} max={8000} value={policy.initialIdeaMaxLength} onChange={(value) => updatePolicy('initialIdeaMaxLength', value)} />
              <NumberField label="Answer minimum · characters" min={1} max={100} value={policy.followUpAnswerMinLength} onChange={(value) => updatePolicy('followUpAnswerMinLength', value)} />
              <NumberField label="Answer maximum · characters" min={200} max={2000} value={policy.followUpAnswerMaxLength} onChange={(value) => updatePolicy('followUpAnswerMaxLength', value)} />
              <NumberField label="Question maximum · characters" min={40} max={140} value={policy.questionMaxLength} onChange={(value) => updatePolicy('questionMaxLength', value)} />
              <label className="field">
                <span>Fixed-question count</span>
                <select value={policy.deterministicFollowUpCount} onChange={(event) => updatePolicy('deterministicFollowUpCount', parseFollowUpCount(event.target.value))}>
                  <option value={1}>One</option>
                  <option value={2}>Two</option>
                </select>
              </label>
            </div>
            <p className="muted intake-policy-note">Assisted intake may stop after one useful answer. It can never ask more than two questions.</p>
          </PolicySection>

          <PolicySection title="Question goals" description="Assisted questions use one of these reviewed goals.">
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

          <PolicySection title="Fallback questions" description="These are used directly in fixed mode and whenever assisted generation is unavailable.">
            <div className="phase-card-list">
              {policy.fallbackQuestions.map((question) => (
                <article className="phase-card" key={question.ordinal}>
                  <header><span>Question {question.ordinal}</span><strong>{question.text}</strong></header>
                  <label className="field"><span>Question</span><input required value={question.text} onChange={(event) => updateFallback(question.ordinal, { text: event.target.value })} /></label>
                  <div className="intake-policy-grid">
                    <label className="field">
                      <span>Purpose</span>
                      <select value={question.purposeKey} onChange={(event) => updateFallback(question.ordinal, { purposeKey: parsePurpose(event.target.value) })}>
                        {purposeOptions.map((purpose) => <option key={purpose} value={purpose}>{humanize(purpose)}</option>)}
                      </select>
                    </label>
                    <label className="field">
                      <span>Answer length</span>
                      <select value={question.answerLength} onChange={(event) => updateFallback(question.ordinal, { answerLength: parseAnswerLength(event.target.value) })}>
                        {answerLengthOptions.map((length) => <option key={length} value={length}>{humanize(length)}</option>)}
                      </select>
                    </label>
                  </div>
                </article>
              ))}
            </div>
          </PolicySection>

          <PolicySection title="Supportive wording" description="One prohibited phrase per line. Required event-safety language cannot be removed at publication.">
            <label className="field">
              <span>Blocked wording</span>
              <textarea className="intake-policy-lines" required value={policy.blockedTerms.join('\n')} onChange={(event) => updatePolicy('blockedTerms', event.target.value.split('\n'))} />
            </label>
          </PolicySection>

          <PolicySection title="Common project patterns" description="Optional guidance helps the question stay useful without treating a familiar idea as a reason to reject it.">
            <div className="phase-card-list">
              {policy.commonIdeaPatterns.map((pattern, index) => (
                <article className="phase-card" key={index}>
                  <header className="track-card-heading">
                    <div><span>Pattern {index + 1}</span><strong>{pattern.description || 'New pattern'}</strong></div>
                    <button className="text-button" type="button" onClick={() => updatePolicy('commonIdeaPatterns', policy.commonIdeaPatterns.filter((_, patternIndex) => patternIndex !== index))}>Remove</button>
                  </header>
                  <label className="field"><span>Description</span><textarea required value={pattern.description} onChange={(event) => updatePattern(index, { description: event.target.value })} /></label>
                  <label className="field"><span>Supportive question guidance</span><textarea required value={pattern.supportiveQuestionGuidance} onChange={(event) => updatePattern(index, { supportiveQuestionGuidance: event.target.value })} /></label>
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

          <PolicySection title="Question source" description="Assisted questions use the approved AI release and fall back to the fixed questions when unavailable.">
            <label className="field intake-policy-mode">
              <span>Mode</span>
              <select
                value={policy.model.mode}
                onChange={(event) => setPolicy((current) => current ? {
                  ...current,
                  model: parseModelMode(event.target.value) === 'deterministic'
                    ? { mode: 'deterministic' }
                    : current.model.mode === 'assisted'
                      ? current.model
                      : assistedModelTemplate,
                } : current)}
              >
                <option value="deterministic">Fixed questions</option>
                <option value="assisted">Assisted questions</option>
              </select>
            </label>
            {policy.model.mode === 'assisted' ? (
              <details className="configuration-advanced">
                <summary>Model release settings</summary>
                <div className="intake-assisted-fields">
                  <label className="field"><span>Model</span><input required spellCheck={false} value={policy.model.modelId} onChange={(event) => updateAssistedModel({ modelId: event.target.value })} /></label>
                  <label className="field full-field"><span>System instruction</span><textarea required value={policy.model.systemInstruction} onChange={(event) => updateAssistedModel({ systemInstruction: event.target.value })} /></label>
                  <label className="field"><span>Instruction version</span><input required spellCheck={false} value={policy.model.instructionVersion} onChange={(event) => updateAssistedModel({ instructionVersion: event.target.value })} /></label>
                  <label className="field"><span>Schema version</span><input required spellCheck={false} value={policy.model.schemaVersion} onChange={(event) => updateAssistedModel({ schemaVersion: event.target.value })} /></label>
                  <label className="field"><span>Redaction version</span><input required spellCheck={false} value={policy.model.redactionVersion} onChange={(event) => updateAssistedModel({ redactionVersion: event.target.value })} /></label>
                  <label className="field"><span>Question-policy version</span><input required spellCheck={false} value={policy.model.questionPolicyVersion} onChange={(event) => updateAssistedModel({ questionPolicyVersion: event.target.value })} /></label>
                  <label className="field"><span>Evaluation-suite version</span><input required spellCheck={false} value={policy.model.evaluationSuiteVersion} onChange={(event) => updateAssistedModel({ evaluationSuiteVersion: event.target.value })} /></label>
                  <NumberField label="Output-token limit" min={200} max={1200} value={policy.model.maxOutputTokens} onChange={(value) => updateAssistedModel({ maxOutputTokens: value })} />
                  <NumberField label="Timeout in milliseconds" min={2000} max={15000} value={policy.model.timeoutMs} onChange={(value) => updateAssistedModel({ timeoutMs: value })} />
                </div>
              </details>
            ) : null}
          </PolicySection>

          <section className="track-save">
            <label className="field"><span>Why this changed</span><textarea required value={draftReason} onChange={(event) => setDraftReason(event.target.value)} /></label>
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

function parseFollowUpCount(value: string): 1 | 2 {
  if (value === '1') return 1
  if (value === '2') return 2
  throw new Error('The selected question count is invalid.')
}

function parseModelMode(value: string): Policy['model']['mode'] {
  if (value === 'deterministic' || value === 'assisted') return value
  throw new Error('The selected question source is invalid.')
}

function humanize(value: string) {
  const labels: Readonly<Record<string, string>> = {
    event_goal: 'What they want to finish',
    experience: 'How it works',
    medium: 'Medium',
    problem: 'Problem',
    risk: 'Risk or unknown',
    short: 'Short',
    track_fit: 'Track fit',
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
