import { api } from '@code2create/backend/api'
import { useAction, useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { EditingPresence } from '../components/EditingPresence'
import { PortalScene } from '../components/portal/PortalScene'
import { PetalCard } from '../components/portal/PetalCard'
import { PortalButton, PortalTextButton } from '../components/portal/PortalButton'
import { Petal, SakuraSteps } from '../components/portal/Petal'
import { TeamCluster } from '../components/portal/TeamCluster'
import { initialsOf } from '../components/portal/initials'
import {
  PortalCheckRow,
  PortalError,
  PortalTextarea,
} from '../components/portal/PortalField'
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
  if (intake === undefined) {
    return (
      <IntakeStage team={team} members={members} title="Loading your application…" />
    )
  }
  if (intake === null) {
    return (
      <IntakeStage team={team} members={members} title="Your application is unavailable." />
    )
  }
  if (!team.canWriteProject) {
    return <ReadOnlyIntake team={team} intake={intake} members={members} />
  }
  return (
    <IntakeWorkspace
      team={team}
      intake={intake}
      members={members}
      {...(submissionFailureMessage === undefined ? {} : { submissionFailureMessage })}
    />
  )
}

function IntakeTeamCluster({
  team,
  members,
}: {
  team: CurrentTeam
  members: readonly CurrentTeamMember[]
}) {
  const leaveTeam = useMutation(api.teams.leave)
  const operations = useOperationRunner<FunctionReturnType<typeof api.teams.leave>>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const leavePending = operations.hasPending('team-leave')
  const leadMustTransfer = team.currentRole === 'lead' && team.activeMemberCount > 1

  const leave = async () => {
    setBusy(true)
    setError(null)
    try {
      await operations.run('team-leave', (clientOperationId) => () => leaveTeam({
        eventSlug,
        teamId: team.id,
        expectedTeamVersion: team.version,
        clientOperationId,
      }))
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TeamCluster
      team={team}
      members={members}
      leaveAction={{
        available: team.canLeave && !leadMustTransfer,
        ...(leadMustTransfer
          ? { blockedMessage: 'Transfer leadership before leaving this team.' }
          : !team.canLeave
            ? { blockedMessage: 'Leaving this team is unavailable.' }
            : {}),
        pending: busy,
        retrying: leavePending,
        error,
        onConfirm: leave,
      }}
    />
  )
}

/**
 * The shared stage for every intake step: the night scene, the team cluster in
 * the corner, an optional petal step counter, a title, and a card.
 */
function IntakeStage({
  team,
  members,
  title,
  eyebrow,
  hint,
  steps,
  children,
  footer,
  floating,
  width = 'max-w-[820px]',
  titleClass = 'lg:text-[38px]',
  branch = false,
}: {
  team: CurrentTeam
  members: readonly CurrentTeamMember[]
  title: string
  eyebrow?: string
  hint?: string
  steps?: { total: number; current: number }
  children?: ReactNode
  footer?: ReactNode
  /** Pinned to the top of the scene, the way the mockup floats the novelty pill. */
  floating?: ReactNode
  width?: string
  titleClass?: string
  branch?: boolean
}) {
  return (
    <PortalScene
      tree="left"
      branch={branch}
      header={<IntakeTeamCluster team={team} members={members} />}
    >
      {floating ? (
        <div className="pointer-events-none absolute inset-x-0 top-[38px] z-[6] flex justify-center">
          {floating}
        </div>
      ) : null}
      <div className={`flex w-full flex-col items-center ${width}`}>
        {steps ? (
          <div className="mb-4.5">
            <SakuraSteps total={steps.total} current={steps.current} />
          </div>
        ) : null}
        {eyebrow ? (
          <p className="mb-2.5 text-[10.5px] font-semibold tracking-[.14em] text-[rgb(248_248_248/.45)] uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1
          className={`mb-6 max-w-[760px] text-center font-display text-[26px] leading-tight italic text-shadow-[0_4px_30px_rgba(0,0,0,.55)] ${titleClass}`}
        >
          {title}
        </h1>
        {hint ? (
          <p className="-mt-3 mb-6 text-[12.5px] text-[rgb(248_248_248/.5)]">{hint}</p>
        ) : null}
        {children}
        {footer}
      </div>
    </PortalScene>
  )
}

/** The conflict banner shared by the idea and follow-up editors. */
function ConflictNotice({
  message,
  onUseSaved,
  onKeepMine,
}: {
  message: string
  onUseSaved: () => void
  onKeepMine: () => void
}) {
  return (
    <div
      role="status"
      className="mb-4 rounded-petal-xs border border-petal-edge-soft bg-[rgb(12_0_4/.5)] px-4 py-3"
    >
      <p className="text-[12.5px] text-[rgb(248_248_248/.75)]">{message}</p>
      <div className="mt-2 flex gap-4">
        <PortalTextButton type="button" onClick={onUseSaved}>
          Use saved version
        </PortalTextButton>
        <PortalTextButton type="button" onClick={onKeepMine}>
          Keep mine
        </PortalTextButton>
      </div>
    </div>
  )
}

function ReadOnlyIntake({
  team,
  intake,
  members,
}: {
  team: CurrentTeam
  intake: CurrentIntake
  members: CurrentTeamMember[]
}) {
  const { editors } = useEditingPresence(false)
  const draft = intake.draft
  return (
    <IntakeStage
      team={team}
      members={members}
      title="Project editing is unavailable."
      hint="Your team’s saved work remains here. Another member with project access can continue."
    >
      <EditingPresence editors={editors ?? []} members={members} />
      {draft?.initialIdea ? (
        <PetalCard className="px-8 py-7">
          <p className="whitespace-pre-line text-[15px] leading-relaxed text-[rgb(248_248_248/.9)]">
            {draft.initialIdea}
          </p>
        </PetalCard>
      ) : null}
    </IntakeStage>
  )
}

function IntakeWorkspace({
  team,
  intake,
  members,
  submissionFailureMessage,
}: {
  team: CurrentTeam
  intake: CurrentIntake
  members: CurrentTeamMember[]
  submissionFailureMessage?: string
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
  // The mockup splits the old single review screen into reading the proposal
  // (f5) and confirming the lock (f6).
  const [confirming, setConfirming] = useState(false)
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
      setNoveltyState({ status: 'ready', signal: { score: savedNoveltyScore } })
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
          setNoveltyState({ status: 'ready', signal: { score: result.score } })
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

  // Petal steps: the idea, then one petal per follow-up the draft has raised.
  const followUpCount = draft?.followUps.length ?? 0
  const stepTotal = Math.max(1 + followUpCount, 1)
  const answeredFollowUps = draft?.followUps.filter((f) => f.state !== 'active').length ?? 0

  if (pendingOperation) {
    return (
      <IntakeStage
        team={team}
        members={members}
        title={busy ? 'Saving your change…' : 'Confirm your last change.'}
        hint={
          busy
            ? 'Keep this page open.'
            : 'The response was interrupted. Confirm it before continuing.'
        }
        width="max-w-[600px]"
      >
        <PortalError message={error} />
        <PortalButton
          type="button"
          className="mt-6"
          disabled={busy}
          onClick={() => confirmPendingOperation(pendingOperation)}
        >
          {busy ? 'Saving…' : pendingOperation.action}
        </PortalButton>
      </IntakeStage>
    )
  }

  if (!applicationsOpen) {
    return (
      <IntakeStage
        team={team}
        members={members}
        title="Applications are closed."
        hint="Your team’s saved work remains available here."
      >
        {draft?.initialIdea ? (
          <PetalCard className="px-8 py-7">
            <p className="whitespace-pre-line text-[15px] leading-relaxed text-[rgb(248_248_248/.9)]">
              {draft.initialIdea}
            </p>
          </PetalCard>
        ) : null}
      </IntakeStage>
    )
  }

  // ---- f2 · the idea -------------------------------------------------------
  if (!draft || draft.stage === 'opening' || editingIdea) {
    if (opening === undefined) {
      return <IntakeStage team={team} members={members} title="Loading…" />
    }
    const initialIdeaMinLength =
      draft?.intakePolicy.initialIdeaMinLength ?? opening.initialIdeaMinLength
    const initialIdeaMaxLength =
      draft?.intakePolicy.initialIdeaMaxLength ?? opening.initialIdeaMaxLength
    return (
      <IntakeStage
        team={team}
        members={members}
        title={opening.initialPrompt}
        hint={opening.initialHelpText}
        steps={{ total: stepTotal, current: 0 }}
        titleClass="lg:text-[42px]"
        floating={
          <NoveltyPill
            state={noveltyState}
            currentLength={normalizedIdeaLength(idea)}
            minimumLength={novelty?.minimumIdeaLength ?? null}
          />
        }
      >
        <PortalError message={submissionFailureMessage ?? null} />
        <PetalCard className="px-6 pt-[26px] pb-[18px] lg:px-[30px]">
          <form onSubmit={submitIdea}>
            <EditingPresence editors={editors ?? []} members={members} />
            {ideaConflict ? (
              <ConflictNotice
                message="A teammate saved a newer idea. Your text is still here."
                onUseSaved={() => {
                  const savedValue = draft?.initialIdea ?? ''
                  setIdea(savedValue)
                  setIdeaDirty(false)
                  setIdeaConflict(false)
                  ideaBase.current = { version: draft?.version ?? 0 }
                  clearSessionDraft(ideaStorageKey)
                }}
                onKeepMine={() => {
                  ideaBase.current = { version: draft?.version ?? 0 }
                  setIdeaConflict(false)
                  writeVersionedSessionDraft(ideaStorageKey, {
                    base: String(ideaBase.current.version),
                    value: idea,
                  })
                }}
              />
            ) : null}
            <PortalTextarea
              autoFocus
              required
              minLength={initialIdeaMinLength}
              maxLength={initialIdeaMaxLength}
              rows={7}
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
              className="min-h-[180px] border-0 bg-transparent px-0 py-0 text-[17px] leading-[1.7] focus:border-0"
            />
            <PortalError message={error} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-petal-line pt-3.5">
              <span className="text-xs text-[rgb(248_248_248/.45)]">
                {idea.length} / {initialIdeaMaxLength} · do not include private contact details
              </span>
              <div className="flex items-center gap-4.5">
                {editingIdea ? (
                  <PortalTextButton
                    type="button"
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
                    cancel
                  </PortalTextButton>
                ) : null}
                <PortalButton
                  type="submit"
                  size="sm"
                  disabled={busy || ideaConflict || idea.trim().length < initialIdeaMinLength}
                >
                  {busy ? 'Saving…' : 'Next'}
                </PortalButton>
              </div>
            </div>
          </form>
        </PetalCard>
      </IntakeStage>
    )
  }

  // ---- f3 / f4 · the follow-ups -------------------------------------------
  if (draft.stage === 'follow_up') {
    if (!activeFollowUp) {
      return (
        <IntakeStage
          team={team}
          members={members}
          title="One moment."
          hint="Preparing one short question from what your team has shared."
        />
      )
    }
    const isLast = answeredFollowUps + 1 >= followUpCount
    const minLength = draft.intakePolicy.followUpAnswerMinLength
    return (
      <IntakeStage
        team={team}
        members={members}
        eyebrow={isLast ? 'last one · then review' : 'asked because of your idea'}
        title={activeFollowUp.question}
        steps={{ total: stepTotal, current: answeredFollowUps + 1 }}
        footer={
          answer.trim().length < minLength ? (
            <p className="mt-5 text-[11.5px] text-[rgb(248_248_248/.4)]">
              the Next button wakes up when you write something
            </p>
          ) : null
        }
      >
        <PetalCard className="px-6 pt-[26px] pb-[18px] lg:px-[30px]">
          <form onSubmit={submitAnswer}>
            <EditingPresence editors={editors ?? []} members={members} />
            {followUpConflict ? (
              <ConflictNotice
                message="A teammate saved a newer draft while this answer was unsaved. Your text is still here."
                onUseSaved={() => {
                  setAnswer('')
                  followUpBase.current = {
                    questionId: activeFollowUp.id,
                    version: draft.version,
                  }
                  setFollowUpConflict(false)
                  clearSessionDraft(`c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`)
                }}
                onKeepMine={() => {
                  followUpBase.current = {
                    questionId: activeFollowUp.id,
                    version: draft.version,
                  }
                  setFollowUpConflict(false)
                  writeVersionedSessionDraft(
                    `c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`,
                    { base: String(draft.version), value: answer },
                  )
                }}
              />
            ) : null}
            <PortalTextarea
              autoFocus
              required
              minLength={minLength}
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
              placeholder="Scope it in a sentence or two…"
              className="min-h-[174px] border-0 bg-transparent px-0 py-0 text-[16.5px] leading-[1.7] focus:border-0"
            />
            <PortalError message={error} />
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3 border-t border-petal-line pt-3">
              <span className="text-xs text-[rgb(248_248_248/.45)]">
                {answer.length} / {draft.intakePolicy.followUpAnswerMaxLength} · a sentence or two
                is plenty
              </span>
              <div className="flex items-center gap-4.5">
                <PortalTextButton
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    ideaBase.current = { version: draft.version }
                    setIdea(draft.initialIdea ?? '')
                    setIdeaDirty(false)
                    setEditingIdea(true)
                  }}
                >
                  edit idea
                </PortalTextButton>
                <PortalTextButton
                  type="button"
                  disabled={busy || followUpConflict}
                  onClick={() =>
                    void run(async () => {
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
                      clearSessionDraft(
                        `c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`,
                      )
                      setAnswer('')
                      setFollowUpConflict(false)
                      stopEditing()
                      setPendingFollowUp(null)
                    })
                  }
                >
                  skip
                </PortalTextButton>
                <PortalButton
                  type="submit"
                  size="sm"
                  disabled={busy || followUpConflict || answer.trim().length < minLength}
                >
                  {busy ? 'Saving…' : isLast ? 'Review' : 'Next'}
                </PortalButton>
              </div>
            </div>
          </form>
        </PetalCard>
      </IntakeStage>
    )
  }

  // ---- f5 / f6 · review, then confirm --------------------------------------
  if (draft.stage === 'review') {
    if (preview === undefined || preview === null) {
      return (
        <IntakeStage
          team={team}
          members={members}
          title="Putting everything together…"
          hint="Your current team and idea will appear here."
        />
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

    const editIdea = () => {
      const savedIdea = preview.initialIdea ?? ''
      ideaBase.current = { version: preview.draftVersion }
      setIdea(savedIdea)
      setIdeaDirty(false)
      setEditingIdea(true)
    }

    // f6 · confirm
    if (confirming) {
      return (
        <IntakeStage
          team={team}
          members={members}
          title="Ready to submit?"
          steps={{ total: stepTotal, current: stepTotal }}
          width="max-w-[600px]"
          titleClass="lg:text-[42px]"
          branch
        >
          <PetalCard className="px-8 pt-7 pb-4">
            <div className="mb-3.5 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="mb-1 truncate text-[15.5px] font-semibold">{preview.teamName}</p>
                <p className="text-xs text-[rgb(248_248_248/.5)]">
                  proposal + {preview.followUps.length}{' '}
                  {preview.followUps.length === 1 ? 'answer' : 'answers'} ·{' '}
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="text-rose-light underline-offset-2 hover:underline"
                  >
                    review
                  </button>
                </p>
              </div>
              <div
                className="flex flex-none"
                title={preview.members.map((member) => member.displayName).join(', ')}
              >
                {preview.members.map((member, index) => (
                  <div
                    key={member.membershipId}
                    className={`flex size-8 items-center justify-center rounded-full text-[10.5px] font-semibold ${
                      member.role === 'lead'
                        ? 'border-[1.5px] border-rose-light bg-avatar-lead'
                        : 'border-[1.5px] border-[rgb(216_132_162/.7)] bg-avatar'
                    } ${index > 0 ? '-ml-2' : ''}`}
                  >
                    {initialsOf(member.displayName)}
                  </div>
                ))}
              </div>
            </div>

            <p className="mb-4 border-t border-petal-line pt-4 font-display text-[17px] leading-normal italic text-rose-light">
              {preview.warning}
            </p>

            <div className="flex flex-col gap-3">
              <PortalCheckRow
                checked={preview.freshnessAttested}
                disabled={busy}
                onChange={(accepted) => {
                  void run(async () => {
                    await operations.run('freshness', (clientOperationId) => () => setFreshness({
                      eventSlug,
                      accepted,
                      expectedDraftVersion: preview.draftVersion,
                      clientOperationId,
                    }))
                  })
                }}
              >
                We will begin project-specific implementation and design after the official start.
              </PortalCheckRow>
              <PortalCheckRow
                checked={confirmedLock}
                disabled={busy}
                onChange={(checked) => setConfirmedSnapshotKey(checked ? confirmationKey : null)}
              >
                I understand submitting locks the team.
              </PortalCheckRow>
            </div>

            {preview.members.some((member) => !member.submissionReady) ? (
              <p className="mt-4 text-[12.5px] text-rose-light">
                Needs attention before submission:{' '}
                {preview.members
                  .filter((member) => !member.submissionReady)
                  .map((member) => member.displayName)
                  .join(', ')}
              </p>
            ) : null}
            {preview.blockers.length ? (
              <ul className="mt-4 list-disc space-y-1 pl-5 text-[12.5px] text-rose-light">
                {preview.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            ) : null}
            {team.currentRole !== 'lead' ? (
              <p className="mt-4 text-[12.5px] text-rose-light">The team lead must submit.</p>
            ) : null}
            {team.currentRole === 'lead' && !team.canSubmitApplication ? (
              <p className="mt-4 text-[12.5px] text-rose-light">
                Submission is unavailable. Ask an organizer if this looks wrong.
              </p>
            ) : null}
            {editors !== undefined && editors.length > 0 ? (
              <p className="mt-4 text-[12.5px] text-rose-light">
                Wait for your teammate’s current edit before submitting.
              </p>
            ) : null}
            <PortalError message={error ?? submissionFailureMessage ?? null} />

            <div className="mt-4 flex items-center justify-between border-t border-petal-line pt-3.5">
              <PortalTextButton type="button" disabled={busy} onClick={() => setConfirming(false)}>
                back
              </PortalTextButton>
              <PortalButton
                type="button"
                size="sm"
                disabled={busy || !canSubmit}
                onClick={() => {
                  void run(() =>
                    operations.run(
                      'final-submit',
                      (clientOperationId) => () => submitApplication({
                        eventSlug,
                        expectedDraftVersion: preview.draftVersion,
                        expectedTeamVersion: preview.teamVersion,
                        participantPolicyVersionId: preview.participantPolicyVersionId,
                        clientOperationId,
                      }),
                    ),
                  )
                }}
              >
                {busy ? 'Submitting…' : 'Submit proposal'}
              </PortalButton>
            </div>
          </PetalCard>
        </IntakeStage>
      )
    }

    // f5 · the proposal, together
    return (
      <PortalScene tree="left" header={<IntakeTeamCluster team={team} members={members} />}>
        <div className="flex w-full max-w-[760px] flex-col items-center">
          <p className="mb-1.5 font-display text-[17px] italic text-rose-light">
            your proposal, together
          </p>
          <h1 className="mb-7 text-center font-display text-3xl text-shadow-[0_6px_40px_rgba(0,0,0,.6)] lg:text-[44px]">
            {preview.teamName}
          </h1>

          <EditingPresence editors={editors ?? []} members={members} />

          <PetalCard className="px-8 py-6">
            <ReviewSection label="the idea" onEdit={editIdea} busy={busy}>
              <p className="whitespace-pre-line">{preview.initialIdea}</p>
            </ReviewSection>

            {recoveredFollowUp ? (
              <div
                role="status"
                className="mt-4 rounded-petal-xs border border-petal-edge-soft bg-[rgb(12_0_4/.5)] px-4 py-3"
              >
                <p className="text-[12.5px] text-[rgb(248_248_248/.75)]">
                  A teammate answered while you were typing. Your draft is still available.
                </p>
                <PortalTextButton
                  type="button"
                  className="mt-2"
                  onClick={() => {
                    setEditingFollowUpId(recoveredFollowUp.questionId)
                    setEditedFollowUpAnswer(recoveredFollowUp.answer)
                    setRevisionBaseVersion(preview.draftVersion)
                    setRecoveredFollowUp(null)
                  }}
                >
                  Review my draft
                </PortalTextButton>
              </div>
            ) : null}

            {preview.followUps.map((followUp) => (
              <ReviewSection
                key={followUp.id}
                label={followUp.question}
                busy={busy}
                {...(editingFollowUpId === followUp.id
                  ? {}
                  : {
                      onEdit: () => {
                        setEditingFollowUpId(followUp.id)
                        setEditedFollowUpAnswer(followUp.answer ?? '')
                        setRevisionBaseVersion(preview.draftVersion)
                      },
                    })}
              >
                {editingFollowUpId === followUp.id ? (
                  <form
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
                    <PortalTextarea
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
                      <ConflictNotice
                        message="A teammate saved a newer answer. Your text is still here."
                        onUseSaved={() => {
                          setEditedFollowUpAnswer(followUp.answer ?? '')
                          setRevisionBaseVersion(preview.draftVersion)
                        }}
                        onKeepMine={() => setRevisionBaseVersion(preview.draftVersion)}
                      />
                    ) : null}
                    <div className="mt-3 flex items-center gap-4">
                      <PortalTextButton
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditingFollowUpId(null)
                          setRevisionBaseVersion(null)
                          stopEditing()
                        }}
                      >
                        cancel
                      </PortalTextButton>
                      <PortalTextButton
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
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
                          })
                        }
                      >
                        skip answer
                      </PortalTextButton>
                      <PortalButton
                        type="submit"
                        size="sm"
                        className="ml-auto"
                        disabled={
                          busy ||
                          revisionConflict ||
                          editedFollowUpAnswer.trim().length <
                            draft.intakePolicy.followUpAnswerMinLength
                        }
                      >
                        Save
                      </PortalButton>
                    </div>
                  </form>
                ) : (
                  <p className="whitespace-pre-line">
                    {followUp.skipped ? 'Skipped' : followUp.answer}
                  </p>
                )}
              </ReviewSection>
            ))}

          </PetalCard>

          <PortalError message={error ?? submissionFailureMessage ?? null} />

          <div className="mt-8 flex flex-wrap items-center justify-center gap-5">
            <PortalButton type="button" disabled={busy} onClick={() => setConfirming(true)}>
              Continue to submit
            </PortalButton>
            <span className="text-xs text-[rgb(248_248_248/.45)]">
              the next screen locks the team, not the writing
            </span>
          </div>
        </div>
      </PortalScene>
    )
  }

  return null
}

