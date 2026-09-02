import { api } from '@code2create/backend/api'
import { useProductAnalytics } from '@code2create/client-observability'
import { useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react'
import { Drawer } from 'vaul'
import { EditingPresence } from '../components/EditingPresence'
import { PortalScene } from '../components/portal/PortalScene'
import { IdeaPromptsLink } from '../components/portal/IdeaPromptsSheet'
import { useDesktop } from '../lib/useDesktop'
import {
  AccordionItem,
  AccordionItemContent,
  AccordionItemHeader,
  AccordionItemTrigger,
  AccordionRoot,
} from '../components/portal/Accordion'
import { FadeText } from '../components/portal/FadeText'
import { PetalCard } from '../components/portal/PetalCard'
import { PortalButton, PortalTextButton } from '../components/portal/PortalButton'
import { ShimmerText } from '../components/portal/ShimmerText'
import { StackedSheet } from '../components/portal/StackedSheet'
import { TeamCluster } from '../components/portal/TeamCluster'
import { Flower } from '../components/portal/FlowerAvatar'
import {
  PortalCheckRow,
  PortalError,
  PortalLabel,
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
import {
  firstReviewQuestionAfterIdeaSave,
  isIntakeCollaborationConflict,
  nextReviewQuestionAfterAnswerSave,
  nextReviewQuestionId,
  reconcileCommittedField,
  reconcileWorkingCopy,
  shouldRecoverFollowUpDraft,
  shouldReplaceFollowUpEditorValue,
} from '../lib/intakeCollaboration'
import { useOperationRunner } from '../lib/operations'
import { recoverProposalRevision } from '../lib/proposalRevision'
import {
  clearSessionDraft,
  readVersionedSessionDraft,
  sessionDraftConflicts,
  writeVersionedSessionDraft,
} from '../lib/sessionDraft'
import { useDeadlineReached } from '../lib/useDeadlineReached'
import {
  normalizedIdeaLength,
  useNoveltyPreview,
  type NoveltyBand,
  type NoveltyState,
} from '../hooks/useNoveltyPreview'
import type {
  CurrentIntake,
  CurrentTeam,
  CurrentTeamMember,
  SubmissionPreview,
} from '../types'

const additionalInformationLabel =
  'Additional information or links (optional, please no PPTs)'

// The pill's plain-speak read of each band: how close the idea sits to
// what other teams are writing.
const noveltyBandLabels: Record<NoveltyBand, string> = {
  familiar: 'similar',
  developing: 'somewhat similar',
  distinct: 'distinct',
}

type IntakeOperationResult =
  | FunctionReturnType<typeof api.intake.saveInitialIdea>
  | FunctionReturnType<typeof api.intake.respondToFollowUp>
  | FunctionReturnType<typeof api.intake.reviseFollowUp>
  | FunctionReturnType<typeof api.intake.saveAdditionalInformation>
  | FunctionReturnType<typeof api.intake.setFreshnessAttestation>
  | FunctionReturnType<typeof api.intake.submit>

type PendingFollowUp = {
  questionId: string
}

type PendingIntakeOperation = {
  kind:
    | 'idea'
    | 'follow_up'
    | 'review_answer'
    | 'additional_information'
    | 'freshness'
    | 'submit'
  slot: string
  action: string
}

type RecoveredFollowUp = {
  answer: string
  questionId: string
  savedByMembershipId: CurrentTeamMember['membershipId']
}

type ReviewAnswerEdit = {
  questionId: string
  value: string
  baseValue: string
  baseDraftVersion: number
  conflict: boolean
}

type AdditionalInformationEdit = {
  value: string
  baseValue: string
  baseDraftVersion: number
  conflict: boolean
}

type ReviewFollowUp = SubmissionPreview['followUps'][number]

type PendingReviewAnswer = {
  questionId: ReviewFollowUp['id']
  submittedDraftVersion: number
  submittedWorkingRevision: number
  sequenceActive: boolean
}

type InitialIdeaResult = FunctionReturnType<typeof api.intake.saveInitialIdea>
type ReviewAnswerResult = FunctionReturnType<typeof api.intake.reviseFollowUp>

function isInitialIdeaResult(result: IntakeOperationResult): result is InitialIdeaResult {
  return 'draftId' in result
}

function isReviewAnswerResult(result: IntakeOperationResult): result is ReviewAnswerResult {
  return 'draftVersion' in result
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
  submissionInProgress,
  submissionFailureMessage,
  onSignOut,
}: {
  team: CurrentTeam
  members: CurrentTeamMember[]
  teamEditable: boolean
  serverNow: number
  submissionInProgress: boolean
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
      submissionInProgress={submissionInProgress}
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
  children?: ReactNode
  footer?: ReactNode
  width?: string
  titleClass?: string
  branch?: boolean
  onSignOut: () => void
}) {
  return (
    <PortalScene
      onSignOut={onSignOut}
      tree="left"
      branch={branch}
      header={(
        <TeamCluster
          team={team}
          members={members}
          editable={teamEditable}
          canManage={team.currentRole === 'lead' && teamEditable}
        />
      )}
    >
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
  submissionInProgress,
  submissionFailureMessage,
  onSignOut,
}: {
  team: CurrentTeam
  intake: CurrentIntake
  members: CurrentTeamMember[]
  teamEditable: boolean
  serverNow: number
  submissionInProgress: boolean
  submissionFailureMessage?: string
  onSignOut: () => void
}) {
  const draft = intake.draft
  const autosaveWorkingField = useMutation(api.intake.autosaveWorkingField)
  const saveIdea = useMutation(api.intake.saveInitialIdea)
  const respondToFollowUp = useMutation(api.intake.respondToFollowUp)
  const settleAdaptiveQuestionDeadline = useMutation(
    api.intake.settleAdaptiveQuestionDeadline,
  )
  const reviseFollowUp = useMutation(api.intake.reviseFollowUp)
  const saveAdditionalInformation = useMutation(api.intake.saveAdditionalInformation)
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
  const pendingIdeaBaseVersion = useRef<number | null>(null)
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
  const [reviewAnswerEdit, setReviewAnswerEdit] = useState<ReviewAnswerEdit | null>(null)
  const [reviewSequenceActive, setReviewSequenceActive] = useState(false)
  const reviewWorkingRevision = useRef(0)
  const pendingReviewAutosave = useRef<string | null>(null)
  const [editingIdea, setEditingIdea] = useState(false)
  const [additionalInformationEdit, setAdditionalInformationEdit] =
    useState<AdditionalInformationEdit | null>(null)
  // Which tucked sheet in the follow-up pile is peeked open, by question id.
  const [peekQuestionId, setPeekQuestionId] = useState<string | null>(null)
  const [pendingFollowUp, setPendingFollowUp] = useState<PendingFollowUp | null>(null)
  const [pendingReviewAnswer, setPendingReviewAnswer] =
    useState<PendingReviewAnswer | null>(null)
  // The mockup splits the old single review screen into reading the proposal
  // (f5) and confirming the lock (f6).
  const [confirming, setConfirming] = useState(false)
  const [openSections, setOpenSections] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const commandInFlight = useRef(false)
  const applicationsClosed = useDeadlineReached(serverNow, intake.applicationsCloseAt)
  const applicationsOpen = !applicationsClosed
  const operations = useOperationRunner<IntakeOperationResult>()
  const { capture } = useProductAnalytics()
  const ideaEditorOpen = !draft || draft.stage === 'opening' || editingIdea
  const { editors, markEditing, stopEditing } = useEditingPresence(team.canWriteProject)
  const closeDateLabel = new Date(intake.applicationsCloseAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })

  const novelty = draft?.novelty ?? opening?.novelty ?? null
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
  const reviewAnswerSlot = pendingReviewAnswer
    ? `review-answer:${pendingReviewAnswer.questionId}`
    : null
  const reviewAnswerPending =
    reviewAnswerSlot !== null && operations.hasPending(reviewAnswerSlot)
  const freshnessPending = operations.hasPending('freshness')
  const additionalInformationPending = operations.hasPending('additional-information')
  const submitPending = operations.hasPending('final-submit')

  useEffect(() => {
    if (applicationsClosed) stopEditing()
  }, [applicationsClosed, stopEditing])

  useEffect(() => {
    const deadlineAt = draft?.adaptiveQuestionDeadlineAt
    if (
      !applicationsOpen ||
      draft?.stage !== 'follow_up' ||
      activeFollowUp !== undefined ||
      deadlineAt === undefined
    ) {
      return
    }

    let canceled = false
    let timer: number | null = null
    const memberGraceMs = intake.currentRole === 'lead' ? 50 : 2_000

    const schedule = (delayMs: number) => {
      timer = window.setTimeout(() => {
        void settleAdaptiveQuestionDeadline({
          eventSlug,
          expectedDraftVersion: draft.version,
          deadlineAt,
        }).then((result) => {
          if (canceled || result.state !== 'waiting') return
          schedule(Math.max(50, deadlineAt - result.serverNow + memberGraceMs))
        }).catch(() => {
          if (!canceled) schedule(1_000)
        })
      }, Math.max(0, delayMs))
    }

    schedule(deadlineAt - intake.serverNow + memberGraceMs)
    return () => {
      canceled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [
    activeFollowUp,
    applicationsOpen,
    draft?.adaptiveQuestionDeadlineAt,
    draft?.stage,
    draft?.version,
    intake.currentRole,
    intake.serverNow,
    settleAdaptiveQuestionDeadline,
  ])

  useEffect(() => {
    const savedValue = draft?.initialIdea ?? ''
    const savedVersion = draft?.version ?? 0
    const serverWorkingValue = workingIdea?.value ?? savedValue
    const serverWorkingRevision = workingIdea?.revision ?? 0
    if (!ideaDirty) {
      ideaBase.current = { value: savedValue, version: savedVersion }
      ideaWorkingRevision.current = serverWorkingRevision
      // oxlint-disable-next-line react/set-state-in-effect -- This reconciles the collaborative server working copy after its version changes.
      setIdea(serverWorkingValue)
      setIdeaDirty(false)
      setIdeaConflict(false)
      clearSessionDraft(ideaStorageKey)
      return
    }
    if (savedVersion !== ideaBase.current.version) {
      if (savedValue === ideaBase.current.value) {
        ideaBase.current = { value: savedValue, version: savedVersion }
        setIdeaConflict(false)
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
    if (!shouldReplaceFollowUpEditorValue(followUpBase.current.questionId, nextQuestionId)) return
    const priorQuestionId = followUpBase.current.questionId
    setPendingFollowUp(null)
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
      followUpBase.current.questionId === activeFollowUp.id &&
      followUpBase.current.version !== (draft?.version ?? 0)
    ) {
      const currentVersion = draft?.version ?? 0
      followUpBase.current = { questionId: activeFollowUp.id, version: currentVersion }
      setFollowUpConflict(false)
      if (answer) {
        writeVersionedSessionDraft(
          `c2c:${eventSlug}:${team.id}:follow-up:${activeFollowUp.id}`,
          { base: String(currentVersion), value: answer },
        )
      }
    }
  }, [activeFollowUp, answer, draft?.version, team.id])

  useEffect(() => {
    if (!preview || !reviewAnswerEdit) return
    const savedAnswer = preview.followUps.find(
      (followUp) => followUp.id === reviewAnswerEdit.questionId,
    )?.answer
    if (savedAnswer === undefined) return
    const reconciliation = reconcileCommittedField({
      baseVersion: reviewAnswerEdit.baseDraftVersion,
      baseValue: reviewAnswerEdit.baseValue,
      localValue: reviewAnswerEdit.value,
      serverVersion: preview.draftVersion,
      serverValue: savedAnswer,
    })
    if (reconciliation.kind === 'unchanged') return
    if (reconciliation.kind === 'conflict') {
      if (reviewAnswerEdit.conflict) return
      // oxlint-disable-next-line react/set-state-in-effect -- Preserve the local answer and mark the remote revision conflict explicitly.
      setReviewAnswerEdit((current) => current ? { ...current, conflict: true } : null)
      setError(null)
      return
    }
    const storageKey = `c2c:${eventSlug}:${team.id}:review:${reviewAnswerEdit.questionId}`
    if (reconciliation.kind === 'acknowledge') clearSessionDraft(storageKey)
    else {
      writeVersionedSessionDraft(storageKey, {
        base: String(reconciliation.version),
        value: reviewAnswerEdit.value,
      })
    }
    setReviewAnswerEdit((current) => {
      if (!current || current.questionId !== reviewAnswerEdit.questionId) return current
      return {
        ...current,
        baseValue: savedAnswer,
        baseDraftVersion: reconciliation.version,
        conflict: false,
      }
    })
  }, [preview, reviewAnswerEdit, team.id])

  useEffect(() => {
    if (!preview || !additionalInformationEdit) return
    const savedValue = preview.additionalInformation ?? ''
    const reconciliation = reconcileCommittedField({
      baseVersion: additionalInformationEdit.baseDraftVersion,
      baseValue: additionalInformationEdit.baseValue,
      localValue: additionalInformationEdit.value,
      serverVersion: preview.draftVersion,
      serverValue: savedValue,
    })
    if (reconciliation.kind === 'unchanged') return
    if (reconciliation.kind === 'conflict') {
      if (additionalInformationEdit.conflict) return
      // oxlint-disable-next-line react/set-state-in-effect -- Preserve the local answer and mark the remote revision conflict explicitly.
      setAdditionalInformationEdit((current) => current ? { ...current, conflict: true } : null)
      setError(null)
      return
    }
    if (reconciliation.kind === 'acknowledge') {
      setAdditionalInformationEdit(null)
      setError(null)
      return
    }
    setAdditionalInformationEdit((current) => current
      ? { ...current, baseValue: savedValue, baseDraftVersion: reconciliation.version }
      : null)
  }, [additionalInformationEdit, preview])

  const noveltyState = useNoveltyPreview({
    idea,
    ideaLength: normalizedIdeaLength(idea),
    // Keep checking after Next when the user saved before the typing preview
    // began. The result is persisted to the draft and appears reactively in
    // the review instead of leaving an empty gap.
    active:
      ideaEditorOpen || (draft?.stage === 'review' && savedNoveltyScore === null),
    config: novelty,
    saved: { idea: draft?.initialIdea, score: savedNoveltyScore, band: savedNoveltyBand },
  })

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
        baseCommittedValue: ideaBase.current.value,
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
      if (isIntakeCollaborationConflict(autosaveError)) {
        setIdeaConflict(true)
        setError(null)
      } else {
        setError(readableError(autosaveError))
      }
    },
  })

  const { retry: retryFollowUpAutosave, state: followUpAutosaveState } = useDebouncedAutosave({
    enabled:
      applicationsOpen &&
      activeFollowUp !== undefined &&
      pendingFollowUp === null &&
      !followUpConflict &&
      answer.length <= (draft?.intakePolicy.followUpAnswerMaxLength ?? 0),
    initialSavedValue: workingFollowUp?.value ?? '',
    resetKey: `follow-up:${activeFollowUp?.id ?? 'none'}:${draft?.version ?? 0}`,
    value: answer,
    save: (value) => {
      if (!activeFollowUp) return Promise.reject(new Error('The follow-up changed.'))
      return autosaveWorkingField({
        eventSlug,
        field: { kind: 'follow_up', questionId: activeFollowUp.id },
        value,
        baseDraftVersion: followUpBase.current.version,
        baseCommittedValue: '',
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
      if (isIntakeCollaborationConflict(autosaveError)) {
        setFollowUpConflict(true)
        setError(null)
      } else {
        setError(readableError(autosaveError))
      }
    },
  })

  const editingFollowUp = reviewAnswerEdit === null
    ? undefined
    : draft?.followUps.find((followUp) => followUp.id === reviewAnswerEdit.questionId)
  const workingReviewFollowUp = reviewAnswerEdit === null
    ? undefined
    : intake.workingFields.find(
        (field) =>
          field.kind === 'follow_up' && field.questionId === reviewAnswerEdit.questionId,
      )

  useEffect(() => {
    if (
      !reviewAnswerEdit ||
      !workingReviewFollowUp ||
      workingReviewFollowUp.revision === reviewWorkingRevision.current
    ) return
    const reconciliation = reconcileWorkingCopy({
      knownRevision: reviewWorkingRevision.current,
      localDirty: reviewAnswerEdit.value !== reviewAnswerEdit.baseValue,
      localValue: reviewAnswerEdit.value,
      pendingValue: pendingReviewAutosave.current,
      serverRevision: workingReviewFollowUp.revision,
      serverValue: workingReviewFollowUp.value,
    })
    if (reconciliation.kind === 'unchanged') return
    // oxlint-disable-next-line react/set-state-in-effect -- Preserve divergent local text and surface the collaborative working-copy conflict.
    if (reconciliation.kind === 'conflict') {
      setReviewAnswerEdit((current) => current ? { ...current, conflict: true } : null)
      setError(null)
      return
    }
    reviewWorkingRevision.current = reconciliation.revision
    if (reconciliation.kind === 'continue') {
      pendingReviewAutosave.current = null
      return
    }
    if (reconciliation.kind === 'adopt') {
      // oxlint-disable-next-line react/set-state-in-effect -- Adopt a teammate's working copy only when this editor has no local change.
      setReviewAnswerEdit((current) => current
        ? { ...current, value: reconciliation.value, conflict: false }
        : null)
    }
    pendingReviewAutosave.current = null
    clearSessionDraft(
      `c2c:${eventSlug}:${team.id}:review:${reviewAnswerEdit.questionId}`,
    )
  }, [reviewAnswerEdit, team.id, workingReviewFollowUp])

  const { retry: retryRevisionAutosave, state: revisionAutosaveState } = useDebouncedAutosave({
    delayMs: 400,
    enabled:
      applicationsOpen &&
      draft?.stage === 'review' &&
      editingFollowUp !== undefined &&
      reviewAnswerEdit !== null &&
      pendingReviewAnswer === null &&
      !reviewAnswerEdit.conflict &&
      reviewAnswerEdit.value.length <= draft.intakePolicy.followUpAnswerMaxLength,
    initialSavedValue: workingReviewFollowUp?.value ?? reviewAnswerEdit?.baseValue ?? '',
    resetKey:
      `review:${reviewAnswerEdit?.questionId ?? 'none'}:${reviewAnswerEdit?.baseDraftVersion ?? 0}`,
    value: reviewAnswerEdit?.value ?? '',
    save: (value) => {
      if (!editingFollowUp || !reviewAnswerEdit) {
        return Promise.reject(new Error('That answer is no longer editable.'))
      }
      pendingReviewAutosave.current = value
      return autosaveWorkingField({
        eventSlug,
        field: { kind: 'follow_up', questionId: editingFollowUp.id },
        value,
        baseDraftVersion: reviewAnswerEdit.baseDraftVersion,
        baseCommittedValue: reviewAnswerEdit.baseValue,
        expectedRevision: reviewWorkingRevision.current,
      })
    },
    onSaved: (result, savedValue) => {
      pendingReviewAutosave.current = null
      reviewWorkingRevision.current = result.revision
      if (savedValue === reviewAnswerEdit?.value && editingFollowUp) {
        clearSessionDraft(`c2c:${eventSlug}:${team.id}:review:${editingFollowUp.id}`)
      }
      setError(null)
    },
    onError: (autosaveError) => {
      pendingReviewAutosave.current = null
      if (isIntakeCollaborationConflict(autosaveError)) {
        setReviewAnswerEdit((current) => current ? { ...current, conflict: true } : null)
        setError(null)
      } else {
        setError(readableError(autosaveError))
      }
    },
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

  const startReviewAnswerEdit = (
    followUp: ReviewFollowUp,
    draftVersion: number,
  ) => {
    const storageKey = `c2c:${eventSlug}:${team.id}:review:${followUp.id}`
    const recovered = readVersionedSessionDraft(storageKey)
    const savedAnswer = followUp.answer ?? ''
    const workingField = intake.workingFields.find(
      (field) => field.kind === 'follow_up' && field.questionId === followUp.id,
    )
    const revision = recoverProposalRevision(
      workingField?.value ?? savedAnswer,
      draftVersion,
      recovered,
    )
    reviewWorkingRevision.current = workingField?.revision ?? 0
    pendingReviewAutosave.current = null
    setReviewAnswerEdit({
      questionId: followUp.id,
      value: revision.answer,
      baseValue: savedAnswer,
      baseDraftVersion: revision.baseDraftVersion,
      conflict:
        revision.recovered &&
        (
          revision.baseDraftVersion !== draftVersion ||
          (workingField !== undefined && workingField.value !== revision.answer)
        ),
    })
    if (!revision.recovered) clearSessionDraft(storageKey)
  }

  const completeIdeaSave = (
    result: InitialIdeaResult,
    submittedDraftVersion: number,
  ) => {
    pendingIdeaBaseVersion.current = null
    clearSessionDraft(ideaStorageKey)
    setIdeaDirty(false)
    setIdeaConflict(false)
    stopEditing()
    setEditingIdea(false)

    const firstQuestionId = firstReviewQuestionAfterIdeaSave({
      questionIds: preview?.followUps.map((followUp) => followUp.id) ?? [],
      reviewSequenceActive,
      savedDraftVersion: result.draftVersion,
      submittedDraftVersion,
    })
    const firstQuestion = preview?.followUps.find(
      (followUp) => followUp.id === firstQuestionId,
    )
    if (firstQuestion) {
      startReviewAnswerEdit(firstQuestion, result.draftVersion)
      return
    }
    setReviewSequenceActive(false)
    setReviewAnswerEdit(null)
  }

  const completeReviewAnswerSave = (
    result: ReviewAnswerResult,
    pending: PendingReviewAnswer,
  ) => {
    setPendingReviewAnswer(null)
    pendingReviewAutosave.current = null
    clearSessionDraft(`c2c:${eventSlug}:${team.id}:review:${pending.questionId}`)
    stopEditing()
    setError(null)

    const nextQuestionId = nextReviewQuestionAfterAnswerSave({
      currentQuestionId: pending.questionId,
      questionIds: preview?.followUps.map((followUp) => followUp.id) ?? [],
      reviewSequenceActive: pending.sequenceActive,
      savedDraftVersion: result.draftVersion,
      submittedDraftVersion: pending.submittedDraftVersion,
    })
    const nextQuestion = preview?.followUps.find(
      (followUp) => followUp.id === nextQuestionId,
    )
    if (nextQuestion) {
      startReviewAnswerEdit(nextQuestion, result.draftVersion)
      return
    }
    setReviewAnswerEdit(null)
    setReviewSequenceActive(false)
  }

  const submitReviewAnswer = (followUp: ReviewFollowUp) => {
    if (!reviewAnswerEdit || pendingReviewAnswer) return
    const pending = {
      questionId: followUp.id,
      submittedDraftVersion: reviewAnswerEdit.baseDraftVersion,
      submittedWorkingRevision: reviewWorkingRevision.current,
      sequenceActive: reviewSequenceActive,
    } satisfies PendingReviewAnswer
    const submittedAnswer = reviewAnswerEdit.value
    const slot = `review-answer:${followUp.id}`
    if (!operations.hasPending(slot)) setPendingReviewAnswer(pending)
    void run(async () => {
      try {
        const result = await operations.run(slot, (clientOperationId) => () => reviseFollowUp({
          eventSlug,
          questionId: followUp.id,
          answer: submittedAnswer,
          expectedDraftVersion: pending.submittedDraftVersion,
          expectedWorkingRevision: pending.submittedWorkingRevision,
          clientOperationId,
        }))
        if (!isReviewAnswerResult(result)) {
          throw new Error('The answer save returned an unexpected result.')
        }
        completeReviewAnswerSave(result, pending)
      } catch (caught) {
        if (!operations.hasPending(slot)) setPendingReviewAnswer(null)
        if (!isIntakeCollaborationConflict(caught)) throw caught
        setReviewAnswerEdit((current) => current ? { ...current, conflict: true } : null)
        setError(null)
      }
    })
  }

  const submitIdea = (event: FormEvent) => {
    event.preventDefault()
    const submittedDraftVersion = ideaBase.current.version
    pendingIdeaBaseVersion.current = submittedDraftVersion
    void run(async () => {
      try {
        const result = await operations.run('idea', (clientOperationId) => () => saveIdea({
            eventSlug,
            idea,
            expectedDraftVersion: submittedDraftVersion,
            clientOperationId,
          }))
        if (!isInitialIdeaResult(result)) {
          throw new Error('The idea save returned an unexpected result.')
        }
        completeIdeaSave(result, submittedDraftVersion)
        capture('c2c_idea_saved', {
          c2c_editing_existing_idea: submittedDraftVersion > 0,
        })
      } catch (caught) {
        if (!operations.hasPending('idea')) pendingIdeaBaseVersion.current = null
        if (!isIntakeCollaborationConflict(caught)) throw caught
        setIdeaConflict(true)
        setError(null)
      }
    })
  }

  const submitAnswer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeFollowUp || pendingFollowUp) return
    const submittedAnswer = new FormData(event.currentTarget).get('follow-up-answer')
    if (typeof submittedAnswer !== 'string') return
    const submittedQuestion = activeFollowUp
    const submittedDraftVersion = followUpBase.current.version
    void run(async () => {
      const slot = `follow-up:${submittedQuestion.id}`
      if (!operations.hasPending(slot)) {
        setPendingFollowUp({ questionId: submittedQuestion.id })
      }
      try {
        await operations.run(slot, (clientOperationId) => () => respondToFollowUp({
            eventSlug,
            questionId: submittedQuestion.id,
            answer: submittedAnswer,
            expectedDraftVersion: submittedDraftVersion,
            clientOperationId,
          }))
      } catch (caught) {
        if (!isIntakeCollaborationConflict(caught)) {
          if (!operations.hasPending(slot)) setPendingFollowUp(null)
          throw caught
        }
        setFollowUpConflict(true)
        setPendingFollowUp(null)
        setError(null)
        return
      }
      clearSessionDraft(`c2c:${eventSlug}:${team.id}:follow-up:${submittedQuestion.id}`)
      capture('c2c_follow_up_answered')
      setFollowUpConflict(false)
      setPeekQuestionId(null)
      stopEditing()
    })
  }

  const submitAdditionalInformation = (event: FormEvent) => {
    event.preventDefault()
    const completingStep = draft?.stage === 'additional_information'
    if (!completingStep && (!preview || additionalInformationEdit === null)) return
    const value = additionalInformationEdit?.value ?? draft?.additionalInformation ?? ''
    const baseValue = additionalInformationEdit?.baseValue ?? draft?.additionalInformation ?? ''
    const expectedDraftVersion = additionalInformationEdit?.baseDraftVersion
      ?? draft?.version
    if (expectedDraftVersion === undefined) return
    void run(async () => {
      try {
        await operations.run(
          'additional-information',
          (clientOperationId) => () => saveAdditionalInformation({
            eventSlug,
            value,
            baseValue,
            expectedDraftVersion,
            clientOperationId,
          }),
        )
      } catch (caught) {
        if (!isIntakeCollaborationConflict(caught)) throw caught
        setAdditionalInformationEdit((current) => current ? { ...current, conflict: true } : null)
        setError(null)
        return
      }
      capture('c2c_additional_information_saved', {
        c2c_has_additional_information: value.trim().length > 0,
      })
      setAdditionalInformationEdit(null)
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
        : reviewAnswerPending && pendingReviewAnswer
          ? {
              kind: 'review_answer',
              slot: `review-answer:${pendingReviewAnswer.questionId}`,
              action: 'Confirm answer',
            }
        : additionalInformationPending
          ? {
              kind: 'additional_information',
              slot: 'additional-information',
              action: 'Confirm additional information',
            }
        : freshnessPending
              ? { kind: 'freshness', slot: 'freshness', action: 'Confirm answer' }
              : submitPending
                ? { kind: 'submit', slot: 'final-submit', action: 'Confirm submission' }
                : null

  const clearPendingOperation = (operation: PendingIntakeOperation) => {
    if (operation.kind === 'idea') {
      pendingIdeaBaseVersion.current = null
      setReviewSequenceActive(false)
      setReviewAnswerEdit(null)
      setEditingIdea(false)
      return
    }
    if (operation.kind === 'follow_up') {
      setPendingFollowUp(null)
      return
    }
    if (operation.kind === 'review_answer') {
      setPendingReviewAnswer(null)
      return
    }
    if (operation.kind === 'additional_information') {
      setAdditionalInformationEdit(null)
    }
  }

  const confirmPendingOperation = (operation: PendingIntakeOperation) => {
    void run(async () => {
      if (operation.kind === 'submit') markSubmissionCelebration()
      try {
        const result = await operations.retryPending(operation.slot)
        if (operation.kind === 'idea') {
          const submittedDraftVersion = pendingIdeaBaseVersion.current
          if (submittedDraftVersion === null || !isInitialIdeaResult(result)) {
            throw new Error('The pending idea save could not be restored.')
          }
          completeIdeaSave(result, submittedDraftVersion)
          return
        }
        if (operation.kind === 'review_answer') {
          if (!pendingReviewAnswer || !isReviewAnswerResult(result)) {
            throw new Error('The pending answer save could not be restored.')
          }
          completeReviewAnswerSave(result, pendingReviewAnswer)
          return
        }
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
                setIdea(nextIdea)
                setIdeaDirty(true)
                writeVersionedSessionDraft(ideaStorageKey, {
                  base: String(ideaBase.current.version),
                  value: nextIdea,
                })
                markEditing('idea')
              }}
              placeholder="Describe your idea…"
              className="bare-field min-h-[180px] border-0 bg-transparent px-0 py-0 text-[17px] leading-[1.7] focus:border-0"
            />
            <div className="mt-1 flex items-center justify-between gap-4">
              <IdeaPromptsLink />
              <span className="font-mono text-[11px] tracking-[.04em] text-fg/45">
                {idea.length} / {initialIdeaMaxLength}
              </span>
            </div>
            <PortalError message={error} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-petal-line pt-3.5">
              <NoveltyPill
                state={noveltyState}
                currentLength={normalizedIdeaLength(idea)}
                minimumLength={novelty?.minimumIdeaLength ?? null}
              />
              <div className="ml-auto flex items-center gap-4.5">
                <span className="hidden text-xs text-fg/45 sm:inline">
                  {ideaDirty ? autosaveLabel(ideaAutosaveState) : `saved · editable until ${closeDateLabel}`}
                </span>
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
    const editIdeaFromQuestions = () => {
      ideaBase.current = {
        value: draft.initialIdea ?? '',
        version: draft.version,
      }
      setIdea(draft.initialIdea ?? '')
      setIdeaDirty(false)
      setReviewSequenceActive(false)
      setReviewAnswerEdit(null)
      setEditingIdea(true)
    }
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
          <StackedSheet
            depth={answeredSheets.length + 1}
            aria-label="Edit your idea"
            onClick={editIdeaFromQuestions}
            label={(
              <>
                your idea <span className="text-fg/60">· {draft.initialIdea}</span>
              </>
            )}
          />
          {answeredSheets.map((followUp, index) => {
            const peeked = peekQuestionId === followUp.id
            return (
              <StackedSheet
                key={followUp.id}
                depth={answeredSheets.length - index}
                aria-expanded={peeked}
                onClick={() => setPeekQuestionId(peeked ? null : followUp.id)}
                label={followUp.question}
              >
                {peeked ? (
                  <>
                    <span className="mt-1 block text-[13px] leading-relaxed whitespace-pre-line wrap-anywhere text-fg/85">
                      {followUp.answer}
                    </span>
                    <span className="mt-1.5 block text-[11px] text-fg/55">
                      rewritable at review, after the last question
                    </span>
                  </>
                ) : null}
              </StackedSheet>
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
              name="follow-up-answer"
              autoFocus={activeFollowUp !== undefined}
              required
              minLength={minLength}
              maxLength={draft.intakePolicy.followUpAnswerMaxLength}
              rows={6}
              disabled={busy || pendingFollowUp !== null || !activeFollowUp}
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
              placeholder="Answer the question here…"
              className="bare-field min-h-[174px] border-0 bg-transparent px-0 py-0 text-[16.5px] leading-[1.7] focus:border-0"
            />
            <PortalError message={error} />
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3 border-t border-petal-line pt-3">
              <div className="flex items-center gap-4">
                <PortalTextButton
                  type="button"
                  disabled={busy || pendingFollowUp !== null}
                  onClick={editIdeaFromQuestions}
                >
                  ← edit idea
                </PortalTextButton>
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
              </div>
              <PortalButton
                type="submit"
                size="sm"
                disabled={
                  busy ||
                  pendingFollowUp !== null ||
                  !activeFollowUp ||
                  followUpConflict ||
                  answer.trim().length < minLength
                }
              >
                {busy || pendingFollowUp ? 'Saving…' : 'Continue'}
              </PortalButton>
            </div>
          </form>
        </PetalCard>
        </div>
      </IntakeStage>
    )
  }

  // ---- f4.5 · optional supporting details ---------------------------------
  if (draft.stage === 'additional_information') {
    const value = additionalInformationEdit?.value ?? draft.additionalInformation ?? ''
    return (
      <IntakeStage
        team={team}
        members={members}
        teamEditable={teamEditable}
        onSignOut={onSignOut}
        title="Anything else you want us to see?"
        hint="This is optional. Add a useful link or extra context, or skip this step.s"
        presence={<EditingPresence editors={editors ?? []} members={members} />}
      >
        <PetalCard className="px-6 pt-[26px] pb-[18px] lg:px-[30px]">
          <form onSubmit={submitAdditionalInformation}>
            {additionalInformationEdit?.conflict ? (
              <ConflictNotice
                cloudValue={draft.additionalInformation ?? ''}
                message={`${draftEditorLabel} saved newer additional information. Your text is still here.`}
                onUseSaved={() => {
                  setAdditionalInformationEdit(null)
                  setError(null)
                }}
                onKeepMine={() => {
                  setAdditionalInformationEdit((current) => current
                    ? {
                        ...current,
                        baseValue: draft.additionalInformation ?? '',
                        baseDraftVersion: draft.version,
                        conflict: false,
                      }
                    : null)
                  setError(null)
                }}
              />
            ) : null}
            <PortalLabel>{additionalInformationLabel}</PortalLabel>
            <PortalTextarea
              aria-label={additionalInformationLabel}
              autoFocus
              rows={6}
              maxLength={draft.additionalInformationMaxLength}
              disabled={busy}
              value={value}
              placeholder="Share a website, repository, document or anything else useful."
              onChange={(event) => {
                const nextValue = event.currentTarget.value
                setAdditionalInformationEdit((current) => current
                  ? { ...current, value: nextValue }
                  : {
                      value: nextValue,
                      baseValue: draft.additionalInformation ?? '',
                      baseDraftVersion: draft.version,
                      conflict: false,
                    })
                setError(null)
                markEditing('proposal_revision')
              }}
            />
            <PortalError message={error} />
            <div className="mt-3 flex items-center justify-between gap-4 border-t border-petal-line pt-3.5">
              <span className="font-mono text-[11px] tracking-[.04em] text-fg/45">
                {value.length} / {draft.additionalInformationMaxLength}
              </span>
              <PortalButton
                type="submit"
                size="sm"
                disabled={busy || additionalInformationPending || additionalInformationEdit?.conflict}
              >
                {busy ? 'Saving…' : value.trim() ? 'Save and continue' : 'Skip'}
              </PortalButton>
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
          teamEditable={teamEditable}
          onSignOut={onSignOut}
          title={<ShimmerText className="text-fg/55">Putting everything together…</ShimmerText>}
          hint="Your current team and idea will appear here."
        />
      )
    }
    const canSubmit =
      !submissionInProgress &&
      preview.blockers.length === 0 &&
      preview.freshnessAttested &&
      team.currentRole === 'lead' &&
      team.canSubmitApplication

    const editIdea = () => {
      const savedIdea = preview.initialIdea ?? ''
      ideaBase.current = { value: savedIdea, version: preview.draftVersion }
      setIdea(savedIdea)
      setIdeaDirty(false)
      setReviewSequenceActive(true)
      setReviewAnswerEdit(null)
      setEditingIdea(true)
    }

    const reviewFollowUp = reviewAnswerEdit === null
      ? undefined
      : preview.followUps.find((followUp) => followUp.id === reviewAnswerEdit.questionId)

    if (reviewAnswerEdit !== null && reviewFollowUp === undefined) {
      return (
        <IntakeStage
          team={team}
          members={members}
          teamEditable={teamEditable}
          onSignOut={onSignOut}
          title="That question changed."
          hint="Your team’s current questions are ready on the review page."
        >
          <PortalButton
            type="button"
            onClick={() => {
              setReviewAnswerEdit(null)
              setReviewSequenceActive(false)
              setError(null)
            }}
          >
            Return to review
          </PortalButton>
        </IntakeStage>
      )
    }

    if (reviewAnswerEdit !== null && reviewFollowUp !== undefined) {
      const questionIds = preview.followUps.map((followUp) => followUp.id)
      const nextQuestionId = reviewSequenceActive
        ? nextReviewQuestionId(questionIds, reviewFollowUp.id)
        : null
      const answerLength = reviewAnswerEdit.value.trim().length
      const answerValidation = answerLength === 0
        ? 'This answer is required.'
        : answerLength < draft.intakePolicy.followUpAnswerMinLength
          ? `Write at least ${draft.intakePolicy.followUpAnswerMinLength} characters.`
          : null
      const answerReady =
        !reviewAnswerEdit.conflict &&
        !reviewAnswerPending &&
        revisionAutosaveState !== 'dirty' &&
        revisionAutosaveState !== 'saving' &&
        revisionAutosaveState !== 'error' &&
        answerLength >= draft.intakePolicy.followUpAnswerMinLength &&
        answerLength <= draft.intakePolicy.followUpAnswerMaxLength
      return (
        <IntakeStage
          team={team}
          members={members}
          teamEditable={teamEditable}
          onSignOut={onSignOut}
          title={reviewFollowUp.question}
          presence={<EditingPresence editors={editors ?? []} members={members} />}
        >
          <PetalCard className="px-6 pt-[26px] pb-[18px] lg:px-[30px]">
            {reviewAnswerEdit.conflict ? (
              <ConflictNotice
                cloudValue={workingReviewFollowUp?.value ?? reviewFollowUp.answer ?? ''}
                message={`${editorLabel(
                  members,
                  team.currentMembershipId,
                  workingReviewFollowUp?.writtenByMembershipId ??
                    preview.lastEditedByMembershipId,
                )} saved a newer answer. Your text is still here.`}
                onUseSaved={() => {
                  const cloudValue = workingReviewFollowUp?.value ?? reviewFollowUp.answer ?? ''
                  reviewWorkingRevision.current = workingReviewFollowUp?.revision ?? 0
                  setReviewAnswerEdit({
                    questionId: reviewFollowUp.id,
                    value: cloudValue,
                    baseValue: reviewFollowUp.answer ?? '',
                    baseDraftVersion: preview.draftVersion,
                    conflict: false,
                  })
                  clearSessionDraft(
                    `c2c:${eventSlug}:${team.id}:review:${reviewFollowUp.id}`,
                  )
                }}
                onKeepMine={() => {
                  reviewWorkingRevision.current = workingReviewFollowUp?.revision ?? 0
                  setReviewAnswerEdit((current) => current
                    ? {
                        ...current,
                        baseValue: reviewFollowUp.answer ?? '',
                        baseDraftVersion: preview.draftVersion,
                        conflict: false,
                      }
                    : null)
                  writeVersionedSessionDraft(
                    `c2c:${eventSlug}:${team.id}:review:${reviewFollowUp.id}`,
                    {
                      base: String(preview.draftVersion),
                      value: reviewAnswerEdit.value,
                    },
                  )
                  retryRevisionAutosave()
                }}
              />
            ) : null}
            <PortalTextarea
              autoFocus
              required
              minLength={draft.intakePolicy.followUpAnswerMinLength}
              maxLength={draft.intakePolicy.followUpAnswerMaxLength}
              rows={6}
              disabled={busy}
              aria-invalid={answerValidation !== null}
              value={reviewAnswerEdit.value}
              onChange={(event) => {
                const nextAnswer = event.currentTarget.value
                setReviewAnswerEdit((current) => current
                  ? { ...current, value: nextAnswer }
                  : null)
                writeVersionedSessionDraft(
                  `c2c:${eventSlug}:${team.id}:review:${reviewFollowUp.id}`,
                  {
                    base: String(reviewAnswerEdit.baseDraftVersion),
                    value: nextAnswer,
                  },
                )
                setError(null)
                markEditing('follow_up', reviewFollowUp.id)
              }}
              placeholder="Answer the question here…"
              className="bare-field min-h-[174px] border-0 bg-transparent px-0 py-0 text-[16.5px] leading-[1.7] focus:border-0"
            />
            <PortalError message={error ?? answerValidation} reserve />
            <div className="mt-2.5 flex items-center justify-between gap-4 border-t border-petal-line pt-3">
              <span className="text-xs text-fg/45">
                {reviewAnswerEdit.value.length > draft.intakePolicy.followUpAnswerMaxLength * 0.8
                  ? `${reviewAnswerEdit.value.length} / ${draft.intakePolicy.followUpAnswerMaxLength}`
                  : autosaveLabel(revisionAutosaveState)}
              </span>
              <div className="flex items-center gap-4">
                <PortalTextButton
                  type="button"
                  disabled={
                    busy ||
                    reviewAnswerPending ||
                    revisionAutosaveState === 'dirty' ||
                    revisionAutosaveState === 'saving' ||
                    answerValidation !== null
                  }
                  onClick={() => {
                    stopEditing()
                    setReviewAnswerEdit(null)
                    setReviewSequenceActive(false)
                    setError(null)
                  }}
                >
                  back to review
                </PortalTextButton>
                <PortalButton
                  type="button"
                  size="sm"
                  disabled={busy || !answerReady}
                  onClick={() => submitReviewAnswer(reviewFollowUp)}
                >
                  {busy || reviewAnswerPending
                    ? 'Saving…'
                    : reviewSequenceActive
                      ? nextQuestionId === null
                        ? 'Review'
                        : 'Next'
                      : 'Done'}
                </PortalButton>
              </div>
            </div>
          </PetalCard>
        </IntakeStage>
      )
    }

    // f6 · confirm
    if (confirming || submissionInProgress) {
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
              {/* On a phone the summary runs past the row; it fades out rather
                  than ending in an ellipsis. */}
              <FadeText as="p" className="m-0 min-w-0 text-left text-[15.5px] font-semibold">
                {preview.teamName}{' '}
                <span className="font-normal text-fg/55">
                  · idea + {preview.followUps.length}{' '}
                  {preview.followUps.length === 1 ? 'answer' : 'answers'}
                  {savedNoveltyScore !== null ? ` · novelty ${savedNoveltyScore}/100` : ''}
                </span>
              </FadeText>
              {!submissionInProgress ? (
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="flex-none text-xs text-fg/55 transition-colors hover:text-rose-light"
                >
                  review idea
                </button>
              ) : null}
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
              disabled={busy || submissionInProgress}
              onChange={(accepted) => {
                void run(async () => {
                  try {
                    await operations.run('freshness', (clientOperationId) => () => setFreshness({
                      eventSlug,
                      accepted,
                      expectedDraftVersion: preview.draftVersion,
                      clientOperationId,
                    }))
                  } catch (caught) {
                    if (!isIntakeCollaborationConflict(caught)) throw caught
                    setError(null)
                  }
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
              {submissionInProgress ? (
                <p role="status" className="m-0 flex items-center gap-2 text-[12px] text-fg/55">
                  <span
                    aria-hidden
                    className="size-1.5 animate-dot-pulse rounded-full bg-rose-light"
                  />
                  Confirming your team and answers
                </p>
              ) : (
                <PortalTextButton type="button" disabled={busy} onClick={() => setConfirming(false)}>
                  back
                </PortalTextButton>
              )}
              <PortalButton
                type="button"
                size="sm"
                variant="solid"
                disabled={busy || submissionInProgress || !canSubmit}
                onClick={() => {
                  if (submissionInProgress) return
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
                      capture('c2c_application_submitted', {
                        c2c_team_size: preview.members.length,
                      })
                    } catch (caught) {
                      if (!operations.hasPending('final-submit')) {
                        clearSubmissionCelebration()
                      }
                      if (isIntakeCollaborationConflict(caught)) {
                        setConfirming(false)
                        setError(null)
                        return
                      }
                      throw caught
                    }
                  })
                }}
              >
                {busy || submissionInProgress ? 'Submitting…' : 'Submit'}
              </PortalButton>
            </div>
          </PetalCard>
        </IntakeStage>
      )
    }

    // f5 · the proposal, together
    const ideaSectionId = 'idea'
    const revealSection = (id: string) =>
      setOpenSections((open) => (open.includes(id) ? open : [...open, id]))

    return (
      <PortalScene
        onSignOut={onSignOut}
        tree="left"
        header={(
          <TeamCluster
            team={team}
            members={members}
            editable={teamEditable}
            canManage={team.currentRole === 'lead' && teamEditable}
          />
        )}
      >
        <div className="flex w-full max-w-[760px] flex-col items-center">
          <h1 className="mb-6 text-center font-display font-light tracking-[-.01em] wrap-anywhere text-3xl text-shadow-[0_6px_40px_var(--scene-text-glow)] lg:text-[44px]">
            {preview.teamName}
          </h1>

          <EditingPresence editors={editors ?? []} members={members} />

          <PetalCard className="px-6 py-2 sm:px-8">
            {novelty !== null ? (
              <NoveltyReviewRow
                score={savedNoveltyScore}
                band={savedNoveltyBand}
                checking={savedNoveltyScore === null && noveltyState.status === 'checking'}
              />
            ) : null}
            <AccordionRoot
              allowMultiple
              value={openSections}
              onValueChange={setOpenSections}
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
                    const savedAnswer = preview.followUps.find(
                      (followUp) => followUp.id === recoveredFollowUp.questionId,
                    )?.answer ?? ''
                    revealSection(recoveredFollowUp.questionId)
                    setReviewSequenceActive(false)
                    setReviewAnswerEdit({
                      questionId: recoveredFollowUp.questionId,
                      value: recoveredFollowUp.answer,
                      baseValue: savedAnswer,
                      baseDraftVersion: preview.draftVersion,
                      conflict: false,
                    })
                    setRecoveredFollowUp(null)
                  }}
                >
                  Review my draft
                </PortalTextButton>
              </div>
            ) : null}

            {preview.followUps.map((followUp) => (
              <AccordionItem key={followUp.id} value={followUp.id}>
                <AccordionItemTrigger>
                  <AccordionItemHeader>
                    <span className="text-[15px] font-semibold text-fg/85">
                      {followUp.question}
                    </span>
                  </AccordionItemHeader>
                </AccordionItemTrigger>
                <AccordionItemContent className="text-[15px] leading-relaxed wrap-anywhere text-fg">
                  <p className="whitespace-pre-line">{followUp.answer}</p>
                  <ReviewEditRow
                    busy={busy}
                    onEdit={() => {
                      setReviewSequenceActive(false)
                      startReviewAnswerEdit(followUp, preview.draftVersion)
                    }}
                  />
                </AccordionItemContent>
              </AccordionItem>
            ))}
            </AccordionRoot>

            <div className="border-t border-petal-line py-5">
              <PortalLabel>{additionalInformationLabel}</PortalLabel>
              {additionalInformationEdit !== null ? (
                <form onSubmit={submitAdditionalInformation}>
                  {additionalInformationEdit?.conflict ? (
                    <ConflictNotice
                      cloudValue={preview.additionalInformation ?? ''}
                      message={`${editorLabel(
                        members,
                        team.currentMembershipId,
                        preview.lastEditedByMembershipId,
                      )} saved newer additional information. Your text is still here.`}
                      onUseSaved={() => {
                        setAdditionalInformationEdit(null)
                        setError(null)
                      }}
                      onKeepMine={() => {
                        setAdditionalInformationEdit((current) => current
                          ? {
                              ...current,
                              baseValue: preview.additionalInformation ?? '',
                              baseDraftVersion: preview.draftVersion,
                              conflict: false,
                            }
                          : null)
                        setError(null)
                      }}
                    />
                  ) : null}
                  <PortalTextarea
                    aria-label={additionalInformationLabel}
                    autoFocus
                    rows={5}
                    maxLength={preview.additionalInformationMaxLength}
                    disabled={busy}
                    value={additionalInformationEdit?.value ?? ''}
                    placeholder="Optional: share some reference website, other documents or anything else useful."
                    onChange={(event) => {
                      const value = event.currentTarget.value
                      setAdditionalInformationEdit((current) => current
                        ? { ...current, value }
                        : {
                            value,
                            baseValue: preview.additionalInformation ?? '',
                            baseDraftVersion: preview.draftVersion,
                            conflict: false,
                          })
                      setError(null)
                    }}
                  />
                  <div className="mt-3 flex items-center justify-between gap-4">
                    <span className="text-xs text-fg/45">
                      {(additionalInformationEdit?.value ?? '').length} /{' '}
                      {preview.additionalInformationMaxLength}
                    </span>
                    <div className="flex items-center gap-4">
                      <PortalTextButton
                        type="button"
                        disabled={busy}
                        onClick={() => setAdditionalInformationEdit(null)}
                      >
                        cancel
                      </PortalTextButton>
                      <PortalButton
                        type="submit"
                        size="sm"
                        disabled={
                          busy ||
                          additionalInformationPending ||
                          additionalInformationEdit === null ||
                          additionalInformationEdit.conflict ||
                          additionalInformationEdit.value === (preview.additionalInformation ?? '')
                        }
                      >
                        {busy ? 'Saving…' : 'Save'}
                      </PortalButton>
                    </div>
                  </div>
                </form>
              ) : (
                <div>
                  {preview.additionalInformation ? (
                    <p className="whitespace-pre-line text-[15px] leading-relaxed wrap-anywhere text-fg">
                      {preview.additionalInformation}
                    </p>
                  ) : (
                    <p className="text-[15px] text-fg/45">Nothing added.</p>
                  )}
                  <ReviewEditRow
                    busy={busy}
                    onEdit={() => {
                      setAdditionalInformationEdit({
                        value: preview.additionalInformation ?? '',
                        baseValue: preview.additionalInformation ?? '',
                        baseDraftVersion: preview.draftVersion,
                        conflict: false,
                      })
                    }}
                  />
                </div>
              )}
            </div>

          </PetalCard>

          <PortalError message={error ?? submissionFailureMessage ?? null} />

          <div className="mt-8 flex flex-col items-center">
            <PortalButton
              type="button"
              disabled={
                busy ||
                (additionalInformationEdit !== null &&
                  additionalInformationEdit.value !== (preview.additionalInformation ?? ''))
              }
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
export function ReviewEditRow({ onEdit, busy }: { onEdit: () => void; busy: boolean }) {
  return (
    <div className="mt-3 flex justify-end">
      <button
        type="button"
        disabled={busy}
        onClick={onEdit}
        className="text-[12.5px] text-rose-light underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-50 motion-safe:disabled:hover:animate-shake"
      >
        edit
      </button>
    </div>
  )
}

/** What the number means, shared by the pill's popover and its mobile sheet. */
function NoveltyExplainer() {
  return (
    <div className="text-left">
      <p className="m-0 text-[13px] leading-relaxed text-fg/85">
        We compare your idea with other teams in this event and a reference set
        of past projects. A higher score means fewer close matches.
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
    </div>
  )
}

function NoveltyHelp({
  align = 'center',
  placement = 'below',
}: {
  align?: 'start' | 'center' | 'end'
  placement?: 'above' | 'below'
}) {
  const [explaining, setExplaining] = useState(false)
  const desktop = useDesktop()
  // The desktop popover goes out through a portal. Rendered inside the card
  // it lives in the scene's `main` stacking context, which sits under the
  // header, so the team circles painted straight across it.
  const side = placement === 'above' ? 'top' : 'bottom'
  const {
    refs: { setReference, setFloating },
    floatingStyles,
    context,
  } = useFloating({
    open: explaining && desktop,
    onOpenChange: setExplaining,
    placement: align === 'center' ? side : `${side}-${align}`,
    whileElementsMounted: autoUpdate,
    middleware: [offset(10), flip({ padding: 12 }), shift({ padding: 12 })],
  })
  const dismiss = useDismiss(context)
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss])

  return (
    <div className="pointer-events-auto relative flex">
      <button
        ref={setReference}
        type="button"
        aria-label="What this score means"
        aria-expanded={explaining}
        {...getReferenceProps({ onClick: () => setExplaining((value) => !value) })}
        className="flex size-[18px] items-center justify-center rounded-full border border-rose/60 text-[10px] text-rose-light/80 transition-colors hover:border-rose-light hover:text-rose-light"
      >
        ?
      </button>
      {explaining && desktop ? (
        <FloatingPortal>
          <div
            ref={setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-[60] w-[320px] rounded-petal-sm glass-menu bg-wash/90 px-6 py-5 font-normal text-fg"
          >
            <p className="mb-2.5 text-[11px] font-semibold tracking-[.08em] text-rose-light/80">
              What the score means
            </p>
            <NoveltyExplainer />
          </div>
        </FloatingPortal>
      ) : null}
      <Drawer.Root open={explaining && !desktop} onOpenChange={setExplaining}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-[rgb(6_0_2/.5)]" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 rounded-tl-box border-t border-petal-edge bg-wash outline-none">
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

export function NoveltyReviewRow({
  score,
  band,
  checking = false,
}: {
  score: number | null
  band: NoveltyBand | null
  checking?: boolean
}) {
  return (
    <div className="border-b border-petal-line pt-4 pb-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-semibold text-fg/85">Novelty</span>
        <span
          className="flex items-center gap-2 text-[12.5px] font-semibold text-rose-light"
          aria-live="polite"
        >
          {score === null
            ? checking ? 'Checking' : 'Preparing score'
            : `${score} / 100${band === null ? '' : ` · ${noveltyBandLabels[band]}`}`}
          <NoveltyHelp align="end" />
        </span>
      </div>
      <div className="mt-2.5 h-[3px] overflow-hidden rounded-full bg-petal-line" aria-hidden>
        <div
          className="h-full rounded-full bg-rose-light transition-[width] duration-700"
          style={{ width: score === null ? '18%' : `${Math.max(2, Math.min(100, score))}%` }}
        />
      </div>
    </div>
  )
}

export function NoveltyPill({
  state,
  currentLength,
  minimumLength,
  idleLabel = 'keep writing',
}: {
  state: NoveltyState
  currentLength?: number
  minimumLength: number | null
  idleLabel?: string
}) {
  if (minimumLength === null) return null
  const belowMinimum = currentLength !== undefined && currentLength < minimumLength
  const signal = belowMinimum
    ? null
    : state.status === 'ready'
      ? state.signal
      : state.status === 'checking'
        ? state.previous
        : null
  const label =
    belowMinimum || state.status === 'idle'
      ? idleLabel
      : 'checking'
  return (
    <div className="pointer-events-auto relative">
      <div className="inline-flex items-center gap-2 rounded-[9px] border border-rose-light/55 bg-wash/92 py-2 pr-2.5 pl-4 text-[12.5px] font-semibold text-rose-light shadow-[0_8px_22px_var(--shade-1)] backdrop-blur-md">
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
          {signal !== null && state.status === 'checking' ? (
            <span className="sr-only">Updating</span>
          ) : null}
        </span>
        <NoveltyHelp align="start" placement="above" />
      </div>
    </div>
  )
}
