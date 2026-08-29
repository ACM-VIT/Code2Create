import { api } from '@code2create/backend/api'
import { useAction, useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ErrorNotice, TextArea } from '../components/Form'
import { EditingPresence } from '../components/EditingPresence'
import { useEditingPresence } from '../hooks/useEditingPresence'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import {
  clearSessionDraft,
  readVersionedSessionDraft,
  sessionDraftConflicts,
  writeVersionedSessionDraft,
} from '../lib/sessionDraft'
import type { CurrentIntake, CurrentTeam, CurrentTeamMember } from '../types'

type NoveltySignal = {
  score: number
}

type NoveltyState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; signal: NoveltySignal }
  | { status: 'unavailable' }

type IntakeOperationResult =
  | FunctionReturnType<typeof api.intake.saveInitialIdea>
  | FunctionReturnType<typeof api.intake.respondToFollowUp>
  | FunctionReturnType<typeof api.intake.reviseFollowUp>
  | FunctionReturnType<typeof api.intake.setFreshnessAttestation>
  | FunctionReturnType<typeof api.intake.submit>

type PendingFollowUp = {
  questionId: string
  kind: 'answer' | 'skip'
}

type PendingIntakeOperation = {
  kind: 'idea' | 'follow_up' | 'revision' | 'freshness' | 'submit'
  slot: string
  action: string
}

type RecoveredFollowUp = {
  answer: string
  questionId: string
}

function normalizedIdeaLength(value: string) {
  return value.trim().replace(/\s+/g, ' ').length
}

function storedDraftVersion(value: string) {
  const version = Number(value)
  return Number.isSafeInteger(version) && version >= 0 ? version : null
}

export function IntakeScreen({
  team,
  members,
  submissionFailureMessage,
}: {
  team: CurrentTeam
  members: CurrentTeamMember[]
  submissionFailureMessage?: string
}) {
  const intake = useQuery(api.intake.current, { eventSlug })
  if (intake === undefined) return <p className="muted">Loading your application…</p>
  if (intake === null) return <ErrorNotice message="Your application is unavailable." />
  if (!team.canWriteProject) return <ReadOnlyIntake intake={intake} members={members} />
  return (
    <>
      <ErrorNotice message={submissionFailureMessage ?? null} />
      <IntakeWorkspace team={team} intake={intake} members={members} />
    </>
  )
}

function ReadOnlyIntake({
  intake,
  members,
}: {
  intake: CurrentIntake
  members: CurrentTeamMember[]
}) {
  const { editors } = useEditingPresence(false)
  const draft = intake.draft
  return (
    <IntakeFrame label="Project idea">
      <h1>Project editing is unavailable.</h1>
      <p className="minimal-step-hint">Your team’s saved work remains here. Another member with project access can continue.</p>
      <EditingPresence editors={editors ?? []} members={members} />
      {draft?.initialIdea ? (
        <div className="submitted-summary">
          <p className="preserve-lines">{draft.initialIdea}</p>
        </div>
      ) : null}
    </IntakeFrame>
  )
}

