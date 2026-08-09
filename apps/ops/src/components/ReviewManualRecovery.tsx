import { api } from '@code2create/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { compressPaperImage } from '../lib/paperImage'

type Workspace = FunctionReturnType<typeof api.manualReviewRecords.workspace>
type Review = Workspace['reviews'][number]
type ManualRecord = Review['records'][number]
type Scorecard = Review['scorecards'][number]
type CriterionId = Review['rubric']['criteria'][number]['id']
type RoundId = FunctionArgs<typeof api.manualReviewRecords.workspace>['roundId']
type IncidentData = FunctionReturnType<typeof api.incidents.forService>
type Incident = IncidentData['incidents'][number]
type IncidentSeverity = FunctionArgs<typeof api.incidents.create>['severity']
type VerificationKind = 'import' | 'reject'

type DraftRating = {
  criterionId: CriterionId
  score: string
  evidenceNote: string
}

type DraftScorecard = {
  scorecardId: Scorecard['id']
  expectedScorecardVersion: number
  reviewerName: string
  signed: boolean
  ratings: DraftRating[]
  privateNote: string
}

export function ReviewManualRecovery({ roundId }: { roundId: RoundId }) {
  const incidents = useQuery(api.incidents.forService, {
    eventSlug,
    affectedService: 'review_backend',
  })
  const workspace = useQuery(api.manualReviewRecords.workspace, { eventSlug, roundId })

  if (incidents === undefined || workspace === undefined) {
    return <p className="muted manual-recovery-loading">Loading paper review recovery…</p>
  }
  if (!incidents.canCreate && incidents.incidents.length === 0 && workspace.reviews.length === 0) {
    return null
  }

  return (
    <section className="manual-recovery">
      <div className="section-heading">
        <div>
          <h2>Paper review recovery</h2>
          <p className="muted">
            Only for a review that was already running when service failed. One person copies the signed sheet; another checks the photo and imports it.
          </p>
        </div>
      </div>

      <ReviewIncidentArea data={incidents} />

      {workspace.reviews.some((review) => review.canEnter && isLiveReview(review.status)) ? (
        <DraftReviewForm incidents={incidents.incidents} reviews={workspace.reviews} />
      ) : null}

      <div className="manual-sheet-list">
        {workspace.reviews.flatMap((review) =>
          review.records.map((record) => (
            <ManualReviewCard key={`${record.id}-${record.version}`} record={record} review={review} />
          )),
        )}
        {workspace.reviews.every((review) => review.records.length === 0) ? (
          <p className="empty">No paper review records in your scope.</p>
        ) : null}
      </div>
    </section>
  )
}