/** One labelled, separately-editable block of the review card (mockup f5). */
function ReviewSection({
  label,
  onEdit,
  busy,
  children,
}: {
  label: string
  onEdit?: () => void
  busy: boolean
  children: ReactNode
}) {
  return (
    <section className="border-b border-petal-line py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-4">
        <span className="text-[11px] tracking-[.06em] text-[rgb(248_248_248/.45)]">{label}</span>
        {onEdit ? (
          <button
            type="button"
            disabled={busy}
            onClick={onEdit}
            className="flex-none text-[11.5px] text-rose-light underline-offset-2 hover:underline disabled:opacity-50"
          >
            edit
          </button>
        ) : null}
      </div>
      <div className="text-sm leading-relaxed text-[rgb(248_248_248/.9)]">{children}</div>
    </section>
  )
}

/**
 * The live novelty read, shown as the floating pill the mockup puts above the
 * idea card. Reads as "N% distinct" once the idea is long enough to score.
 */
function NoveltyPill({
  state,
  currentLength,
  minimumLength,
}: {
  state: NoveltyState
  currentLength: number
  minimumLength: number | null
}) {
  if (minimumLength === null) return null
  const label =
    currentLength < minimumLength || state.status === 'idle'
      ? 'keep writing'
      : state.status === 'checking'
        ? 'checking…'
        : state.status === 'unavailable'
          ? 'novelty unavailable'
          : `${state.signal.score}% distinct`
  return (
    <p
      aria-live="polite"
      aria-label="Live novelty score"
      className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(254_180_203/.45)] bg-[rgb(12_0_4/.55)] px-3.5 py-1.5 text-[11.5px] text-rose-light backdrop-blur-md"
    >
      <Petal size={10} />
      {label}
    </p>
  )
}