function IntakeWorkspace({
  team,
  intake,
  members,
}: {
  team: CurrentTeam
  intake: CurrentIntake
  members: CurrentTeamMember[]
}) {
  const draft = intake.draft
  const previewNovelty = useAction(api.novelty.preview)
  const saveIdea = useMutation(api.intake.saveInitialIdea)
  const respondToFollowUp = useMutation(api.intake.respondToFollowUp)
  const reviseFollowUp = useMutation(api.intake.reviseFollowUp)
  const setFreshness = useMutation(api.intake.setFreshnessAttestation)
  const submitApplication = useMutation(api.intake.submit)
  const opening = useQuery(api.intake.opening, { eventSlug })
  const preview = useQuery(
    api.intake.submissionPreview,
    draft?.stage === 'review' ? { eventSlug } : 'skip',
  )
  const ideaStorageKey = `c2c:${eventSlug}:${team.id}:idea`
  const [recoveredIdea] = useState(() => readVersionedSessionDraft(ideaStorageKey))
  const recoveredIdeaVersion = recoveredIdea ? storedDraftVersion(recoveredIdea.base) : null
  const initialSavedIdea = draft?.initialIdea ?? ''
  const initialSavedVersion = draft?.version ?? 0
  const [idea, setIdea] = useState(recoveredIdea?.value ?? initialSavedIdea)
  const [ideaDirty, setIdeaDirty] = useState(
    recoveredIdea !== null && recoveredIdea.value !== initialSavedIdea,
  )
  const ideaBase = useRef({ version: recoveredIdeaVersion ?? initialSavedVersion })
  const [ideaConflict, setIdeaConflict] = useState(
    sessionDraftConflicts(recoveredIdea, String(initialSavedVersion)),
  )
  const [answer, setAnswer] = useState('')
  const followUpBase = useRef<{ questionId: string | null; version: number }>({
    questionId: null,
    version: draft?.version ?? 0,
  })
  const [followUpConflict, setFollowUpConflict] = useState(false)
  const [recoveredFollowUp, setRecoveredFollowUp] = useState<RecoveredFollowUp | null>(null)
  const [editingFollowUpId, setEditingFollowUpId] = useState<string | null>(null)
  const [editedFollowUpAnswer, setEditedFollowUpAnswer] = useState('')
  const [revisionBaseVersion, setRevisionBaseVersion] = useState<number | null>(null)
  const [editingIdea, setEditingIdea] = useState(false)
  const [confirmedSnapshotKey, setConfirmedSnapshotKey] = useState<string | null>(null)
  const [pendingFollowUp, setPendingFollowUp] = useState<PendingFollowUp | null>(null)
  const [pendingRevisionId, setPendingRevisionId] = useState<string | null>(null)
  const [pendingRevisionKind, setPendingRevisionKind] = useState<'answer' | 'skip' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [noveltyState, setNoveltyState] = useState<NoveltyState>({ status: 'idle' })
  const noveltySequence = useRef(0)
  const commandInFlight = useRef(false)
  const [applicationsOpen, setApplicationsOpen] = useState(
    () => Date.now() < intake.applicationsCloseAt,
  )
  const operations = useOperationRunner<IntakeOperationResult>()
  const ideaEditorOpen = !draft || draft.stage === 'opening' || editingIdea
  const { editors, markEditing, stopEditing } = useEditingPresence(team.canWriteProject)

  const novelty = draft?.novelty ?? opening?.novelty ?? null
  const noveltyCorpusVersionId = novelty?.corpusVersionId ?? null
  const noveltyMinimumIdeaLength = novelty?.minimumIdeaLength ?? null
  const noveltyDebounceMs = novelty?.debounceMs ?? null
  const savedNoveltyScore = draft?.noveltySignal?.score ?? null

  const activeFollowUp = draft?.followUps.find((followUp) => followUp.state === 'active')
  const ideaPending = operations.hasPending('idea')
  const followUpSlot = pendingFollowUp ? `follow-up:${pendingFollowUp.questionId}` : null
  const followUpPending = followUpSlot !== null && operations.hasPending(followUpSlot)
  const revisionSlot = pendingRevisionId ? `follow-up-revision:${pendingRevisionId}` : null
  const revisionPending = revisionSlot !== null && operations.hasPending(revisionSlot)
  const freshnessPending = operations.hasPending('freshness')
  const submitPending = operations.hasPending('final-submit')
  useEffect(() => {
    const remaining = intake.applicationsCloseAt - Date.now()
    if (remaining <= 0) {
      setApplicationsOpen(false)
      stopEditing()
      return
    }
    setApplicationsOpen(true)
    const timer = window.setTimeout(() => {
      setApplicationsOpen(false)
      stopEditing()
    }, Math.min(remaining + 50, 2_147_000_000))
    return () => window.clearTimeout(timer)
  }, [intake.applicationsCloseAt, stopEditing])

  useEffect(() => {
    const savedValue = draft?.initialIdea ?? ''
    const savedVersion = draft?.version ?? 0
    if (!ideaDirty) {
      ideaBase.current = { version: savedVersion }
      setIdea(savedValue)
      setIdeaConflict(false)
      return
    }
    if (savedVersion !== ideaBase.current.version) setIdeaConflict(true)
  }, [draft?.initialIdea, draft?.version, ideaDirty])

  useEffect(() => {
    const nextQuestionId = activeFollowUp?.id ?? null
    if (followUpBase.current.questionId === nextQuestionId) return
    const priorQuestionId = followUpBase.current.questionId
    if (priorQuestionId && answer.trim()) {
      setRecoveredFollowUp({ answer, questionId: priorQuestionId })
    }
    const currentVersion = draft?.version ?? 0
    if (!nextQuestionId) {
      followUpBase.current = { questionId: null, version: currentVersion }
      setFollowUpConflict(false)
      setAnswer('')
      return
    }
    const recovered = readVersionedSessionDraft(
      `c2c:${eventSlug}:${team.id}:follow-up:${nextQuestionId}`,
    )
    const recoveredVersion = recovered ? storedDraftVersion(recovered.base) : null
    followUpBase.current = {
      questionId: nextQuestionId,
      version: recoveredVersion ?? currentVersion,
    }
    setFollowUpConflict(sessionDraftConflicts(recovered, String(currentVersion)))
    setAnswer(recovered?.value ?? '')
  }, [activeFollowUp?.id, answer, draft?.version, team.id])

  useEffect(() => {
    if (
      activeFollowUp &&
      answer.trim() &&
      followUpBase.current.questionId === activeFollowUp.id &&
      followUpBase.current.version !== (draft?.version ?? 0)
    ) setFollowUpConflict(true)
  }, [activeFollowUp, answer, draft?.version])

  useEffect(() => {
    noveltySequence.current += 1
    const sequence = noveltySequence.current
    const savedIdeaMatches =
      draft?.initialIdea !== undefined &&
      draft.initialIdea.trim().replace(/\s+/g, ' ') === idea.trim().replace(/\s+/g, ' ')

    if (noveltyCorpusVersionId !== null && savedNoveltyScore !== null && savedIdeaMatches) {
      setNoveltyState({
        status: 'ready',
        signal: {
          score: savedNoveltyScore,
        },
      })
      return
    }

    if (
      !ideaEditorOpen ||
      noveltyCorpusVersionId === null ||
      noveltyMinimumIdeaLength === null ||
      noveltyDebounceMs === null ||
      normalizedIdeaLength(idea) < noveltyMinimumIdeaLength
    ) {
      setNoveltyState({ status: 'idle' })
      return
    }

    setNoveltyState({ status: 'checking' })
    const timer = window.setTimeout(() => {
      void previewNovelty({
        eventSlug,
        corpusVersionId: noveltyCorpusVersionId,
        idea,
        clientRequestId: crypto.randomUUID(),
      })
        .then((result) => {
          if (noveltySequence.current !== sequence) return
          if (result.state === 'unavailable') {
            setNoveltyState({ status: 'unavailable' })
            return
          }
          setNoveltyState({
            status: 'ready',
            signal: {
              score: result.score,
            },
          })
        })
        .catch(() => {
          if (noveltySequence.current === sequence) {
            setNoveltyState({ status: 'unavailable' })
          }
        })
    }, noveltyDebounceMs)

    return () => window.clearTimeout(timer)
  }, [
    draft?.initialIdea,
    idea,
    ideaEditorOpen,
    noveltyCorpusVersionId,
    noveltyDebounceMs,
    noveltyMinimumIdeaLength,
    previewNovelty,
    savedNoveltyScore,
  ])

  const run = async (command: () => Promise<unknown>) => {
    if (commandInFlight.current) return
    commandInFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await command()
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      commandInFlight.current = false
      setBusy(false)
    }
  }

  const submitIdea = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      await operations.run('idea', (clientOperationId) => () => saveIdea({
          eventSlug,
          idea,
          expectedDraftVersion: ideaBase.current.version,
          clientOperationId,
        }))
      clearSessionDraft(ideaStorageKey)
      setIdeaDirty(false)
      setIdeaConflict(false)
      stopEditing()
      setEditingIdea(false)
    })
  }

  const submitAnswer = (event: FormEvent) => {
    event.preventDefault()
    if (!activeFollowUp) return
    void run(async () => {
      const slot = `follow-up:${activeFollowUp.id}`
      if (!operations.hasPending(slot)) {
        setPendingFollowUp({ questionId: activeFollowUp.id, kind: 'answer' })
      }
      await operations.run(slot, (clientOperationId) => () => respondToFollowUp({
          eventSlug,
          questionId: activeFollowUp.id,
          answer,
          skipped: false,
          expectedDraftVersion: followUpBase.current.version,
          clientOperationId,
        }))
      clearSessionDraft(`c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`)
      setAnswer('')
      setFollowUpConflict(false)
      stopEditing()
      setPendingFollowUp(null)
    })
  }

  const pendingOperation: PendingIntakeOperation | null = ideaPending
    ? { kind: 'idea', slot: 'idea', action: 'Confirm idea' }
    : followUpPending && pendingFollowUp
        ? {
            kind: 'follow_up',
            slot: `follow-up:${pendingFollowUp.questionId}`,
            action: pendingFollowUp.kind === 'skip' ? 'Confirm skip' : 'Confirm answer',
          }
        : revisionPending && pendingRevisionId
          ? {
              kind: 'revision',
              slot: `follow-up-revision:${pendingRevisionId}`,
              action: pendingRevisionKind === 'skip' ? 'Confirm skip' : 'Confirm answer',
            }
          : freshnessPending
              ? { kind: 'freshness', slot: 'freshness', action: 'Confirm answer' }
              : submitPending
                ? { kind: 'submit', slot: 'final-submit', action: 'Confirm submission' }
                : null

  const clearPendingOperation = (operation: PendingIntakeOperation) => {
    if (operation.kind === 'idea') {
      setEditingIdea(false)
      return
    }
    if (operation.kind === 'follow_up') {
      setPendingFollowUp(null)
      return
    }
    if (operation.kind === 'revision') {
      setPendingRevisionId(null)
      setPendingRevisionKind(null)
      setEditingFollowUpId(null)
    }
  }

  const confirmPendingOperation = (operation: PendingIntakeOperation) => {
    void run(async () => {
      try {
        await operations.retryPending(operation.slot)
      } catch (caught) {
        if (!operations.hasPending(operation.slot)) clearPendingOperation(operation)
        throw caught
      }
      clearPendingOperation(operation)
    })
  }

  if (pendingOperation) {
    return (
      <IntakeFrame label="Saving">
        <h1>{busy ? 'Saving your change…' : 'Confirm your last change.'}</h1>
        <p className="minimal-step-hint">
          {busy ? 'Keep this page open.' : 'The response was interrupted. Confirm it before continuing.'}
        </p>
        <ErrorNotice message={error} />
        <button
          type="button"
          className="minimal-continue"
          disabled={busy}
          onClick={() => confirmPendingOperation(pendingOperation)}
        >
          {busy ? 'Saving…' : pendingOperation.action} <span aria-hidden="true">→</span>
        </button>
      </IntakeFrame>
    )
  }

  if (!applicationsOpen) {
    return (
      <IntakeFrame label="Project idea">
        <h1>Applications are closed.</h1>
        <p className="minimal-step-hint">Your team’s saved work remains available here.</p>
        {draft?.initialIdea ? <p className="preserve-lines">{draft.initialIdea}</p> : null}
      </IntakeFrame>
    )
  }

  if (!draft || draft.stage === 'opening' || editingIdea) {
    if (opening === undefined) {
      return <IntakeFrame label="Project idea"><p className="minimal-step-hint">Loading…</p></IntakeFrame>
    }
    const initialIdeaMinLength = draft?.intakePolicy.initialIdeaMinLength ?? opening.initialIdeaMinLength
    const initialIdeaMaxLength = draft?.intakePolicy.initialIdeaMaxLength ?? opening.initialIdeaMaxLength
    return (
      <IntakeFrame label="Project idea">
        <h1>{opening.initialPrompt}</h1>
        <p className="minimal-step-hint">{opening.initialHelpText}</p>
        <form onSubmit={submitIdea} className="minimal-textarea-surface">
          <EditingPresence editors={editors ?? []} members={members} />
          {ideaConflict ? (
            <div className="notice" role="status">
              <p>A teammate saved a newer idea. Your text is still here.</p>
              <div className="button-row">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    const savedValue = draft?.initialIdea ?? ''
                    setIdea(savedValue)
                    setIdeaDirty(false)
                    setIdeaConflict(false)
                    ideaBase.current = { version: draft?.version ?? 0 }
                    clearSessionDraft(ideaStorageKey)
                  }}
                >
                  Use saved version
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    ideaBase.current = { version: draft?.version ?? 0 }
                    setIdeaConflict(false)
                    writeVersionedSessionDraft(ideaStorageKey, {
                      base: String(ideaBase.current.version),
                      value: idea,
                    })
                  }}
                >
                  Keep mine
                </button>
              </div>
            </div>
          ) : null}
          <NoveltyCounter
            state={noveltyState}
            currentLength={normalizedIdeaLength(idea)}
            minimumLength={novelty?.minimumIdeaLength ?? null}
          />
          <TextArea
            autoFocus
            required
            minLength={initialIdeaMinLength}
            maxLength={initialIdeaMaxLength}
            rows={9}
            disabled={busy}
            value={idea}
            onChange={(event) => {
              const nextIdea = event.currentTarget.value
              noveltySequence.current += 1
              setIdea(nextIdea)
              setIdeaDirty(true)
              writeVersionedSessionDraft(ideaStorageKey, {
                base: String(ideaBase.current.version),
                value: nextIdea,
              })
              markEditing('idea')
              setNoveltyState(
                novelty && normalizedIdeaLength(nextIdea) >= novelty.minimumIdeaLength
                  ? { status: 'checking' }
                  : { status: 'idle' },
              )
            }}
            placeholder="Describe your idea…"
          />
          <ErrorNotice message={error} />
          <div className="minimal-surface-actions">
            {editingIdea ? (
              <button
                type="button"
                className="minimal-back"
                disabled={busy}
                onClick={() => {
                  setIdea(draft?.initialIdea ?? '')
                  setIdeaDirty(false)
                  setIdeaConflict(false)
                  ideaBase.current = { version: draft?.version ?? 0 }
                  clearSessionDraft(ideaStorageKey)
                  stopEditing()
                  setEditingIdea(false)
                  setError(null)
                }}
              >
                Cancel
              </button>
              ) : <span className="character-count">{idea.length} / {initialIdeaMaxLength}</span>}
            <span className="minimal-privacy">Do not include private contact details.</span>
            <button type="submit" className="minimal-continue" disabled={busy || ideaConflict || idea.trim().length < initialIdeaMinLength}>
              {busy ? 'Saving…' : 'Continue'} <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
      </IntakeFrame>
    )
  }

  if (draft.stage === 'follow_up') {
    if (!activeFollowUp) {
      return (
        <IntakeFrame label="One more question">
          <h1>One moment.</h1>
          <p className="minimal-step-hint">Preparing one short question from what your team has shared.</p>
        </IntakeFrame>
      )
    }
    return (
      <IntakeFrame label="One more question">
        <h1>{activeFollowUp.question}</h1>
        <p className="minimal-step-hint">Keep it short—one or two sentences is plenty.</p>
        <form onSubmit={submitAnswer} className="minimal-textarea-surface compact-surface">
          <EditingPresence editors={editors ?? []} members={members} />
          {followUpConflict ? (
            <div className="notice" role="status">
              <p>A teammate saved a newer draft while this answer was unsaved. Your text is still here.</p>
              <div className="button-row">
                <button type="button" className="text-button" onClick={() => {
                  setAnswer('')
                  followUpBase.current = {
                    questionId: activeFollowUp.id,
                    version: draft.version,
                  }
                  setFollowUpConflict(false)
                  clearSessionDraft(`c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`)
                }}>Use saved version</button>
                <button type="button" className="text-button" onClick={() => {
                  followUpBase.current = {
                    questionId: activeFollowUp.id,
                    version: draft.version,
                  }
                  setFollowUpConflict(false)
                  writeVersionedSessionDraft(
                    `c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`,
                    { base: String(draft.version), value: answer },
                  )
                }}>Keep mine</button>
              </div>
            </div>
          ) : null}
          <TextArea
            autoFocus
            required
            minLength={draft.intakePolicy.followUpAnswerMinLength}
            maxLength={draft.intakePolicy.followUpAnswerMaxLength}
            rows={6}
            disabled={busy}
            value={answer}
            onChange={(event) => {
              setAnswer(event.target.value)
              writeVersionedSessionDraft(
                `c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`,
                {
                  base: String(followUpBase.current.version),
                  value: event.target.value,
                },
              )
              markEditing('follow_up')
            }}
            placeholder="Type your answer…"
          />
          <ErrorNotice message={error} />
          <div className="minimal-surface-actions">
            <button type="button" className="minimal-back" disabled={busy} onClick={() => {
              ideaBase.current = { version: draft.version }
              setIdea(draft.initialIdea ?? '')
              setIdeaDirty(false)
              setEditingIdea(true)
            }}>
              Edit idea
            </button>
            <button
              type="button"
              className="minimal-back"
              disabled={busy || followUpConflict}
              onClick={() => void run(async () => {
                const slot = `follow-up:${activeFollowUp.id}`
                if (!operations.hasPending(slot)) {
                  setPendingFollowUp({ questionId: activeFollowUp.id, kind: 'skip' })
                }
                await operations.run(slot, (clientOperationId) => () => respondToFollowUp({
                  eventSlug,
                  questionId: activeFollowUp.id,
                  skipped: true,
                  expectedDraftVersion: followUpBase.current.version,
                  clientOperationId,
                }))
                clearSessionDraft(`c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`)
                setAnswer('')
                setFollowUpConflict(false)
                stopEditing()
                setPendingFollowUp(null)
              })}
            >
              Skip
            </button>
            <span className="character-count">{answer.length} / {draft.intakePolicy.followUpAnswerMaxLength}</span>
            <button type="submit" className="minimal-continue" disabled={busy || followUpConflict || answer.trim().length < draft.intakePolicy.followUpAnswerMinLength}>
              {busy ? 'Saving…' : 'Continue'} <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
      </IntakeFrame>
    )
  }

  if (draft.stage === 'review') {
    if (preview === undefined || preview === null) {
      return (
        <IntakeFrame label="Final check">
          <h1>Putting everything together…</h1>
          <p className="minimal-step-hint">Your current team and idea will appear here.</p>
        </IntakeFrame>
      )
    }
    const confirmationKey = [
      preview.participantPolicyVersionId,
      preview.teamVersion,
      preview.draftVersion,
    ].join(':')
    const confirmedLock = confirmedSnapshotKey === confirmationKey
    const revisionConflict =
      editingFollowUpId !== null &&
      revisionBaseVersion !== null &&
      revisionBaseVersion !== preview.draftVersion
    const canSubmit =
      preview.blockers.length === 0 &&
      confirmedLock &&
      editors !== undefined &&
      editors.length === 0 &&
      team.currentRole === 'lead' &&
      team.canSubmitApplication
    return (
      <IntakeFrame label="Final check" wide>
        <h1>Everything look right?</h1>
        <p className="minimal-step-hint">Submitting locks your current team. The lead can still revise the proposal until the application deadline.</p>
        <EditingPresence editors={editors ?? []} members={members} />
        <div className="minimal-review-layout">
          <div className="minimal-review-card">
            <div className="review-card-heading">
              <div>
                <span>Application preview</span>
                <strong>{preview.teamName}</strong>
              </div>
            </div>
            <div className="review-grid">
              <div className="review-block team-review-block">
                <span className="field-label">Team · {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}</span>
                <ul className="plain-list">
                  {preview.members.map((member) => (
                    <li key={member.membershipId}>
                      <span>{member.displayName}</span>
                      <small>
                        {member.role === 'lead' ? 'Team lead' : 'Member'}
                        {member.submissionReady ? '' : ' · needs attention before submission'}
                      </small>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="review-block project-review-block">
              <span className="field-label">Your idea</span>
              <p className="preserve-lines">{preview.initialIdea}</p>
              {recoveredFollowUp ? (
                <div className="notice" role="status">
                  <p>A teammate answered while you were typing. Your draft is still available.</p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setEditingFollowUpId(recoveredFollowUp.questionId)
                      setEditedFollowUpAnswer(recoveredFollowUp.answer)
                      setRevisionBaseVersion(preview.draftVersion)
                      setRecoveredFollowUp(null)
                    }}
                  >
                    Review my draft
                  </button>
                </div>
              ) : null}
              {preview.followUps.map((followUp) => (
                <div className="review-follow-up" key={followUp.id}>
                  <p className="review-question">{followUp.question}</p>
                  {editingFollowUpId === followUp.id ? (
                    <form
                      className="review-follow-up-editor"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void run(async () => {
                          const slot = `follow-up-revision:${followUp.id}`
                          if (!operations.hasPending(slot)) {
                            setPendingRevisionId(followUp.id)
                            setPendingRevisionKind('answer')
                          }
                          await operations.run(slot, (clientOperationId) => () => reviseFollowUp({
                              eventSlug,
                              questionId: followUp.id,
                              answer: editedFollowUpAnswer,
                              skipped: false,
                              expectedDraftVersion: revisionBaseVersion ?? preview.draftVersion,
                              clientOperationId,
                            }))
                          setPendingRevisionId(null)
                          setPendingRevisionKind(null)
                          setEditingFollowUpId(null)
                          setRevisionBaseVersion(null)
                          stopEditing()
                        })
                      }}
                    >
                      <TextArea
                        autoFocus
                        required
                        minLength={draft.intakePolicy.followUpAnswerMinLength}
                        maxLength={draft.intakePolicy.followUpAnswerMaxLength}
                        rows={4}
                        disabled={busy}
                        value={editedFollowUpAnswer}
                        onChange={(event) => {
                          setEditedFollowUpAnswer(event.target.value)
                          markEditing('follow_up')
                        }}
                      />
                      {revisionConflict ? (
                        <div className="notice" role="status">
                          <p>A teammate saved a newer answer. Your text is still here.</p>
                          <div className="button-row">
                            <button type="button" className="text-button" onClick={() => {
                              setEditedFollowUpAnswer(followUp.answer ?? '')
                              setRevisionBaseVersion(preview.draftVersion)
                            }}>Use saved version</button>
                            <button type="button" className="text-button" onClick={() => {
                              setRevisionBaseVersion(preview.draftVersion)
                            }}>Keep mine</button>
                          </div>
                        </div>
                      ) : null}
                      <div className="button-row">
                        <button className="secondary" disabled={busy} type="button" onClick={() => {
                          setEditingFollowUpId(null)
                          setRevisionBaseVersion(null)
                          stopEditing()
                        }}>Cancel</button>
                        <button className="secondary" disabled={busy} type="button" onClick={() => void run(async () => {
                          const slot = `follow-up-revision:${followUp.id}`
                          if (!operations.hasPending(slot)) {
                            setPendingRevisionId(followUp.id)
                            setPendingRevisionKind('skip')
                          }
                          await operations.run(slot, (clientOperationId) => () => reviseFollowUp({
                              eventSlug,
                              questionId: followUp.id,
                              skipped: true,
                              expectedDraftVersion: revisionBaseVersion ?? preview.draftVersion,
                              clientOperationId,
                            }))
                          setPendingRevisionId(null)
                          setPendingRevisionKind(null)
                          setEditingFollowUpId(null)
                          setRevisionBaseVersion(null)
                          stopEditing()
                        })}>Skip answer</button>
                        <button className="primary" disabled={busy || revisionConflict || editedFollowUpAnswer.trim().length < draft.intakePolicy.followUpAnswerMinLength} type="submit">
                          Save
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <p className="preserve-lines muted">{followUp.skipped ? 'Skipped' : followUp.answer}</p>
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditingFollowUpId(followUp.id)
                          setEditedFollowUpAnswer(followUp.answer ?? '')
                          setRevisionBaseVersion(preview.draftVersion)
                        }}
                      >
                        Edit answer
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="minimal-confirmation-card">
            <label className="check-row lock-confirmation">
              <input
                type="checkbox"
                checked={preview.freshnessAttested}
                disabled={busy}
                onChange={(event) => {
                  const accepted = event.target.checked
                  void run(async () => {
                    await operations.run('freshness', (clientOperationId) => () => setFreshness({
                      eventSlug,
                      accepted,
                      expectedDraftVersion: preview.draftVersion,
                      clientOperationId,
                    }))
                  })
                }}
              />
              <span>We will begin project-specific implementation and design after the official start.</span>
            </label>
            <label className="check-row lock-confirmation strong-warning">
              <input
                type="checkbox"
                checked={confirmedLock}
                disabled={busy}
                onChange={(event) => setConfirmedSnapshotKey(event.target.checked ? confirmationKey : null)}
              />
              <span>{preview.warning}</span>
            </label>
            {preview.blockers.length ? (
              <ul className="blocker-list">
                {preview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
              </ul>
            ) : null}
            {team.currentRole !== 'lead' ? <p className="notice">The team lead must submit.</p> : null}
            {team.currentRole === 'lead' && !team.canSubmitApplication ? (
              <p className="notice">Submission is unavailable. Ask an organizer if this looks wrong.</p>
            ) : null}
            {editors !== undefined && editors.length > 0 ? (
              <p className="notice">Wait for your teammate’s current edit before submitting.</p>
            ) : null}
            <ErrorNotice message={error} />
            <div className="minimal-surface-actions">
              <button type="button" className="minimal-back" disabled={busy} onClick={() => {
                const savedIdea = preview.initialIdea ?? ''
                ideaBase.current = { version: preview.draftVersion }
                setIdea(savedIdea)
                setIdeaDirty(false)
                setEditingIdea(true)
              }}>Edit idea</button>
              <button
                type="button"
                className="minimal-continue"
                disabled={busy || !canSubmit}
                onClick={() => {
                  void run(() => operations.run(
                    'final-submit',
                    (clientOperationId) => () => submitApplication({
                      eventSlug,
                      expectedDraftVersion: preview.draftVersion,
                      expectedTeamVersion: preview.teamVersion,
                      participantPolicyVersionId: preview.participantPolicyVersionId,
                      clientOperationId,
                    }),
                  ))
                }}
              >
                {busy ? 'Submitting…' : 'Confirm and submit'} <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>
        </div>
      </IntakeFrame>
    )
  }

  return null
}

function IntakeFrame({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={wide ? 'minimal-step wide-step' : 'minimal-step'} aria-label={`Application · ${label}`}>
      <p className="minimal-step-count">{label}</p>
      {children}
    </section>
  )
}

function NoveltyCounter({
  state,
  currentLength,
  minimumLength,
}: {
  state: NoveltyState
  currentLength: number
  minimumLength: number | null
}) {
  if (minimumLength === null) return null
  const value = currentLength < minimumLength || state.status === 'idle'
    ? '—'
    : state.status === 'checking'
      ? '…'
      : state.status === 'unavailable'
        ? '—'
        : String(state.signal.score)
  return (
    <p className="novelty-score" aria-live="polite" aria-label="Live novelty score">
      <span>Novelty</span>
      <strong>{value}<small>/100</small></strong>
    </p>
  )
}
