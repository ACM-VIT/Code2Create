import { api } from '@code2create/backend/api'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ErrorNotice, TextArea } from '../components/Form'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import type { CurrentIntake, CurrentTeam } from '../types'

type NoveltySignal = {
  score: number
  band: 'familiar' | 'developing' | 'distinct'
  nearestThemeLabel: string
  reflectionPrompt: string
  comparedProjectCount: number
  corpusLabel: string
}

type NoveltyState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; signal: NoveltySignal }
  | { status: 'unavailable' }

function normalizedIdeaLength(value: string) {
  return value.trim().replace(/\s+/g, ' ').length
}

export function IntakeScreen({
  team,
  submissionFailureMessage,
}: {
  team: CurrentTeam
  submissionFailureMessage?: string
}) {
  const intake = useQuery(api.intake.current, { eventSlug })
  if (intake === undefined) return <p className="muted">Loading your application…</p>
  if (intake === null) return <ErrorNotice message="Your application is unavailable." />
  return (
    <>
      <ErrorNotice message={submissionFailureMessage ?? null} />
      <IntakeWorkspace team={team} intake={intake} />
    </>
  )
}

function IntakeWorkspace({ team, intake }: { team: CurrentTeam; intake: CurrentIntake }) {
  const draft = intake.draft
  const previewNovelty = useAction(api.novelty.preview)
  const saveIdea = useMutation(api.intake.saveInitialIdea)
  const chooseTrack = useMutation(api.intake.chooseTrack)
  const setSponsorTracks = useMutation(api.intake.setSponsorTracks)
  const respondToFollowUp = useMutation(api.intake.respondToFollowUp)
  const reviseFollowUp = useMutation(api.intake.reviseFollowUp)
  const setFreshness = useMutation(api.intake.setFreshnessAttestation)
  const submitApplication = useMutation(api.intake.submit)
  const opening = useQuery(api.intake.opening, { eventSlug })
  const preview = useQuery(
    api.intake.submissionPreview,
    draft?.stage === 'review' ? { eventSlug } : 'skip',
  )
  const [idea, setIdea] = useState(draft?.initialIdea ?? '')
  const [answer, setAnswer] = useState('')
  const [editingFollowUpId, setEditingFollowUpId] = useState<string | null>(null)
  const [editedFollowUpAnswer, setEditedFollowUpAnswer] = useState('')
  const [editingIdea, setEditingIdea] = useState(false)
  const [editingTrack, setEditingTrack] = useState(false)
  const [confirmedSnapshotKey, setConfirmedSnapshotKey] = useState<string | null>(null)
  const [pendingTrackId, setPendingTrackId] = useState<string | null>(null)
  const [pendingFollowUpKind, setPendingFollowUpKind] = useState<'answer' | 'skip' | null>(null)
  const [pendingRevisionId, setPendingRevisionId] = useState<string | null>(null)
  const [pendingRevisionKind, setPendingRevisionKind] = useState<'answer' | 'skip' | null>(null)
  const [pendingSponsorIds, setPendingSponsorIds] = useState<readonly string[] | null>(null)
  const [pendingFreshnessAccepted, setPendingFreshnessAccepted] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [noveltyState, setNoveltyState] = useState<NoveltyState>({ status: 'idle' })
  const noveltySequence = useRef(0)
  const commandInFlight = useRef(false)
  const operations = useOperationRunner()

  const ideaEditorOpen = !draft || draft.stage === 'opening' || editingIdea
  const novelty = draft?.novelty ?? opening?.novelty ?? null

  useEffect(() => {
    if (draft?.initialIdea !== undefined) setIdea(draft.initialIdea)
  }, [draft?.initialIdea])
  const activeFollowUp = draft?.followUps.find((followUp) => followUp.state === 'active')
  const ideaPending = operations.hasPending('idea')
  const followUpSlot = activeFollowUp ? `follow-up:${activeFollowUp.id}` : null
  const followUpPending = followUpSlot !== null && operations.hasPending(followUpSlot)
  const trackSlot = pendingTrackId ? `track-choice:${pendingTrackId}` : null
  const trackPending = trackSlot !== null && operations.hasPending(trackSlot)
  const revisionSlot = pendingRevisionId ? `follow-up-revision:${pendingRevisionId}` : null
  const revisionPending = revisionSlot !== null && operations.hasPending(revisionSlot)
  const sponsorPending = operations.hasPending('sponsor-tracks')
  const freshnessPending = operations.hasPending('freshness')
  const submitPending = operations.hasPending('final-submit')
  const reviewOperationPending = revisionPending || sponsorPending || freshnessPending || submitPending
  useEffect(() => setAnswer(''), [activeFollowUp?.id])

  useEffect(() => {
    noveltySequence.current += 1
    const sequence = noveltySequence.current
    const savedSignal = draft?.noveltySignal
    const savedIdeaMatches =
      draft?.initialIdea !== undefined &&
      draft.initialIdea.trim().replace(/\s+/g, ' ') === idea.trim().replace(/\s+/g, ' ')

    if (!ideaEditorOpen || !novelty || normalizedIdeaLength(idea) < novelty.minimumIdeaLength) {
      if (novelty && savedSignal && savedIdeaMatches) {
        setNoveltyState({
          status: 'ready',
          signal: {
            score: savedSignal.score,
            band: savedSignal.band,
            nearestThemeLabel: savedSignal.nearestThemeLabel,
            reflectionPrompt: savedSignal.reflectionPrompt,
            comparedProjectCount: novelty.comparedProjectCount,
            corpusLabel: novelty.corpusLabel,
          },
        })
      } else {
        setNoveltyState({ status: 'idle' })
      }
      return
    }

    const timer = window.setTimeout(() => {
      setNoveltyState({ status: 'checking' })
      void previewNovelty({
        eventSlug,
        corpusVersionId: novelty.corpusVersionId,
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
              band: result.band,
              nearestThemeLabel: result.nearestThemeLabel,
              reflectionPrompt: result.reflectionPrompt,
              comparedProjectCount: result.comparedProjectCount,
              corpusLabel: result.corpusLabel,
            },
          })
        })
        .catch(() => {
          if (noveltySequence.current === sequence) {
            setNoveltyState({ status: 'unavailable' })
          }
        })
    }, novelty.debounceMs)

    return () => window.clearTimeout(timer)
  }, [
    draft?.initialIdea,
    draft?.noveltySignal,
    draft?.noveltySignal?.band,
    draft?.noveltySignal?.nearestThemeLabel,
    draft?.noveltySignal?.reflectionPrompt,
    draft?.noveltySignal?.score,
    idea,
    ideaEditorOpen,
    novelty,
    previewNovelty,
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
          ...(novelty ? { noveltyCorpusVersionId: novelty.corpusVersionId } : {}),
          expectedDraftVersion: draft?.version ?? 0,
          clientOperationId,
        }))
      setEditingIdea(false)
    })
  }

  const submitAnswer = (event: FormEvent) => {
    event.preventDefault()
    if (!activeFollowUp) return
    void run(async () => {
      const slot = `follow-up:${activeFollowUp.id}`
      if (!operations.hasPending(slot)) setPendingFollowUpKind('answer')
      await operations.run(slot, (clientOperationId) => () => respondToFollowUp({
          eventSlug,
          questionId: activeFollowUp.id,
          answer,
          skipped: false,
          expectedDraftVersion: draft?.version ?? 0,
          clientOperationId,
        }))
      setPendingFollowUpKind(null)
    })
  }

  const tracks = draft?.tracks.filter((track) => track.type === 'core') ?? []
  const sponsorTracks = draft?.tracks.filter((track) => track.type === 'sponsor') ?? []
  const showTracks = draft?.stage === 'track_selection' || editingTrack

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
          <TextArea
            autoFocus
            required
            minLength={initialIdeaMinLength}
            maxLength={initialIdeaMaxLength}
            rows={9}
            disabled={ideaPending || busy}
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            placeholder="Describe your idea…"
          />
          <NoveltyCounter
            state={noveltyState}
            currentLength={normalizedIdeaLength(idea)}
            minimumLength={novelty?.minimumIdeaLength ?? null}
          />
          <ErrorNotice message={error} />
          <div className="minimal-surface-actions">
            {editingIdea ? (
              <button type="button" className="minimal-back" disabled={ideaPending || busy} onClick={() => setEditingIdea(false)}>
                Cancel
              </button>
              ) : <span className="character-count">{idea.length} / {initialIdeaMaxLength}</span>}
            <span className="minimal-privacy">Do not include private contact details.</span>
            <button type="submit" className="minimal-continue" disabled={busy || (!ideaPending && idea.trim().length < initialIdeaMinLength)}>
              {busy ? 'Saving…' : ideaPending ? 'Confirm earlier idea' : 'Continue'} <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
      </IntakeFrame>
    )
  }

  if (showTracks) {
    return (
      <IntakeFrame label="Choose a track" wide>
        <h1>Which track fits your idea best?</h1>
        <p className="minimal-step-hint">Choose freely. A suggestion is only guidance and never affects admission.</p>
        {draft.recommendationState === 'pending' ? (
          <p className="minimal-thinking"><span /> Checking for a possible fit…</p>
        ) : null}
        <div className="minimal-track-grid">
          {tracks.map((track, index) => {
            const recommended = draft.recommendedCoreTrackVersionId === track.id
            const selected = draft.chosenCoreTrackVersionId === track.id
            return (
              <button
                type="button"
                key={track.id}
                className={`minimal-track${recommended ? ' recommended' : ''}${selected ? ' selected' : ''}`}
                disabled={busy || (trackPending && pendingTrackId !== track.id)}
                onClick={() =>
                  void run(async () => {
                    const slot = `track-choice:${track.id}`
                    if (!operations.hasPending(slot)) setPendingTrackId(track.id)
                    await operations.run(slot, (clientOperationId) => () => chooseTrack({
                        eventSlug,
                        trackVersionId: track.id,
                        expectedDraftVersion: draft.version,
                        clientOperationId,
                      }))
                    setPendingTrackId(null)
                    setEditingTrack(false)
                  })
                }
              >
                <span className="minimal-track-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="minimal-track-copy">
                  <strong>{track.displayName}</strong>
                  <small>{track.description}</small>
                  {recommended && draft.recommendationReason ? (
                    <span className="minimal-recommendation">Suggested · {draft.recommendationReason}</span>
                  ) : null}
                </span>
                <span className="minimal-track-action">
                  {trackPending && pendingTrackId === track.id ? 'Confirm' : selected ? '✓' : '↗'}
                </span>
              </button>
            )
          })}
        </div>
        <ErrorNotice message={error} />
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
          <TextArea
            autoFocus
            required
            minLength={draft.intakePolicy.followUpAnswerMinLength}
            maxLength={draft.intakePolicy.followUpAnswerMaxLength}
            rows={6}
            disabled={followUpPending || busy}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Type your answer…"
          />
          <ErrorNotice message={error} />
          <div className="minimal-surface-actions">
            <button type="button" className="minimal-back" disabled={followUpPending || busy} onClick={() => setEditingTrack(true)}>
              Change track
            </button>
            <button
              type="button"
              className="minimal-back"
              disabled={busy || (followUpPending && pendingFollowUpKind !== 'skip')}
              onClick={() => void run(async () => {
                const slot = `follow-up:${activeFollowUp.id}`
                if (!operations.hasPending(slot)) setPendingFollowUpKind('skip')
                await operations.run(slot, (clientOperationId) => () => respondToFollowUp({
                  eventSlug,
                  questionId: activeFollowUp.id,
                  skipped: true,
                  expectedDraftVersion: draft.version,
                  clientOperationId,
                }))
                setPendingFollowUpKind(null)
              })}
            >
              {followUpPending && pendingFollowUpKind === 'skip' ? 'Confirm earlier skip' : 'Skip'}
            </button>
            <span className="character-count">{answer.length} / {draft.intakePolicy.followUpAnswerMaxLength}</span>
            <button type="submit" className="minimal-continue" disabled={busy || (followUpPending && pendingFollowUpKind !== 'answer') || (!followUpPending && answer.trim().length < draft.intakePolicy.followUpAnswerMinLength)}>
              {busy ? 'Saving…' : followUpPending ? 'Confirm earlier answer' : 'Continue'} <span aria-hidden="true">→</span>
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
          <p className="minimal-step-hint">Your current team, idea, and selected track will appear here.</p>
        </IntakeFrame>
      )
    }
    const confirmationKey = [
      preview.participantPolicyVersionId,
      preview.teamVersion,
      preview.draftVersion,
      preview.track?.id ?? 'no-core-track',
      ...preview.sponsorTracks.map((track) => track.id),
    ].join(':')
    const confirmedLock = confirmedSnapshotKey === confirmationKey
    const canSubmit = preview.blockers.length === 0 && confirmedLock && team.currentRole === 'lead'
    return (
      <IntakeFrame label="Final check" wide>
        <h1>Everything look right?</h1>
        <p className="minimal-step-hint">Submitting locks your current team and core track, so take one last look.</p>
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
                <span className="field-label">Team</span>
                <ul className="plain-list">
                  <li>
                    <span>{preview.memberCount} members</span>
                    <small>See the team panel for the paginated roster.</small>
                  </li>
                </ul>
              </div>
              <div className="review-block">
                <span className="field-label">Core track</span>
                <h2>{preview.track?.name ?? 'Not chosen'}</h2>
                <button type="button" className="text-button" disabled={reviewOperationPending || busy} onClick={() => setEditingTrack(true)}>
                  Change track
                </button>
              </div>
            </div>
            {sponsorTracks.length > 0 ? (
              <div className="sponsor-review-block">
                <span className="field-label">Optional sponsor tracks</span>
                <p>Select only the tracks whose published requirement your team meets.</p>
                <div className="sponsor-choice-list">
                  {sponsorTracks.map((track) => {
                    const selected = draft.chosenSponsorTrackVersionIds.includes(track.id)
                    return (
                      <label className="sponsor-choice" key={track.id}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={busy || reviewOperationPending}
                          onChange={(event) => {
                            const nextIds = event.target.checked
                              ? [...draft.chosenSponsorTrackVersionIds, track.id]
                              : draft.chosenSponsorTrackVersionIds.filter((id) => id !== track.id)
                            void run(async () => {
                              if (!operations.hasPending('sponsor-tracks')) setPendingSponsorIds(nextIds)
                              await operations.run('sponsor-tracks', (clientOperationId) => () => setSponsorTracks({
                                eventSlug,
                                sponsorTrackVersionIds: nextIds,
                                expectedDraftVersion: draft.version,
                                clientOperationId,
                              }))
                              setPendingSponsorIds(null)
                            })
                          }}
                        />
                        <span>
                          <strong>{track.displayName}</strong>
                          <small>{track.eligibilityText}</small>
                        </span>
                      </label>
                    )
                  })}
                </div>
                {sponsorPending && pendingSponsorIds ? (
                  <button
                    className="secondary"
                    type="button"
                    disabled={busy || revisionPending || freshnessPending || submitPending}
                    onClick={() => void run(async () => {
                      await operations.run('sponsor-tracks', () => () => {
                        throw new Error('There is no earlier sponsor-track change to confirm.')
                      })
                      setPendingSponsorIds(null)
                    })}
                  >Confirm earlier sponsor-track change</button>
                ) : null}
              </div>
            ) : null}
            <div className="review-block project-review-block">
              <span className="field-label">Your idea</span>
              <p className="preserve-lines">{preview.initialIdea}</p>
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
                              expectedDraftVersion: preview.draftVersion,
                              clientOperationId,
                            }))
                          setPendingRevisionId(null)
                          setPendingRevisionKind(null)
                          setEditingFollowUpId(null)
                        })
                      }}
                    >
                      <TextArea
                        autoFocus
                        required
                        minLength={draft.intakePolicy.followUpAnswerMinLength}
                        maxLength={draft.intakePolicy.followUpAnswerMaxLength}
                        rows={4}
                        disabled={revisionPending || busy}
                        value={editedFollowUpAnswer}
                        onChange={(event) => setEditedFollowUpAnswer(event.target.value)}
                      />
                      <div className="button-row">
                        <button className="secondary" disabled={busy || reviewOperationPending} type="button" onClick={() => setEditingFollowUpId(null)}>Cancel</button>
                        <button className="secondary" disabled={busy || (revisionPending && pendingRevisionKind !== 'skip') || sponsorPending || freshnessPending || submitPending} type="button" onClick={() => void run(async () => {
                          const slot = `follow-up-revision:${followUp.id}`
                          if (!operations.hasPending(slot)) {
                            setPendingRevisionId(followUp.id)
                            setPendingRevisionKind('skip')
                          }
                          await operations.run(slot, (clientOperationId) => () => reviseFollowUp({
                              eventSlug,
                              questionId: followUp.id,
                              skipped: true,
                              expectedDraftVersion: preview.draftVersion,
                              clientOperationId,
                            }))
                          setPendingRevisionId(null)
                          setPendingRevisionKind(null)
                          setEditingFollowUpId(null)
                        })}>{revisionPending && pendingRevisionKind === 'skip' ? 'Confirm earlier skip' : 'Skip answer'}</button>
                        <button className="primary" disabled={busy || sponsorPending || freshnessPending || submitPending || (revisionPending && pendingRevisionKind !== 'answer') || (!revisionPending && editedFollowUpAnswer.trim().length < draft.intakePolicy.followUpAnswerMinLength)} type="submit">
                          {revisionPending && pendingRevisionKind === 'answer' ? 'Confirm earlier answer' : 'Save'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <p className="preserve-lines muted">{followUp.skipped ? 'Skipped' : followUp.answer}</p>
                      <button
                        className="text-button"
                        type="button"
                        disabled={reviewOperationPending || busy}
                        onClick={() => {
                          setEditingFollowUpId(followUp.id)
                          setEditedFollowUpAnswer(followUp.answer ?? '')
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
                disabled={busy || reviewOperationPending}
                onChange={(event) => {
                  const accepted = event.target.checked
                  void run(async () => {
                    if (!operations.hasPending('freshness')) setPendingFreshnessAccepted(accepted)
                    await operations.run('freshness', (clientOperationId) => () => setFreshness({
                      eventSlug,
                      accepted,
                      expectedDraftVersion: preview.draftVersion,
                      clientOperationId,
                    }))
                    setPendingFreshnessAccepted(null)
                  })
                }}
              />
              <span>We will begin project-specific implementation and design after the official start.</span>
            </label>
            {freshnessPending && pendingFreshnessAccepted !== null ? (
              <button
                className="secondary"
                type="button"
                disabled={busy || revisionPending || sponsorPending || submitPending}
                onClick={() => void run(async () => {
                  await operations.run('freshness', () => () => {
                    throw new Error('There is no earlier freshness confirmation to retry.')
                  })
                  setPendingFreshnessAccepted(null)
                })}
              >Confirm earlier policy answer</button>
            ) : null}
            <label className="check-row lock-confirmation strong-warning">
              <input
                type="checkbox"
                checked={confirmedLock}
                disabled={busy || reviewOperationPending}
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
            <ErrorNotice message={error} />
            <div className="minimal-surface-actions">
              <button type="button" className="minimal-back" disabled={busy || reviewOperationPending} onClick={() => setEditingIdea(true)}>Edit idea</button>
              <button
                type="button"
                className="minimal-continue"
                disabled={busy || revisionPending || sponsorPending || freshnessPending || (!submitPending && !canSubmit)}
                onClick={() => {
                  const selectedTrack = preview.track
                  if (!selectedTrack) return
                  void run(() => operations.run('final-submit', (clientOperationId) => async () => {
                    const result = await submitApplication({
                      eventSlug,
                      expectedDraftVersion: preview.draftVersion,
                      expectedTeamVersion: preview.teamVersion,
                      expectedTrackVersionId: selectedTrack.id,
                      expectedSponsorTrackVersionIds: preview.sponsorTracks.map((track) => track.id),
                      participantPolicyVersionId: preview.participantPolicyVersionId,
                      clientOperationId,
                    })
                    if (result.state === 'failed') {
                      throw new Error(result.failureMessage ?? 'The submitted roster could not be validated.')
                    }
                    return result
                  }))
                }}
              >
                {busy ? 'Starting validation…' : submitPending ? 'Confirm earlier submission' : 'Confirm and submit'} <span aria-hidden="true">→</span>
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
  if (currentLength < minimumLength) {
    return (
      <p className="novelty-placeholder">
        Novelty appears after {minimumLength} characters.
      </p>
    )
  }
  if (state.status === 'idle' || state.status === 'checking') {
    return (
      <p className="novelty-placeholder" aria-live="polite">
        Comparing with curated past projects…
      </p>
    )
  }
  if (state.status === 'unavailable') {
    return (
      <p className="novelty-placeholder" aria-live="polite">
        The comparison is briefly unavailable. You can keep going.
      </p>
    )
  }

  const { signal } = state
  const bandCopy = signal.band === 'distinct'
    ? 'This direction looks different from the current comparison set.'
    : signal.band === 'developing'
      ? 'Some parts are familiar. A specific difference can make the direction clearer.'
      : 'Similar projects appear in the comparison set. Use the question below to show what your version changes.'
  return (
    <section className="novelty-counter" aria-live="polite" aria-label="Live novelty signal">
      <div className="novelty-heading">
        <span>Novelty</span>
        <strong>{signal.score}</strong>
      </div>
      <div className="novelty-meter" aria-hidden="true">
        <span style={{ width: `${signal.score}%` }} />
      </div>
      <p>{bandCopy}</p>
      <p><strong>Closest theme:</strong> {signal.nearestThemeLabel}</p>
      <p>{signal.reflectionPrompt}</p>
      <small>
        Compared with {signal.comparedProjectCount} projects in {signal.corpusLabel}. This is
        directional only and is never used for admission or judging.
      </small>
    </section>
  )
}
