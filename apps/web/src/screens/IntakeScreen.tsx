import { api } from '@code2create/backend/api'
import { useAction, useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { Drawer } from 'vaul'
import { EditingPresence } from '../components/EditingPresence'
import { PortalScene } from '../components/portal/PortalScene'
import {
  AccordionItem,
  AccordionItemContent,
  AccordionItemHeader,
  AccordionItemTrigger,
  AccordionRoot,
} from '../components/portal/Accordion'
import { PetalCard } from '../components/portal/PetalCard'
import { PortalButton, PortalTextButton } from '../components/portal/PortalButton'
import { ShimmerText } from '../components/portal/ShimmerText'
import { TeamCluster } from '../components/portal/TeamCluster'
import { TeamMenu } from '../components/portal/TeamMenu'
import { Flower } from '../components/portal/FlowerAvatar'
import {
  PortalCheckRow,
  PortalError,
  PortalTextarea,
} from '../components/portal/PortalField'
import { useEditingPresence } from '../hooks/useEditingPresence'
import { autosaveLabel, useDebouncedAutosave } from '../hooks/useDebouncedAutosave'
import {
  clearSubmissionCelebration,
  markSubmissionCelebration,
} from '../lib/submissionCelebration'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { reconcileWorkingCopy, shouldRecoverFollowUpDraft } from '../lib/intakeCollaboration'
import { useOperationRunner } from '../lib/operations'
import { recoverProposalRevision } from '../lib/proposalRevision'
import {
  clearSessionDraft,
  readVersionedSessionDraft,
  sessionDraftConflicts,
  writeVersionedSessionDraft,
} from '../lib/sessionDraft'
import { useDeadlineReached } from '../lib/useDeadlineReached'
import type { CurrentIntake, CurrentTeam, CurrentTeamMember } from '../types'

type NoveltyBand = 'familiar' | 'developing' | 'distinct'

// The pill's plain-speak read of each band: how close the idea sits to
// what other teams are writing.
const noveltyBandLabels: Record<NoveltyBand, string> = {
  familiar: 'similar',
  developing: 'somewhat similar',
  distinct: 'distinct',
}

type NoveltySignal = {
  score: number
  band: NoveltyBand | null
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
}

type PendingIntakeOperation = {
  kind: 'idea' | 'follow_up' | 'freshness' | 'submit'
  slot: string
  action: string
}

type RecoveredFollowUp = {
  answer: string
  questionId: string
  savedByMembershipId: CurrentTeamMember['membershipId']
}

const noveltyRefreshIntervalMs = 15_000

function normalizedIdeaLength(value: string) {
  return value.trim().replace(/\s+/g, ' ').length
}

function editorLabel(
  members: readonly CurrentTeamMember[],
  currentMembershipId: CurrentTeamMember['membershipId'],
  editorMembershipId: CurrentTeamMember['membershipId'] | undefined,
) {
  if (editorMembershipId === currentMembershipId) return 'You'
  return members.find(
    (member) => member.membershipId === editorMembershipId,
  )?.displayName ?? 'Another team member'
}

function storedDraftVersion(value: string) {
  const version = Number(value)
  return Number.isSafeInteger(version) && version >= 0 ? version : null
}

export function IntakeScreen({
  team,
  members,
  teamEditable,
  serverNow,
  submissionFailureMessage,
  onSignOut,
}: {
  team: CurrentTeam
  members: CurrentTeamMember[]
  teamEditable: boolean
  serverNow: number
  submissionFailureMessage?: string
  onSignOut: () => void
}) {
  const intake = useQuery(api.intake.current, { eventSlug })
  if (intake === undefined) {
    return (
      <IntakeStage team={team} members={members} teamEditable={teamEditable} onSignOut={onSignOut} title={<ShimmerText className="text-fg/55">Loading your application…</ShimmerText>} />
    )
  }
  if (intake === null) {
    return (
      <IntakeStage team={team} members={members} teamEditable={teamEditable} onSignOut={onSignOut} title="Your application is unavailable." />
    )
  }
  if (!team.canWriteProject) {
    return <ReadOnlyIntake team={team} intake={intake} members={members} teamEditable={teamEditable} onSignOut={onSignOut} />
  }
  return (
    <IntakeWorkspace
      team={team}
      intake={intake}
      members={members}
      teamEditable={teamEditable}
      serverNow={serverNow}
      onSignOut={onSignOut}
      {...(submissionFailureMessage === undefined ? {} : { submissionFailureMessage })}
    />
  )
}

/**
 * The shared stage for every intake step: the night scene, the team cluster in
 * the corner, a title, and a card.
 */
function IntakeStage({
  team,
  members,
  teamEditable,
  title,
  hint,
  presence,
  topCenter,
  children,
  footer,
  width = 'max-w-[820px]',
  titleClass = 'lg:text-[38px]',
  branch = false,
  onSignOut,
}: {
  team: CurrentTeam
  members: readonly CurrentTeamMember[]
  teamEditable: boolean
  title: ReactNode
  hint?: string
  /** The centred live-presence line the mockup puts between title and card. */
  presence?: ReactNode
  /** Floats at the top centre of the scene — the novelty pill's home. */
  topCenter?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  width?: string
  titleClass?: string
  branch?: boolean
  onSignOut: () => void
}) {
  return (
    <PortalScene
      tree="left"
      branch={branch}
      header={(
        <TeamCluster
          team={team}
          members={members}
          editable={teamEditable}
          canManage={team.currentRole === 'lead' && teamEditable}
          onSignOut={onSignOut}
        />
      )}
      menu={(
        <TeamMenu
          team={team}
          members={members}
          editable={teamEditable}
          canManage={team.currentRole === 'lead' && teamEditable}
          onSignOut={onSignOut}
        />
      )}
    >
      {topCenter ? (
        <div className="pointer-events-none absolute inset-x-0 top-[38px] z-[6] flex justify-center">
          {topCenter}
        </div>
      ) : null}
      <div className={`flex w-full flex-col items-center lg:mb-[8vh] ${width}`}>
        <h1
          className={`mb-6 max-w-[760px] text-center font-display font-light tracking-[-.01em] text-balance text-[26px] leading-tight text-shadow-[0_4px_30px_var(--scene-text-glow)] ${titleClass}`}
        >
          {title}
        </h1>
        {hint ? (
          <p className="-mt-3 mb-6 max-w-[560px] text-center text-pretty text-[12.5px] text-fg/50">
            {hint}
          </p>
        ) : null}
        {presence}
        {children}
        {footer}
      </div>
    </PortalScene>
  )
}

/** The conflict banner shared by the idea and follow-up editors. */
function ConflictNotice({
  cloudLabel,
  cloudValue,
  message,
  onUseSaved,
  onKeepMine,
}: {
  cloudLabel?: string
  cloudValue?: string | undefined
  message: string
  onUseSaved: () => void
  onKeepMine: () => void
}) {
  return (
    <div
      role="status"
      className="mb-4 rounded-petal-xs border border-petal-edge-soft bg-wash/50 px-4 py-3"
    >
      <p className="text-[12.5px] text-fg/75">{message}</p>
      {cloudValue !== undefined ? (
        <div className="mt-3 border-l border-rose-light/25 pl-3">
          <span className="block text-[10.5px] tracking-[.04em] text-fg/35">
            {cloudLabel ?? 'cloud version'}
          </span>
          <p className="mt-1 whitespace-pre-line wrap-anywhere text-[12.5px] leading-relaxed text-fg/35">
            {cloudValue}
          </p>
        </div>
      ) : null}
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
  teamEditable,
  onSignOut,
}: {
  team: CurrentTeam
  intake: CurrentIntake
  members: CurrentTeamMember[]
  teamEditable: boolean
  onSignOut: () => void
}) {
  const { editors } = useEditingPresence(false)
  const draft = intake.draft
  return (
    <IntakeStage
      team={team}
      members={members}
      teamEditable={teamEditable}
      onSignOut={onSignOut}
      title="Project editing is unavailable."
      hint="Your team’s saved work remains here. Another member with project access can continue."
    >
      <EditingPresence editors={editors ?? []} members={members} />
      {draft?.initialIdea ? (
        <PetalCard className="px-8 py-7">
          <p className="whitespace-pre-line text-[15px] leading-relaxed wrap-anywhere text-fg/90">
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
  teamEditable,
  serverNow,
  submissionFailureMessage,
  onSignOut,
}: {
  team: CurrentTeam
  intake: CurrentIntake
  members: CurrentTeamMember[]
  teamEditable: boolean
  serverNow: number
  submissionFailureMessage?: string
  onSignOut: () => void
}) {
  const draft = intake.draft
  const previewNovelty = useAction(api.novelty.preview)
  const autosaveWorkingField = useMutation(api.intake.autosaveWorkingField)
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
  const activeFollowUp = draft?.followUps.find((followUp) => followUp.state === 'active')
  const workingIdea = intake.workingFields.find((field) => field.kind === 'idea')
  const workingFollowUp = activeFollowUp
    ? intake.workingFields.find(
        (field) => field.kind === 'follow_up' && field.questionId === activeFollowUp.id,
      )
    : undefined
  const ideaStorageKey = `c2c:${eventSlug}:${team.id}:idea`
  const [recoveredIdea] = useState(() => readVersionedSessionDraft(ideaStorageKey))
  const recoveredIdeaVersion = recoveredIdea ? storedDraftVersion(recoveredIdea.base) : null
  const initialSavedIdea = draft?.initialIdea ?? ''
  const initialWorkingIdea = workingIdea?.value ?? initialSavedIdea
  const initialSavedVersion = draft?.version ?? 0
  const [idea, setIdea] = useState(recoveredIdea?.value ?? initialWorkingIdea)
  const [ideaDirty, setIdeaDirty] = useState(
    recoveredIdea !== null && recoveredIdea.value !== initialWorkingIdea,
  )
  const ideaBase = useRef({
    value: initialSavedIdea,
    version: recoveredIdeaVersion ?? initialSavedVersion,
  })
  const ideaWorkingRevision = useRef(workingIdea?.revision ?? 0)
  const pendingIdeaAutosave = useRef<string | null>(null)
  const [ideaConflict, setIdeaConflict] = useState(
    sessionDraftConflicts(recoveredIdea, String(initialSavedVersion)),
  )
  const [answer, setAnswer] = useState('')
  const followUpBase = useRef<{ questionId: string | null; version: number }>({
    questionId: null,
    version: draft?.version ?? 0,
  })
  const followUpWorkingRevision = useRef(workingFollowUp?.revision ?? 0)
  const [followUpConflict, setFollowUpConflict] = useState(false)
  const [recoveredFollowUp, setRecoveredFollowUp] = useState<RecoveredFollowUp | null>(null)
  const [editingFollowUpId, setEditingFollowUpId] = useState<string | null>(null)
  const [editedFollowUpAnswer, setEditedFollowUpAnswer] = useState('')
  const [revisionBaseVersion, setRevisionBaseVersion] = useState<number | null>(null)
  const [editingIdea, setEditingIdea] = useState(false)
  // Which tucked sheet in the follow-up pile is peeked open, by question id.
  const [peekQuestionId, setPeekQuestionId] = useState<string | null>(null)
  const [pendingFollowUp, setPendingFollowUp] = useState<PendingFollowUp | null>(null)
  // The mockup splits the old single review screen into reading the proposal
  // (f5) and confirming the lock (f6).
  const [confirming, setConfirming] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [noveltyState, setNoveltyState] = useState<NoveltyState>({ status: 'idle' })
  const noveltySequence = useRef(0)
  const commandInFlight = useRef(false)
  const applicationsClosed = useDeadlineReached(serverNow, intake.applicationsCloseAt)
  const applicationsOpen = !applicationsClosed
  const operations = useOperationRunner<IntakeOperationResult>()
  const ideaEditorOpen = !draft || draft.stage === 'opening' || editingIdea
  const { editors, markEditing, stopEditing } = useEditingPresence(team.canWriteProject)
  const closeDateLabel = new Date(intake.applicationsCloseAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })

  const novelty = draft?.novelty ?? opening?.novelty ?? null
  const noveltyCorpusVersionId = novelty?.corpusVersionId ?? null
  const noveltyMinimumIdeaLength = novelty?.minimumIdeaLength ?? null
  const noveltyDebounceMs = novelty?.debounceMs ?? null
  const savedNoveltyScore = draft?.noveltySignal?.score ?? null
  const savedNoveltyBand = draft?.noveltySignal?.band ?? null

  const draftEditorLabel = editorLabel(
    members,
    team.currentMembershipId,
    draft?.lastEditedByMembershipId,
  )
  const ideaEditorLabel = editorLabel(
    members,
    team.currentMembershipId,
    workingIdea?.writtenByMembershipId ?? draft?.lastEditedByMembershipId,
  )
  const ideaPending = operations.hasPending('idea')
  const followUpSlot = pendingFollowUp ? `follow-up:${pendingFollowUp.questionId}` : null
  const followUpPending = followUpSlot !== null && operations.hasPending(followUpSlot)
  const freshnessPending = operations.hasPending('freshness')
  const submitPending = operations.hasPending('final-submit')

  useEffect(() => {
    if (applicationsClosed) stopEditing()
  }, [applicationsClosed, stopEditing])

  useEffect(() => {
    const savedValue = draft?.initialIdea ?? ''
    const savedVersion = draft?.version ?? 0
    const serverWorkingValue = workingIdea?.value ?? savedValue
    const serverWorkingRevision = workingIdea?.revision ?? 0
    if (!ideaDirty) {
      ideaBase.current = { value: savedValue, version: savedVersion }
      ideaWorkingRevision.current = serverWorkingRevision
      setIdea(serverWorkingValue)
      setIdeaDirty(false)
      setIdeaConflict(false)
      clearSessionDraft(ideaStorageKey)
      return
    }
    if (savedVersion !== ideaBase.current.version) {
      if (savedValue === ideaBase.current.value) {
        ideaBase.current = { value: savedValue, version: savedVersion }
        writeVersionedSessionDraft(ideaStorageKey, {
          base: String(savedVersion),
          value: idea,
        })
      } else if (savedValue === idea) {
        ideaBase.current = { value: savedValue, version: savedVersion }
        ideaWorkingRevision.current = serverWorkingRevision
        setIdea(serverWorkingValue)
        setIdeaDirty(false)
        setIdeaConflict(false)
        clearSessionDraft(ideaStorageKey)
        return
      } else {
        setIdeaConflict(true)
        return
      }
    }
    const reconciliation = reconcileWorkingCopy({
      knownRevision: ideaWorkingRevision.current,
      localDirty: ideaDirty,
      localValue: idea,
      pendingValue: pendingIdeaAutosave.current,
      serverRevision: serverWorkingRevision,
      serverValue: serverWorkingValue,
    })
    if (reconciliation.kind === 'unchanged') return
    if (reconciliation.kind === 'conflict') {
      setIdeaConflict(true)
      return
    }
    ideaWorkingRevision.current = reconciliation.revision
    if (reconciliation.kind === 'continue') {
      pendingIdeaAutosave.current = null
      return
    }
    if (reconciliation.kind === 'adopt') {
      setIdea(reconciliation.value)
      setIdeaDirty(false)
      setIdeaConflict(false)
    }
    clearSessionDraft(ideaStorageKey)
  }, [
    draft?.initialIdea,
    draft?.version,
    idea,
    ideaDirty,
    ideaStorageKey,
    workingIdea?.revision,
    workingIdea?.value,
  ])

  useEffect(() => {
    const nextQuestionId = activeFollowUp?.id ?? null
    if (followUpBase.current.questionId === nextQuestionId) return
    const priorQuestionId = followUpBase.current.questionId
    const lastEditedByMembershipId = draft?.lastEditedByMembershipId
    if (shouldRecoverFollowUpDraft({
      answer,
      currentMembershipId: team.currentMembershipId,
      lastEditedByMembershipId,
      nextQuestionId,
      priorQuestionId,
    }) && priorQuestionId && lastEditedByMembershipId) {
      setRecoveredFollowUp({
        answer,
        questionId: priorQuestionId,
        savedByMembershipId: lastEditedByMembershipId,
      })
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
    const serverWorkingField = intake.workingFields.find(
      (field) => field.kind === 'follow_up' && field.questionId === nextQuestionId,
    )
    const recoveredVersion = recovered ? storedDraftVersion(recovered.base) : null
    followUpBase.current = {
      questionId: nextQuestionId,
      version: recoveredVersion ?? currentVersion,
    }
    followUpWorkingRevision.current = serverWorkingField?.revision ?? 0
    setFollowUpConflict(sessionDraftConflicts(recovered, String(currentVersion)))
    setAnswer(recovered?.value ?? serverWorkingField?.value ?? '')
  }, [
    activeFollowUp?.id,
    answer,
    draft?.lastEditedByMembershipId,
    draft?.version,
    team.currentMembershipId,
    team.id,
    intake.workingFields,
  ])

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
    const hasSavedSignal =
      noveltyCorpusVersionId !== null && savedNoveltyScore !== null && savedIdeaMatches

    if (hasSavedSignal) {
      setNoveltyState({
        status: 'ready',
        signal: {
          score: savedNoveltyScore,
          band: savedNoveltyBand,
        },
      })
    }

    if (!ideaEditorOpen) {
      if (!hasSavedSignal) setNoveltyState({ status: 'idle' })
      return
    }

    if (
      noveltyCorpusVersionId === null ||
      noveltyMinimumIdeaLength === null ||
      noveltyDebounceMs === null ||
      normalizedIdeaLength(idea) < noveltyMinimumIdeaLength
    ) {
      setNoveltyState({ status: 'idle' })
      return
    }

    if (!hasSavedSignal) setNoveltyState({ status: 'checking' })
    let refreshTimer: number | undefined
    let cancelled = false
    const checkNovelty = () => {
      void previewNovelty({
        eventSlug,
        corpusVersionId: noveltyCorpusVersionId,
        idea,
        clientRequestId: crypto.randomUUID(),
      })
        .then((result) => {
          if (noveltySequence.current !== sequence) return
          if (result.state === 'unavailable') {
            if (!hasSavedSignal) setNoveltyState({ status: 'unavailable' })
            return
          }
          setNoveltyState({ status: 'ready', signal: { score: result.score, band: result.band } })
        })
        .catch(() => {
          if (noveltySequence.current === sequence && !hasSavedSignal) {
            setNoveltyState({ status: 'unavailable' })
          }
        })
        .finally(() => {
          if (!cancelled && noveltySequence.current === sequence) {
            refreshTimer = window.setTimeout(checkNovelty, noveltyRefreshIntervalMs)
          }
        })
    }
    const initialTimer = window.setTimeout(
      checkNovelty,
      hasSavedSignal ? 0 : noveltyDebounceMs,
    )

    return () => {
      cancelled = true
      window.clearTimeout(initialTimer)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    }
  }, [
    draft?.initialIdea,
    idea,
    ideaEditorOpen,
    noveltyCorpusVersionId,
    noveltyDebounceMs,
    noveltyMinimumIdeaLength,
    previewNovelty,
    savedNoveltyBand,
    savedNoveltyScore,
  ])

  // A successful submit hands this route to the submitted screen; warming its
  // chunk while the team reads the review keeps that handoff off the loader.
  useEffect(() => {
    if (draft?.stage === 'review') void import('./SubmittedScreen')
  }, [draft?.stage])

  const ideaMaximumLength =
    draft?.intakePolicy.initialIdeaMaxLength ?? opening?.initialIdeaMaxLength ?? 0
  const { retry: retryIdeaAutosave, state: ideaAutosaveState } = useDebouncedAutosave({
    enabled:
      applicationsOpen &&
      ideaEditorOpen &&
      ideaDirty &&
      !ideaConflict &&
      ideaMaximumLength > 0 &&
      idea.length <= ideaMaximumLength,
    initialSavedValue: workingIdea?.value ?? initialSavedIdea,
    resetKey: `idea:${draft?.version ?? 0}:${workingIdea?.revision ?? 0}`,
    value: idea,
    save: (value) => {
      pendingIdeaAutosave.current = value
      return autosaveWorkingField({
        eventSlug,
        field: { kind: 'idea' },
        value,
        baseDraftVersion: ideaBase.current.version,
        expectedRevision: ideaWorkingRevision.current,
      })
    },
    onSaved: (result, savedValue) => {
      pendingIdeaAutosave.current = null
      ideaWorkingRevision.current = result.revision
      if (savedValue === idea) {
        setIdeaDirty(false)
        clearSessionDraft(ideaStorageKey)
      }
      setError(null)
    },
    onError: (autosaveError) => {
      pendingIdeaAutosave.current = null
      const message = readableError(autosaveError)
      if (message.includes('newer text')) {
        setIdeaConflict(true)
        setError(null)
      } else {
        setError(message)
      }
    },
  })

  const { retry: retryFollowUpAutosave, state: followUpAutosaveState } = useDebouncedAutosave({
    enabled:
      applicationsOpen &&
      activeFollowUp !== undefined &&
      !followUpConflict &&
      answer.length <= (draft?.intakePolicy.followUpAnswerMaxLength ?? 0),
    initialSavedValue: workingFollowUp?.value ?? '',
    resetKey: `follow-up:${activeFollowUp?.id ?? 'none'}`,
    value: answer,
    save: (value) => {
      if (!activeFollowUp) return Promise.reject(new Error('The follow-up changed.'))
      return autosaveWorkingField({
        eventSlug,
        field: { kind: 'follow_up', questionId: activeFollowUp.id },
        value,
        baseDraftVersion: followUpBase.current.version,
        expectedRevision: followUpWorkingRevision.current,
      })
    },
    onSaved: (result, savedValue) => {
      followUpWorkingRevision.current = result.revision
      if (activeFollowUp && savedValue === answer) {
        clearSessionDraft(`c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`)
      }
      setError(null)
    },
    onError: (autosaveError) => {
      const message = readableError(autosaveError)
      if (message.includes('newer text')) setFollowUpConflict(true)
      setError(message)
    },
  })

  const editingFollowUp = editingFollowUpId === null
    ? undefined
    : draft?.followUps.find((followUp) => followUp.id === editingFollowUpId)
  const { retry: retryRevisionAutosave, state: revisionAutosaveState } = useDebouncedAutosave({
    delayMs: 1_000,
    enabled:
      applicationsOpen &&
      draft?.stage === 'review' &&
      editingFollowUp !== undefined &&
      revisionBaseVersion !== null &&
      editedFollowUpAnswer.length >= draft.intakePolicy.followUpAnswerMinLength &&
      editedFollowUpAnswer.length <= draft.intakePolicy.followUpAnswerMaxLength,
    initialSavedValue: editingFollowUp?.answer ?? '',
    resetKey: `review:${editingFollowUpId ?? 'none'}`,
    value: editedFollowUpAnswer,
    save: (value) => {
      if (!editingFollowUp || revisionBaseVersion === null) {
        return Promise.reject(new Error('That answer is no longer editable.'))
      }
      return reviseFollowUp({
        eventSlug,
        questionId: editingFollowUp.id,
        answer: value,
        expectedDraftVersion: revisionBaseVersion,
        clientOperationId: crypto.randomUUID(),
      })
    },
    onSaved: (result, savedValue) => {
      setRevisionBaseVersion(result.draftVersion)
      if (editingFollowUp) {
        const storageKey = `c2c:${eventSlug}:${team.id}:review:${editingFollowUp.id}`
        if (savedValue === editedFollowUpAnswer) {
          clearSessionDraft(storageKey)
        } else {
          writeVersionedSessionDraft(storageKey, {
            base: String(result.draftVersion),
            value: editedFollowUpAnswer,
          })
        }
      }
      setError(null)
    },
    onError: (autosaveError) => setError(readableError(autosaveError)),
  })

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
        setPendingFollowUp({ questionId: activeFollowUp.id })
      }
      await operations.run(slot, (clientOperationId) => () => respondToFollowUp({
          eventSlug,
          questionId: activeFollowUp.id,
          answer,
          expectedDraftVersion: followUpBase.current.version,
          clientOperationId,
        }))
      clearSessionDraft(`c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`)
      setAnswer('')
      setFollowUpConflict(false)
      setPeekQuestionId(null)
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
            action: 'Confirm answer',
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
  }

  const confirmPendingOperation = (operation: PendingIntakeOperation) => {
    void run(async () => {
      if (operation.kind === 'submit') markSubmissionCelebration()
      try {
        await operations.retryPending(operation.slot)
      } catch (caught) {
        if (!operations.hasPending(operation.slot)) {
          if (operation.kind === 'submit') clearSubmissionCelebration()
          clearPendingOperation(operation)
        }
        throw caught
      }
      clearPendingOperation(operation)
    })
  }

  // While a save is in flight the editor stays put — its controls already
  // read `busy` and the submit button says "Saving…". This stop only takes
  // over once a response was genuinely interrupted (the command is still
  // pending but nothing is running) and needs a deliberate confirm.
  if (pendingOperation && !busy) {
    return (
      <IntakeStage
        team={team}
        members={members}
        teamEditable={teamEditable}
        onSignOut={onSignOut}
        title="Confirm your last change."
        hint="The response was interrupted. Confirm it before continuing."
        width="max-w-[600px]"
      >
        <PortalError message={error} />
        <PortalButton
          type="button"
          className="mt-6"
          onClick={() => confirmPendingOperation(pendingOperation)}
        >
          {pendingOperation.action}
        </PortalButton>
      </IntakeStage>
    )
  }

  if (!applicationsOpen) {
    return (
      <IntakeStage
        team={team}
        members={members}
        teamEditable={teamEditable}
        onSignOut={onSignOut}
        title="Applications are closed."
        hint="Your team’s saved work remains available here."
      >
        {draft?.initialIdea ? (
          <PetalCard className="px-8 py-7">
            <p className="whitespace-pre-line text-[15px] leading-relaxed wrap-anywhere text-fg/90">
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
      return <IntakeStage team={team} members={members} teamEditable={teamEditable} onSignOut={onSignOut} title={<ShimmerText className="text-fg/55">Loading…</ShimmerText>} />
    }
    const initialIdeaMinLength =
      draft?.intakePolicy.initialIdeaMinLength ?? opening.initialIdeaMinLength
    const initialIdeaMaxLength =
      draft?.intakePolicy.initialIdeaMaxLength ?? opening.initialIdeaMaxLength
    return (
      <IntakeStage
        team={team}
        members={members}
        teamEditable={teamEditable}
        onSignOut={onSignOut}
        title={opening.initialPrompt}
        hint={opening.initialHelpText}
        titleClass="lg:text-[42px]"
        presence={<EditingPresence editors={editors ?? []} members={members} />}
        topCenter={
          <NoveltyPill
            state={noveltyState}
            currentLength={normalizedIdeaLength(idea)}
            minimumLength={novelty?.minimumIdeaLength ?? null}
          />
        }
      >
        <PortalError message={submissionFailureMessage ?? null} />
        <div className="relative w-full">
          <PetalCard className="px-6 pt-[26px] pb-[18px] lg:px-[30px]">
          <form onSubmit={submitIdea}>
            {ideaConflict ? (
              <ConflictNotice
                cloudLabel={ideaEditorLabel === 'You'
                  ? 'cloud version from your other session'
                  : `${ideaEditorLabel}'s cloud version`}
                cloudValue={workingIdea?.value ?? draft?.initialIdea}
                message={`${ideaEditorLabel} saved a newer idea. Your text is still here.`}
                onUseSaved={() => {
                  const savedValue = workingIdea?.value ?? draft?.initialIdea ?? ''
                  setIdea(savedValue)
                  setIdeaDirty(false)
                  setIdeaConflict(false)
                  ideaBase.current = {
                    value: draft?.initialIdea ?? '',
                    version: draft?.version ?? 0,
                  }
                  ideaWorkingRevision.current = workingIdea?.revision ?? 0
                  pendingIdeaAutosave.current = null
                  clearSessionDraft(ideaStorageKey)
                }}
                onKeepMine={() => {
                  ideaBase.current = {
                    value: draft?.initialIdea ?? '',
                    version: draft?.version ?? 0,
                  }
                  ideaWorkingRevision.current = workingIdea?.revision ?? 0
                  pendingIdeaAutosave.current = null
                  setIdeaDirty(true)
                  setIdeaConflict(false)
                  retryIdeaAutosave()
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
              className="bare-field min-h-[180px] border-0 bg-transparent px-0 py-0 text-[17px] leading-[1.7] focus:border-0"
            />
            <PortalError message={error} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-petal-line pt-3.5">
              <span className="text-xs text-fg/45">
                {idea.length > initialIdeaMaxLength * 0.8 ? (
                  <span className="font-mono text-[11px] tracking-[.04em]">
                    {idea.length} / {initialIdeaMaxLength}
                  </span>
                ) : ideaDirty ? (
                  autosaveLabel(ideaAutosaveState)
                ) : (
                  `saved · editable until ${closeDateLabel}`
                )}
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
                      ideaBase.current = {
                        value: draft?.initialIdea ?? '',
                        version: draft?.version ?? 0,
                      }
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
        </div>
      </IntakeStage>
    )
  }

  // ---- f3 / f4 · the follow-ups -------------------------------------------
  if (draft.stage === 'follow_up') {
    // While the next question is generated the card stays on stage — only the
    // title shimmers and the editor waits — so answering never swaps screens.
    const minLength = draft.intakePolicy.followUpAnswerMinLength
    const answeredSheets = draft.followUps.filter((followUp) => followUp.state !== 'active')
    return (
      <IntakeStage
        team={team}
        members={members}
        teamEditable={teamEditable}
        onSignOut={onSignOut}
        title={
          activeFollowUp ? (
            activeFollowUp.question
          ) : (
            <ShimmerText className="text-fg/55">Cooking a question for you</ShimmerText>
          )
        }
        presence={<EditingPresence editors={editors ?? []} members={members} />}
      >
        {/* Everything already written rides tucked behind the current sheet:
            the idea deepest, then each answered question. Pulling the idea
            sheet reopens its editor; an answer peeks open here and is
            rewritten at review, which the backend enforces. */}
        <div className="flex w-full flex-col">
          <button
            type="button"
            aria-label="Edit your idea"
            onClick={() => {
              ideaBase.current = {
                value: draft.initialIdea ?? '',
                version: draft.version,
              }
              setIdea(draft.initialIdea ?? '')
              setIdeaDirty(false)
              setEditingIdea(true)
            }}
            style={{ marginInline: (answeredSheets.length + 1) * 14 }}
            className="relative -mb-1.5 overflow-hidden rounded-t-petal-sm border border-b-0 border-petal-line bg-[image:var(--tile-bg)] px-5 pt-1.5 pb-3.5 text-left backdrop-blur-md transition-transform duration-250 hover:-translate-y-1"
          >
            <span className="block truncate text-[11px] text-fg/50">
              your idea <span className="text-fg/35">· {draft.initialIdea}</span>
            </span>
          </button>
          {answeredSheets.map((followUp, index) => {
            const peeked = peekQuestionId === followUp.id
            return (
              <button
                key={followUp.id}
                type="button"
                aria-expanded={peeked}
                onClick={() => setPeekQuestionId(peeked ? null : followUp.id)}
                style={{ marginInline: (answeredSheets.length - index) * 14 }}
                className="relative -mb-1.5 overflow-hidden rounded-t-petal-sm border border-b-0 border-petal-line bg-[image:var(--tile-bg)] px-5 pt-1.5 pb-3.5 text-left backdrop-blur-md transition-transform duration-250 hover:-translate-y-1"
              >
                <span className="block truncate text-[11px] text-fg/50">{followUp.question}</span>
                {peeked ? (
                  <>
                    <span className="mt-1 block text-[12.5px] leading-relaxed whitespace-pre-line wrap-anywhere text-fg/80">
                      {followUp.answer}
                    </span>
                    <span className="mt-1.5 block text-[10.5px] text-fg/40">
                      rewritable at review, after the last question
                    </span>
                  </>
                ) : null}
              </button>
            )
          })}
        <PetalCard className="px-6 pt-[26px] pb-[18px] lg:px-[30px]">
          <form onSubmit={submitAnswer}>
            {activeFollowUp && followUpConflict ? (
              <ConflictNotice
                message={`${draftEditorLabel} saved a newer project version while this answer was unsaved. Your text is still here.`}
                onUseSaved={() => {
                  setAnswer(workingFollowUp?.value ?? '')
                  followUpBase.current = {
                    questionId: activeFollowUp.id,
                    version: draft.version,
                  }
                  followUpWorkingRevision.current = workingFollowUp?.revision ?? 0
                  setFollowUpConflict(false)
                  clearSessionDraft(`c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`)
                }}
                onKeepMine={() => {
                  followUpBase.current = {
                    questionId: activeFollowUp.id,
                    version: draft.version,
                  }
                  followUpWorkingRevision.current = workingFollowUp?.revision ?? 0
                  setFollowUpConflict(false)
                  retryFollowUpAutosave()
                  writeVersionedSessionDraft(
                    `c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`,
                    { base: String(draft.version), value: answer },
                  )
                }}
              />
            ) : null}
            <PortalTextarea
              key={activeFollowUp?.id ?? 'cooking'}
              autoFocus={activeFollowUp !== undefined}
              required
              minLength={minLength}
              maxLength={draft.intakePolicy.followUpAnswerMaxLength}
              rows={6}
              disabled={busy || !activeFollowUp}
              value={answer}
              onChange={(event) => {
                if (!activeFollowUp) return
                setAnswer(event.target.value)
                writeVersionedSessionDraft(
                  `c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`,
                  {
                    base: String(followUpBase.current.version),
                    value: event.target.value,
                  },
                )
                markEditing('follow_up', activeFollowUp.id)
              }}
              placeholder="Scope it in a sentence or two…"
              className="bare-field min-h-[174px] border-0 bg-transparent px-0 py-0 text-[16.5px] leading-[1.7] focus:border-0"
            />
            <PortalError message={error} />
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3 border-t border-petal-line pt-3">
              <span className="text-xs text-fg/45">
                {!activeFollowUp ? (
                  'the next question is on its way'
                ) : answer.length > draft.intakePolicy.followUpAnswerMaxLength * 0.8 ? (
                  <span className="font-mono text-[11px] tracking-[.04em]">
                    {answer.length} / {draft.intakePolicy.followUpAnswerMaxLength}
                  </span>
                ) : answer.trim() ? (
                  autosaveLabel(followUpAutosaveState)
                ) : (
                  'a sentence or two is plenty'
                )}
              </span>
              <PortalButton
                type="submit"
                size="sm"
                disabled={busy || !activeFollowUp || followUpConflict || answer.trim().length < minLength}
              >
                {busy ? 'Saving…' : 'Continue'}
              </PortalButton>
            </div>
          </form>
        </PetalCard>
        </div>
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
          teamEditable={teamEditable}
          onSignOut={onSignOut}
          title={<ShimmerText className="text-fg/55">Putting everything together…</ShimmerText>}
          hint="Your current team and idea will appear here."
        />
      )
    }
    const revisionConflict =
      revisionAutosaveState !== 'saving' &&
      editingFollowUpId !== null &&
      revisionBaseVersion !== null &&
      revisionBaseVersion !== preview.draftVersion
    const canSubmit =
      preview.blockers.length === 0 &&
      team.currentRole === 'lead' &&
      team.canSubmitApplication

    const editIdea = () => {
      const savedIdea = preview.initialIdea ?? ''
      ideaBase.current = { value: savedIdea, version: preview.draftVersion }
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
          teamEditable={teamEditable}
          onSignOut={onSignOut}
          title="Ready to submit?"
          width="max-w-[600px]"
          titleClass="lg:text-[42px]"
          branch
        >
          <PetalCard className="px-8 pt-6 pb-4">
            <div className="flex items-baseline justify-between gap-4">
              <p className="m-0 min-w-0 truncate text-left text-[15.5px] font-semibold">
                {preview.teamName}{' '}
                <span className="font-normal text-fg/55">
                  · idea + {preview.followUps.length}{' '}
                  {preview.followUps.length === 1 ? 'answer' : 'answers'}
                  {savedNoveltyScore !== null ? ` · novelty ${savedNoveltyScore}/100` : ''}
                </span>
              </p>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="flex-none text-xs text-fg/55 transition-colors hover:text-rose-light"
              >
                review idea
              </button>
            </div>

            <div className="mt-4 flex gap-2 border-t border-petal-line pt-4">
              {preview.members.map((member) => {
                const lead = member.role === 'lead'
                const you = member.membershipId === team.currentMembershipId
                return (
                  <div key={member.membershipId} className="flex-1 text-center">
                    <div
                      className={`mx-auto flex size-[52px] items-center justify-center rounded-full ${
                        lead
                          ? 'border-2 border-ring-lead bg-avatar-lead shadow-[0_0_16px_var(--avatar-glow)]'
                          : 'border-[1.5px] border-rose/70 bg-avatar'
                      }`}
                    >
                      <Flower seed={member.membershipId} lead={lead} size={26} />
                    </div>
                    <p className="mt-[7px] mb-px truncate text-xs font-semibold">
                      {member.displayName.split(/\s+/)[0]}
                    </p>
                    <p
                      className={`text-[10px] ${
                        lead || you ? 'text-rose-light' : 'text-fg/50'
                      }`}
                    >
                      {lead && you
                        ? 'lead · you'
                        : lead
                          ? 'lead'
                          : member.submissionReady
                            ? 'ready'
                            : 'needs attention'}
                    </p>
                  </div>
                )
              })}
            </div>

            <p className="mt-7 mb-4 text-left text-[13.5px] leading-relaxed text-fg/70">
              {preview.warning}
            </p>

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
              We adhere to the Code2Create rules.
            </PortalCheckRow>

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
                A teammate is still typing. Submit uses the saved version shown here; their
                unsaved text will stay in their draft.
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
                variant="solid"
                disabled={busy || !canSubmit}
                onClick={() => {
                  void run(async () => {
                    markSubmissionCelebration()
                    try {
                      await operations.run(
                        'final-submit',
                        (clientOperationId) => () => submitApplication({
                          eventSlug,
                          expectedDraftVersion: preview.draftVersion,
                          expectedTeamVersion: preview.teamVersion,
                          participantPolicyVersionId: preview.participantPolicyVersionId,
                          clientOperationId,
                        }),
                      )
                    } catch (caught) {
                      if (!operations.hasPending('final-submit')) {
                        clearSubmissionCelebration()
                      }
                      throw caught
                    }
                  })
                }}
              >
                {busy ? 'Submitting…' : 'Submit'}
              </PortalButton>
            </div>
          </PetalCard>
        </IntakeStage>
      )
    }

    // f5 · the proposal, together
    const ideaSectionId = 'idea'
    const sectionIds = [ideaSectionId, ...preview.followUps.map((followUp) => followUp.id)]
    const openSections = sectionIds.filter((id) => !collapsedSections.includes(id))
    const revealSection = (id: string) =>
      setCollapsedSections((collapsed) => collapsed.filter((value) => value !== id))

    return (
      <PortalScene
        tree="left"
        header={(
          <TeamCluster
            team={team}
            members={members}
            editable={teamEditable}
            canManage={team.currentRole === 'lead' && teamEditable}
            onSignOut={onSignOut}
          />
        )}
        menu={(
          <TeamMenu
            team={team}
            members={members}
            editable={teamEditable}
            canManage={team.currentRole === 'lead' && teamEditable}
            onSignOut={onSignOut}
          />
        )}
      >
        <div className="flex w-full max-w-[760px] flex-col items-center">
          <h1 className="mb-6 text-center font-display font-light tracking-[-.01em] wrap-anywhere text-3xl text-shadow-[0_6px_40px_var(--scene-text-glow)] lg:text-[44px]">
            {preview.teamName}
          </h1>

          <EditingPresence editors={editors ?? []} members={members} />

          <PetalCard className="px-6 py-2 sm:px-8">
            {savedNoveltyScore !== null ? (
              <NoveltyReviewRow score={savedNoveltyScore} band={savedNoveltyBand} />
            ) : null}
            <AccordionRoot
              allowMultiple
              value={openSections}
              onValueChange={(next) =>
                setCollapsedSections(sectionIds.filter((id) => !next.includes(id)))
              }
            >
            <AccordionItem value={ideaSectionId}>
              <AccordionItemTrigger>
                <AccordionItemHeader>
                  <span className="text-[15px] font-semibold text-fg/85">The idea</span>
                </AccordionItemHeader>
              </AccordionItemTrigger>
              <AccordionItemContent className="text-[15px] leading-relaxed wrap-anywhere text-fg">
                <p className="whitespace-pre-line">{preview.initialIdea}</p>
                <ReviewEditRow busy={busy} onEdit={editIdea} />
              </AccordionItemContent>
            </AccordionItem>

            {recoveredFollowUp ? (
              <div
                role="status"
                className="mt-4 rounded-petal-xs border border-petal-edge-soft bg-wash/50 px-4 py-3"
              >
                <p className="text-[12.5px] text-fg/75">
                  {members.find(
                    (member) => member.membershipId === recoveredFollowUp.savedByMembershipId,
                  )?.displayName ?? 'Another team member'} saved this answer while you were typing.
                  {' '}Your draft is still available.
                </p>
                <PortalTextButton
                  type="button"
                  className="mt-2"
                  onClick={() => {
                    revealSection(recoveredFollowUp.questionId)
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

            {preview.followUps.map((followUp) => {
              const startEditing = () => {
                const storageKey = `c2c:${eventSlug}:${team.id}:review:${followUp.id}`
                const recovered = readVersionedSessionDraft(storageKey)
                const savedAnswer = followUp.answer ?? ''
                const revision = recoverProposalRevision(
                  savedAnswer,
                  preview.draftVersion,
                  recovered,
                )
                setEditingFollowUpId(followUp.id)
                setEditedFollowUpAnswer(revision.answer)
                setRevisionBaseVersion(revision.baseDraftVersion)
                if (!revision.recovered) clearSessionDraft(storageKey)
              }
              return (
                <AccordionItem key={followUp.id} value={followUp.id}>
                  <AccordionItemTrigger>
                    <AccordionItemHeader>
                      <span className="text-[15px] font-semibold text-fg/85">
                        {followUp.question}
                      </span>
                    </AccordionItemHeader>
                  </AccordionItemTrigger>
                  <AccordionItemContent className="text-[15px] leading-relaxed wrap-anywhere text-fg">
                    {editingFollowUpId === followUp.id ? (
                    <div>
                      <PortalTextarea
                        autoFocus
                        required
                        minLength={draft.intakePolicy.followUpAnswerMinLength}
                        maxLength={draft.intakePolicy.followUpAnswerMaxLength}
                        rows={4}
                        disabled={busy}
                        value={editedFollowUpAnswer}
                        onChange={(event) => {
                          const nextAnswer = event.target.value
                          setEditedFollowUpAnswer(nextAnswer)
                          if (revisionBaseVersion !== null) {
                            writeVersionedSessionDraft(
                              `c2c:${eventSlug}:${team.id}:review:${followUp.id}`,
                              {
                                base: String(revisionBaseVersion),
                                value: nextAnswer,
                              },
                            )
                          }
                          setError(null)
                          markEditing('follow_up', followUp.id)
                        }}
                      />
                      {revisionConflict ? (
                        <ConflictNotice
                          message={`${editorLabel(
                            members,
                            team.currentMembershipId,
                            preview.lastEditedByMembershipId,
                          )} saved a newer answer. Your text is still here.`}
                          onUseSaved={() => {
                            setEditedFollowUpAnswer(followUp.answer ?? '')
                            setRevisionBaseVersion(preview.draftVersion)
                            clearSessionDraft(
                              `c2c:${eventSlug}:${team.id}:review:${followUp.id}`,
                            )
                          }}
                          onKeepMine={() => {
                            setRevisionBaseVersion(preview.draftVersion)
                            writeVersionedSessionDraft(
                              `c2c:${eventSlug}:${team.id}:review:${followUp.id}`,
                              {
                                base: String(preview.draftVersion),
                                value: editedFollowUpAnswer,
                              },
                            )
                            retryRevisionAutosave()
                          }}
                        />
                      ) : null}
                      <div className="mt-3 flex items-center justify-between gap-4">
                        <span className="text-xs text-fg/45">
                          {autosaveLabel(revisionAutosaveState)}
                        </span>
                        <PortalTextButton
                          type="button"
                          disabled={
                            revisionConflict ||
                            revisionAutosaveState === 'dirty' ||
                            revisionAutosaveState === 'saving' ||
                            revisionAutosaveState === 'error' ||
                            editedFollowUpAnswer.trim().length <
                              draft.intakePolicy.followUpAnswerMinLength
                          }
                          onClick={() => {
                            clearSessionDraft(
                              `c2c:${eventSlug}:${team.id}:review:${followUp.id}`,
                            )
                            setEditingFollowUpId(null)
                            setRevisionBaseVersion(null)
                            stopEditing()
                          }}
                        >
                          done
                        </PortalTextButton>
                      </div>
                    </div>
                    ) : (
                      <>
                        <p className="whitespace-pre-line">{followUp.answer}</p>
                        <ReviewEditRow busy={busy} onEdit={startEditing} />
                      </>
                    )}
                  </AccordionItemContent>
                </AccordionItem>
              )
            })}
            </AccordionRoot>

          </PetalCard>

          <PortalError message={error ?? submissionFailureMessage ?? null} />

          <div className="mt-8 flex flex-col items-center">
            <PortalButton
              type="button"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Continue to submit
            </PortalButton>
          </div>
        </div>
      </PortalScene>
    )
  }

  return null
}

/** One labelled, separately-editable block of the review card (mockup f5). */
/** The quiet "edit" at the foot of a review panel. */
function ReviewEditRow({ onEdit, busy }: { onEdit: () => void; busy: boolean }) {
  return (
    <div className="mt-3 flex justify-end">
      <button
        type="button"
        disabled={busy}
        onClick={onEdit}
        className="text-[12.5px] text-rose-light underline-offset-4 hover:underline disabled:opacity-50"
      >
        edit
      </button>
    </div>
  )
}

const desktopQuery = '(min-width: 640px)'

function subscribeDesktop(onChange: () => void) {
  const media = window.matchMedia(desktopQuery)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function useDesktop() {
  return useSyncExternalStore(subscribeDesktop, () => window.matchMedia(desktopQuery).matches)
}

/** What the number means, shared by the pill's popover and its mobile sheet. */
function NoveltyExplainer() {
  return (
    <div className="text-left">
      <p className="m-0 text-[13px] leading-relaxed text-fg/85">
        We compare your idea with ideas from other teams. A higher score means
        fewer teams are working on something similar.
      </p>
      <div className="mt-4 mb-1.5 flex h-1.5 overflow-hidden rounded-full" aria-hidden>
        <span className="flex-1 bg-rose/25" />
        <span className="flex-1 bg-rose/55" />
        <span className="flex-1 bg-rose" />
      </div>
      <div className="mb-3.5 flex justify-between text-[10.5px] text-fg/50">
        <span>Similar</span>
        <span>Somewhat similar</span>
        <span>Distinct</span>
      </div>
      <p className="m-0 text-xs leading-relaxed text-fg/55">
        Hackathon ideas can end up looking very similar. This score helps you
        notice that early and try an approach that fewer teams are using. When
        teams work on different ideas, Code2Create is more fun for everyone.
      </p>
      <p className="mt-3 mb-0 text-xs leading-relaxed text-fg/55">
        The score updates while you type. The latest score is saved with your
        idea. It cannot block your submission. Reviewers see your written idea.
        They do not see this score.
      </p>
    </div>
  )
}

/**
 * The live idea-comparison score shown above the idea card. Reads as "N / 100"
 * once the idea is long enough to score. Its help button opens the explainer
 * below the pill on desktop and in a bottom sheet on phones. Omit
 * `currentLength` where nobody is typing (review).
 */
/**
 * The "?" beside every novelty read: a popover on desktop, a bottom sheet on
 * phones, both carrying the same explainer.
 */
function NoveltyHelp({ align = 'center' }: { align?: 'center' | 'end' }) {
  const [explaining, setExplaining] = useState(false)
  const desktop = useDesktop()
  const anchorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!explaining || !desktop) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchorRef.current?.contains(event.target)) {
        setExplaining(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExplaining(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [explaining, desktop])

  return (
    <div ref={anchorRef} className="pointer-events-auto relative flex">
      <button
        type="button"
        aria-label="What this score means"
        aria-expanded={explaining}
        onClick={() => setExplaining((value) => !value)}
        className="flex size-[18px] items-center justify-center rounded-full border border-rose/60 text-[10px] text-rose-light/80 transition-colors hover:border-rose-light hover:text-rose-light"
      >
        ?
      </button>
      {explaining && desktop ? (
        <div
          className={`absolute top-[calc(100%+10px)] z-[7] w-[320px] rounded-petal-sm border border-petal-edge bg-wash/92 px-6 py-5 shadow-[0_24px_50px_-18px_var(--shade-2)] backdrop-blur-md ${
            align === 'center' ? 'left-1/2 -translate-x-1/2' : 'right-0'
          }`}
        >
          <p className="mb-2.5 text-[11px] font-semibold tracking-[.08em] text-rose-light/80">
            What the score means
          </p>
          <NoveltyExplainer />
        </div>
      ) : null}
      <Drawer.Root open={explaining && !desktop} onOpenChange={setExplaining}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-[rgb(6_0_2/.5)]" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 rounded-t-petal border-t border-petal-edge bg-wash outline-none">
            <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-rose/40" aria-hidden />
            <div className="px-7 pt-5 pb-[calc(28px+env(safe-area-inset-bottom))]">
              <Drawer.Title className="mb-2.5 text-[11px] font-semibold tracking-[.08em] text-rose-light/80">
                What the score means
              </Drawer.Title>
              <Drawer.Description className="sr-only">
                What the idea comparison score means.
              </Drawer.Description>
              <NoveltyExplainer />
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </div>
  )
}

/**
 * The saved score woven into the review card: the number, its plain-speak
 * band, a thin meter, and one line that keeps it honest — a guide while
 * writing, not a shortlisting gate.
 */
export function NoveltyReviewRow({
  score,
  band,
}: {
  score: number
  band: NoveltyBand | null
}) {
  return (
    <div className="border-b border-petal-line pt-4 pb-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-semibold text-fg/85">Novelty</span>
        <span className="flex items-center gap-2 text-[12.5px] font-semibold text-rose-light">
          {score} / 100{band === null ? '' : ` · ${noveltyBandLabels[band]}`}
          <NoveltyHelp align="end" />
        </span>
      </div>
      <div className="mt-2.5 h-[3px] overflow-hidden rounded-full bg-petal-line" aria-hidden>
        <div
          className="h-full rounded-full bg-rose-light transition-[width] duration-700"
          style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
        />
      </div>
      <p className="mt-2 mb-0 text-[11px] leading-relaxed text-fg/45">
        This score compares your idea with ideas from other teams. A higher score means fewer teams are working on something similar. It updates while you type and is saved with your idea. 
        We don't use this score to block submissions. Our team will see your idea, not this score.
      </p>
    </div>
  )
}

export function NoveltyPill({
  state,
  currentLength,
  minimumLength,
}: {
  state: NoveltyState
  currentLength?: number
  minimumLength: number | null
}) {
  if (minimumLength === null) return null
  const belowMinimum = currentLength !== undefined && currentLength < minimumLength
  const signal = !belowMinimum && state.status === 'ready' ? state.signal : null
  const label =
    belowMinimum || state.status === 'idle'
      ? 'keep writing'
      : state.status === 'checking'
        ? 'checking…'
        : 'score unavailable'
  return (
    <div className="pointer-events-auto relative">
      <div className="inline-flex items-center gap-2 rounded-[8px] border border-rose-light/55 bg-wash/92 py-1.5 pr-2 pl-3.5 text-[11.5px] font-semibold text-rose-light shadow-[0_8px_22px_var(--shade-1)] backdrop-blur-md">
        <span aria-live="polite" aria-label="Live idea comparison score">
          {signal === null ? (
            label
          ) : signal.band === null ? (
            `${signal.score} / 100`
          ) : (
            <>
              {/* Wide screens carry both; phones trade them on a slow tick. */}
              <span className="hidden sm:inline">
                {signal.score} / 100 · {noveltyBandLabels[signal.band]}
              </span>
              <span className="grid overflow-hidden text-center sm:hidden">
                <span className="col-start-1 row-start-1 animate-[c2cticka_5.6s_ease-in-out_infinite] motion-reduce:animate-none">
                  {signal.score} / 100
                </span>
                <span className="col-start-1 row-start-1 animate-[c2ctickb_5.6s_ease-in-out_infinite] motion-reduce:hidden">
                  {noveltyBandLabels[signal.band]}
                </span>
              </span>
            </>
          )}
        </span>
        <NoveltyHelp />
      </div>
    </div>
  )
}