function ReviewIncidentArea({ data }: { data: IncidentData }) {
  const createIncident = useMutation(api.incidents.create)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [severity, setSeverity] = useState<IncidentSeverity>('service_disruption')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const invalidate = () => {
    operationRef.current = null
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await createIncident({
        eventSlug,
        title,
        summary,
        severity,
        affectedService: 'review_backend',
        clientOperationId,
      })
      operationRef.current = null
      setTitle('')
      setSummary('')
      setSeverity('service_disruption')
      setOpen(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="manual-incidents">
      <div className="manual-subheading">
        <div>
          <strong>Review incidents</strong>
          <span>Two different authorised people must approve paper mode.</span>
        </div>
        {data.canCreate ? (
          <button className="secondary" type="button" onClick={() => setOpen((value) => !value)}>
            {open ? 'Close form' : 'Open incident'}
          </button>
        ) : null}
      </div>

      {open ? (
        <form className="manual-compact-form" onSubmit={submit}>
          <label className="field manual-wide">
            <span>Title</span>
            <input required minLength={3} value={title} onChange={(event) => { invalidate(); setTitle(event.target.value) }} />
          </label>
          <label className="field manual-wide">
            <span>What failed</span>
            <textarea required minLength={10} value={summary} onChange={(event) => { invalidate(); setSummary(event.target.value) }} />
          </label>
          <label className="field">
            <span>Severity</span>
            <select value={severity} onChange={(event) => { invalidate(); setSeverity(parseSeverity(event.target.value)) }}>
              <option value="service_disruption">Service disruption</option>
              <option value="major">Major</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <button className="primary" disabled={busy} type="submit">{busy ? 'Opening…' : 'Open incident'}</button>
          {error ? <p className="notice error manual-wide" role="alert">{error}</p> : null}
        </form>
      ) : null}

      {data.incidents.map((incident) => <ReviewIncident key={`${incident.id}-${incident.version}`} incident={incident} />)}
      {data.incidents.length === 0 ? <p className="empty">No visible review-backend incident.</p> : null}
    </div>
  )
}

function ReviewIncident({ incident }: { incident: Incident }) {
  return (
    <article className="manual-incident">
      <div className="manual-incident-summary">
        <div>
          <strong>{incident.title}</strong>
          <span>{incident.summary}</span>
        </div>
        <small>{incidentState(incident)}</small>
      </div>
      <p className="manual-approvals">
        {incident.approvals.length === 0
          ? 'No approvals yet.'
          : incident.approvals.map((approval) => approval.displayName).join(' · ')}
      </p>
      {incident.canApproveManualMode ? <ApproveIncident incident={incident} /> : null}
      {incident.canResolve ? <ResolveIncident incident={incident} /> : null}
    </article>
  )
}

function ApproveIncident({ incident }: { incident: Incident }) {
  const approve = useMutation(api.incidents.approveManualMode)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await approve({
        eventSlug,
        incidentId: incident.id,
        expectedIncidentVersion: incident.version,
        reason,
        clientOperationId,
      })
      operationRef.current = null
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="manual-inline-form" onSubmit={submit}>
      <label className="field">
        <span>Approval reason</span>
        <input required minLength={5} value={reason} onChange={(event) => { operationRef.current = null; setReason(event.target.value) }} />
      </label>
      <button className="secondary" disabled={busy} type="submit">{busy ? 'Approving…' : 'Approve paper mode'}</button>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </form>
  )
}

function ResolveIncident({ incident }: { incident: Incident }) {
  const resolve = useMutation(api.incidents.resolve)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await resolve({
        eventSlug,
        incidentId: incident.id,
        expectedIncidentVersion: incident.version,
        reason,
        clientOperationId,
      })
      operationRef.current = null
      setOpen(false)
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return <button className="text-button" type="button" onClick={() => setOpen(true)}>Resolve incident</button>
  return (
    <form className="manual-inline-form" onSubmit={submit}>
      <label className="field">
        <span>Resolution</span>
        <input required minLength={5} value={reason} onChange={(event) => { operationRef.current = null; setReason(event.target.value) }} />
      </label>
      <button className="secondary" disabled={busy} type="submit">{busy ? 'Resolving…' : 'Confirm resolution'}</button>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </form>
  )
}

function DraftReviewForm({ incidents, reviews }: { incidents: Incident[]; reviews: Review[] }) {
  const createDraft = useMutation(api.manualReviewRecords.createDraft)
  const eligibleReviews = reviews.filter((review) => review.canEnter && isLiveReview(review.status))
  const approvedIncidents = incidents.filter(
    (incident) => incident.state !== 'resolved' && incident.manualModeState === 'approved',
  )
  const [open, setOpen] = useState(false)
  const [reviewId, setReviewId] = useState('')
  const [incidentId, setIncidentId] = useState('')
  const [serial, setSerial] = useState('')
  const [startedAt, setStartedAt] = useState('')
  const [endedAt, setEndedAt] = useState(localDateTime(Date.now()))
  const [unavailableReason, setUnavailableReason] = useState('')
  const [sharedFindings, setSharedFindings] = useState('')
  const [sharedCommitments, setSharedCommitments] = useState('')
  const [entries, setEntries] = useState<DraftScorecard[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)
  const review = eligibleReviews.find((candidate) => candidate.id === reviewId)

  const invalidate = () => {
    operationRef.current = null
    setError(null)
  }

  const chooseReview = (value: string) => {
    invalidate()
    const next = eligibleReviews.find((candidate) => candidate.id === value)
    setReviewId(next?.id ?? '')
    setStartedAt(next?.startedAt ? localDateTime(next.startedAt) : '')
    setEndedAt(localDateTime(Date.now()))
    setEntries(next ? createDraftScorecards(next) : [])
  }

  const updateEntry = (scorecardId: Scorecard['id'], update: (entry: DraftScorecard) => DraftScorecard) => {
    invalidate()
    setEntries((current) => current.map((entry) => entry.scorecardId === scorecardId ? update(entry) : entry))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const incident = approvedIncidents.find((candidate) => candidate.id === incidentId)
    if (!review || !incident) {
      setError('Choose the active review and approved incident.')
      return
    }
    const start = parseLocalTime(startedAt)
    const end = parseLocalTime(endedAt)
    if (start === null || end === null) {
      setError('Enter valid start and end times from the sheet.')
      return
    }
    const reviewerEntries: FunctionArgs<typeof api.manualReviewRecords.createDraft>['reviewerEntries'] = []
    for (const entry of entries) {
      const ratings: FunctionArgs<typeof api.manualReviewRecords.createDraft>['reviewerEntries'][number]['ratings'] = []
      for (const rating of entry.ratings) {
        const score = Number(rating.score)
        if (!Number.isInteger(score)) {
          setError(`Choose every score for ${entry.reviewerName}.`)
          return
        }
        ratings.push({
          criterionId: rating.criterionId,
          score,
          ...(rating.evidenceNote.trim() ? { evidenceNote: rating.evidenceNote } : {}),
        })
      }
      reviewerEntries.push({
        scorecardId: entry.scorecardId,
        expectedScorecardVersion: entry.expectedScorecardVersion,
        signatureConfirmed: entry.signed,
        ratings,
        ...(entry.privateNote.trim() ? { privateNote: entry.privateNote } : {}),
      })
    }
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await createDraft({
        eventSlug,
        incidentId: incident.id,
        reviewSessionId: review.id,
        expectedIncidentVersion: incident.version,
        expectedRoundVersion: review.roundVersion,
        expectedReviewVersion: review.version,
        serial,
        startedAt: start,
        endedAt: end,
        unavailableReason,
        reviewerEntries,
        ...(sharedFindings.trim() ? { sharedFindings } : {}),
        ...(sharedCommitments.trim() ? { sharedCommitments } : {}),
        clientOperationId,
      })
      operationRef.current = null
      setOpen(false)
      setReviewId('')
      setIncidentId('')
      setSerial('')
      setUnavailableReason('')
      setSharedFindings('')
      setSharedCommitments('')
      setEntries([])
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="manual-new-sheet">
        <div>
          <strong>Enter signed review</strong>
          <span>Copy the complete sheet exactly. Upload its photo next.</span>
        </div>
        <button className="primary" disabled={approvedIncidents.length === 0} type="button" onClick={() => setOpen(true)}>
          Enter paper review
        </button>
      </div>
    )
  }

  return (
    <form className="manual-sheet-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field">
          <span>Active review</span>
          <select required value={reviewId} onChange={(event) => chooseReview(event.target.value)}>
            <option value="">Choose review</option>
            {eligibleReviews.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.teamName} · {candidate.panelName}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Approved incident</span>
          <select required value={incidentId} onChange={(event) => { invalidate(); setIncidentId(event.target.value) }}>
            <option value="">Choose incident</option>
            {approvedIncidents.map((incident) => <option key={incident.id} value={incident.id}>{incident.title}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Printed serial</span>
          <input required minLength={3} value={serial} onChange={(event) => { invalidate(); setSerial(event.target.value) }} />
        </label>
        <label className="field">
          <span>Why service was unavailable</span>
          <input required minLength={5} value={unavailableReason} onChange={(event) => { invalidate(); setUnavailableReason(event.target.value) }} />
        </label>
        <label className="field">
          <span>Started</span>
          <input required type="datetime-local" value={startedAt} onChange={(event) => { invalidate(); setStartedAt(event.target.value) }} />
        </label>
        <label className="field">
          <span>Ended</span>
          <input required type="datetime-local" value={endedAt} onChange={(event) => { invalidate(); setEndedAt(event.target.value) }} />
        </label>
      </div>

      {review ? (
        <div className="manual-review-scorecards">
          <p className="muted">
            {review.tableLabel ? `${review.rubric.name} · ${review.tableLabel}` : review.rubric.name}
          </p>
          {entries.map((entry) => (
            <fieldset className="manual-review-scorecard" key={entry.scorecardId}>
              <legend>{entry.reviewerName}</legend>
              <label className="manual-check">
                <input
                  checked={entry.signed}
                  type="checkbox"
                  onChange={(event) => updateEntry(entry.scorecardId, (current) => ({ ...current, signed: event.target.checked }))}
                />
                This reviewer signed the numbered sheet.
              </label>
              <div className="manual-review-ratings">
                {entry.ratings.map((rating) => {
                  const criterion = review.rubric.criteria.find((candidate) => candidate.id === rating.criterionId)
                  return (
                    <div className="manual-review-rating" key={rating.criterionId}>
                      <label className="field">
                        <span>{criterion?.label ?? 'Criterion'}</span>
                        <select
                          required
                          value={rating.score}
                          onChange={(event) => updateEntry(entry.scorecardId, (current) => ({
                            ...current,
                            ratings: current.ratings.map((candidate) => candidate.criterionId === rating.criterionId
                              ? { ...candidate, score: event.target.value }
                              : candidate),
                          }))}
                        >
                          <option value="">Score</option>
                          {scoreOptions(review.rubric.scoreMinimum, review.rubric.scoreMaximum).map((score) => (
                            <option key={score} value={score}>{score}</option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>Evidence note</span>
                        <input
                          value={rating.evidenceNote}
                          onChange={(event) => updateEntry(entry.scorecardId, (current) => ({
                            ...current,
                            ratings: current.ratings.map((candidate) => candidate.criterionId === rating.criterionId
                              ? { ...candidate, evidenceNote: event.target.value }
                              : candidate),
                          }))}
                        />
                      </label>
                    </div>
                  )
                })}
              </div>
              <label className="field">
                <span>Private reviewer note, if written</span>
                <textarea value={entry.privateNote} onChange={(event) => updateEntry(entry.scorecardId, (current) => ({ ...current, privateNote: event.target.value }))} />
              </label>
            </fieldset>
          ))}
        </div>
      ) : null}

      <label className="field">
        <span>Shared findings</span>
        <textarea required={review?.requiresSharedCommitments} value={sharedFindings} onChange={(event) => { invalidate(); setSharedFindings(event.target.value) }} />
      </label>
      <label className="field">
        <span>Next-checkpoint commitments</span>
        <textarea required={review?.requiresSharedCommitments} value={sharedCommitments} onChange={(event) => { invalidate(); setSharedCommitments(event.target.value) }} />
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy || !review} type="submit">{busy ? 'Saving…' : 'Save copied review'}</button>
        <button className="secondary" disabled={busy} type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <p className="muted">This freezes the current digital drafts until the paper record is verified or rejected.</p>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </form>
  )
}

function ManualReviewCard({ record, review }: { record: ManualRecord; review: Review }) {
  return (
    <article className="manual-sheet-card">
      <div className="manual-sheet-title">
        <div>
          <strong>{review.teamName} · {record.serial}/{record.revision}</strong>
          <span>{review.panelName} · entered by {record.enteredByName}</span>
        </div>
        <small>{recordStatus(record.status)}</small>
      </div>
      <div className="manual-sheet-meta">
        <span>{formatTime(record.startedAt)} start</span>
        <span>{formatTime(record.endedAt)} end</span>
        <span>{record.reviewerEntries.length} signed scorecards</span>
        <span>{record.sourceByteCount ? `${Math.ceil(record.sourceByteCount / 1_000)} KB source` : 'Source pending'}</span>
      </div>
      <p className="manual-sheet-owner">{record.unavailableReason}</p>
      <details>
        <summary>Copied ratings and notes</summary>
        <div className="manual-review-record-values">
          {record.reviewerEntries.map((entry) => (
            <div key={entry.scorecardId}>
              <strong>{entry.reviewerName}</strong>
              {entry.ratings.map((rating) => {
                const criterion = review.rubric.criteria.find((candidate) => candidate.id === rating.criterionId)
                return <p key={rating.criterionId}>{criterion?.label ?? 'Criterion'}: {rating.score}{rating.evidenceNote ? ` · ${rating.evidenceNote}` : ''}</p>
              })}
            </div>
          ))}
          {record.sharedFindings ? <p><strong>Findings:</strong> {record.sharedFindings}</p> : null}
          {record.sharedCommitments ? <p><strong>Commitments:</strong> {record.sharedCommitments}</p> : null}
        </div>
      </details>
      {record.canUploadSource ? <ReviewSourceUpload record={record} /> : null}
      {record.canReadSource ? <ReviewSource record={record} /> : null}
      {record.canVerify ? <ReviewVerification record={record} review={review} /> : null}
      {record.status === 'draft' && record.canUploadSource ? <ReviewDraftCancellation record={record} /> : null}
      {record.rejectionReason ? <p className="notice error">Rejected: {record.rejectionReason}</p> : null}
      {record.cancellationReason ? <p className="muted">Cancelled: {record.cancellationReason}</p> : null}
      {record.verifiedByName && record.verifiedAt ? <p className="manual-import-summary">Verified by {record.verifiedByName} · {formatTime(record.verifiedAt)}</p> : null}
    </article>
  )
}

function ReviewSourceUpload({ record }: { record: ManualRecord }) {
  const upload = useAction(api.manualReviewRecordActions.uploadSource)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!file) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      const compressed = await compressPaperImage(file, 'review-sheet')
      await upload({
        eventSlug,
        recordId: record.id,
        expectedRecordVersion: record.version,
        bytes: compressed.bytes,
        fileName: compressed.fileName,
        clientOperationId,
      })
      operationRef.current = null
      setFile(null)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="manual-source-upload" onSubmit={submit}>
      <label className="field">
        <span>Photo of the complete signed sheet</span>
        <input accept="image/*" required type="file" onChange={(event) => { operationRef.current = null; setFile(event.target.files?.[0] ?? null) }} />
      </label>
      <button className="primary" disabled={busy || !file} type="submit">{busy ? 'Preparing…' : 'Submit for verification'}</button>
      <p className="muted">The browser converts the photo to one private JPEG under 900 KB.</p>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </form>
  )
}

function ReviewSource({ record }: { record: ManualRecord }) {
  const readSource = useAction(api.manualReviewRecordActions.readSource)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl)
  }, [sourceUrl])

  const open = async () => {
    setBusy(true)
    setError(null)
    try {
      const source = await readSource({ eventSlug, recordId: record.id })
      const nextUrl = URL.createObjectURL(new Blob([source.bytes], { type: source.contentType }))
      setSourceUrl((current) => {
        if (current) URL.revokeObjectURL(current)
        return nextUrl
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="manual-source-preview">
      <button className="text-button" disabled={busy} type="button" onClick={() => void open()}>{busy ? 'Opening…' : sourceUrl ? 'Reload protected source' : 'Open protected source'}</button>
      {sourceUrl ? <img alt={`Paper review ${record.serial}`} src={sourceUrl} /> : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </div>
  )
}

function ReviewVerification({ record, review }: { record: ManualRecord; review: Review }) {
  const verify = useMutation(api.manualReviewRecords.verify)
  const [kind, setKind] = useState<VerificationKind>('import')
  const [reason, setReason] = useState('')
  const [originalFiled, setOriginalFiled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const invalidate = () => {
    operationRef.current = null
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await verify({
        eventSlug,
        recordId: record.id,
        expectedRecordVersion: record.version,
        decision: kind === 'import'
          ? {
              kind: 'import',
              originalFiled,
              expectedRoundVersion: review.roundVersion,
              expectedReviewVersion: review.version,
            }
          : { kind: 'reject' },
        reason,
        clientOperationId,
      })
      operationRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="manual-verification" onSubmit={submit}>
      <label className="field">
        <span>Decision</span>
        <select value={kind} onChange={(event) => { invalidate(); setKind(event.target.value === 'reject' ? 'reject' : 'import') }}>
          <option value="import">Verify and import</option>
          <option value="reject">Reject record</option>
        </select>
      </label>
      <label className="field">
        <span>What you checked</span>
        <input required minLength={5} value={reason} onChange={(event) => { invalidate(); setReason(event.target.value) }} />
      </label>
      <button className={kind === 'reject' ? 'secondary' : 'primary'} disabled={busy || (kind === 'import' && !originalFiled)} type="submit">
        {busy ? 'Applying…' : kind === 'reject' ? 'Reject record' : 'Import signed review'}
      </button>
      {kind === 'import' ? (
        <label className="manual-check">
          <input checked={originalFiled} type="checkbox" onChange={(event) => { invalidate(); setOriginalFiled(event.target.checked) }} />
          The numbered original is in the event audit packet.
        </label>
      ) : null}
      <p className="muted">Import restores the named reviewers' signed scorecards and completes the existing review together.</p>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </form>
  )
}

function ReviewDraftCancellation({ record }: { record: ManualRecord }) {
  const cancel = useMutation(api.manualReviewRecords.cancelDraft)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await cancel({
        eventSlug,
        recordId: record.id,
        expectedRecordVersion: record.version,
        reason,
        clientOperationId,
      })
      operationRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return <button className="text-button" type="button" onClick={() => setOpen(true)}>Cancel draft</button>
  return (
    <form className="manual-inline-form" onSubmit={submit}>
      <label className="field">
        <span>Cancellation reason</span>
        <input required minLength={5} value={reason} onChange={(event) => { operationRef.current = null; setReason(event.target.value) }} />
      </label>
      <button className="secondary" disabled={busy} type="submit">{busy ? 'Cancelling…' : 'Confirm cancel'}</button>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </form>
  )
}

function createDraftScorecards(review: Review): DraftScorecard[] {
  return review.scorecards.map((scorecard) => ({
    scorecardId: scorecard.id,
    expectedScorecardVersion: scorecard.version,
    reviewerName: scorecard.reviewerName,
    signed: false,
    ratings: scorecard.assignedCriterionIds.map((criterionId) => ({
      criterionId,
      score: '',
      evidenceNote: '',
    })),
    privateNote: '',
  }))
}

function scoreOptions(minimum: number, maximum: number) {
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || maximum < minimum) return []
  return Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index)
}

function parseSeverity(value: string): IncidentSeverity {
  if (value === 'major' || value === 'critical') return value
  return 'service_disruption'
}

function parseLocalTime(value: string) {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

function localDateTime(timestamp: number) {
  const date = new Date(timestamp)
  const local = new Date(timestamp - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function isLiveReview(status: string) {
  return status === 'active' || status === 'overdue'
}

function incidentState(incident: Incident) {
  if (incident.state === 'resolved') return 'Resolved'
  if (incident.manualModeState === 'approved') return 'Paper mode approved'
  if (incident.manualModeState === 'pending') return `Approval ${incident.manualModeApprovalCount} of 2`
  return 'Paper mode not approved'
}

function recordStatus(status: ManualRecord['status']) {
  if (status === 'submitted') return 'Awaiting verifier'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}
