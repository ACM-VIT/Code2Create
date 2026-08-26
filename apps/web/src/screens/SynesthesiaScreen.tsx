import { api } from '@code2create/backend/api'
import { mergeSynesthesiaVoteCounts } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'

import { ErrorNotice } from '../components/Form'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'

type SynesthesiaState = FunctionReturnType<typeof api.synesthesiaParticipant.state>
type SongRequest = SynesthesiaState['requests'][number] & { voteCount: number }
type CatalogTrack = FunctionReturnType<
  typeof api.synesthesiaParticipant.searchCatalog
>[number]
type RequestTrackResult = FunctionReturnType<typeof api.synesthesiaParticipant.requestTrack>
type PendingRequest = { trackId: CatalogTrack['id']; title: string }
type PendingVote = { requestId: SongRequest['id']; adding: boolean }

function durationLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function requestStateLabel(state: SongRequest['state']) {
  if (state === 'pending') return 'Waiting for review'
  if (state === 'approved') return 'Approved'
  if (state === 'queued') return 'In the queue'
  if (state === 'playing') return 'Playing now'
  if (state === 'played') return 'Played'
  if (state === 'skipped') return 'Skipped'
  if (state === 'rejected') return 'Not added'
  return 'Hidden'
}

export function SynesthesiaScreen() {
  const state = useQuery(api.synesthesiaParticipant.state, { eventSlug })
  const voteCounts = useQuery(api.synesthesiaParticipant.voteCounts, { eventSlug })
  const [search, setSearch] = useState('')
  const catalog = useQuery(
    api.synesthesiaParticipant.searchCatalog,
    state?.eligible && !state.suspended && state.window?.requestsOpen
      ? { eventSlug, query: search }
      : 'skip',
  )
  const requestTrack = useMutation(api.synesthesiaParticipant.requestTrack)
  const addVote = useMutation(api.synesthesiaParticipant.vote)
  const removeVote = useMutation(api.synesthesiaParticipant.removeVote)
  const reportRequest = useMutation(api.synesthesiaParticipant.reportRequest)
  const [note, setNote] = useState('')
  const [reportingId, setReportingId] = useState<SongRequest['id'] | null>(null)
  const [reportReason, setReportReason] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null)
  const [pendingVote, setPendingVote] = useState<PendingVote | null>(null)
  const [pendingReportId, setPendingReportId] = useState<SongRequest['id'] | null>(null)
  const operations = useOperationRunner()
  const requestOperation = useOperationRunner<RequestTrackResult>()
  const requestPending = requestOperation.hasPending('song-request')
  const votePending = pendingVote !== null && operations.hasPending(`song-vote:${pendingVote.requestId}`)
  const reportPending = pendingReportId !== null && operations.hasPending(`song-report:${pendingReportId}`)
  const operationPending = requestPending || votePending || reportPending

  if (state === undefined || voteCounts === undefined) {
    return <p className="muted" role="status">Loading music…</p>
  }

  const voteCountsMatch = state.window === null
    ? voteCounts === null
    : voteCounts?.windowId === state.window.id
  if (!voteCountsMatch) {
    return <p className="muted" role="status">Updating the live music window…</p>
  }
  const requests: SongRequest[] = mergeSynesthesiaVoteCounts(
    state.requests,
    voteCounts?.counts ?? [],
  )

  const run = async (key: string, operation: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    setStatus(null)
    try {
      await operation()
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const submitRequest = (track: CatalogTrack) => run(`request:${track.id}`, async () => {
    if (requestPending && pendingRequest?.trackId !== track.id) return
    const window = state.window
    if (!requestPending && !window) return
    if (!requestPending) setPendingRequest({ trackId: track.id, title: track.title })
    const result = await requestOperation.run('song-request', (clientOperationId) => () => requestTrack({
        eventSlug,
        windowId: window?.id ?? (() => { throw new Error('The music window is no longer available.') })(),
        trackId: track.id,
        ...(note.trim() ? { note } : {}),
        clientOperationId,
      }))
    const title = pendingRequest?.title ?? track.title
    setStatus(result.created ? `${title} was requested.` : `${title} is already in the queue.`)
    setPendingRequest(null)
    setNote('')
  })

  const changeVote = (request: SongRequest) => run(`vote:${request.id}`, async () => {
    const slot = `song-vote:${request.id}`
    if (votePending && pendingVote?.requestId !== request.id) return
    if (!operations.hasPending(slot)) {
      setPendingVote({ requestId: request.id, adding: !request.hasVoted })
    }
    await operations.run(slot, (clientOperationId) => {
      const mutation = request.hasVoted ? removeVote : addVote
      return () => mutation({ eventSlug, requestId: request.id, clientOperationId })
    })
    setPendingVote(null)
  })

  const submitReport = (request: SongRequest) => run(`report:${request.id}`, async () => {
    const slot = `song-report:${request.id}`
    if (reportPending && pendingReportId !== request.id) return
    if (!operations.hasPending(slot)) setPendingReportId(request.id)
    await operations.run(slot, (clientOperationId) => () => reportRequest({ eventSlug, requestId: request.id, reason: reportReason, clientOperationId }))
    setPendingReportId(null)
    setReportingId(null)
    setReportReason('')
    setStatus('The request was reported to the event team.')
  })

  const retryMissingRequest = () => run('request-recovery', async () => {
    const result = await requestOperation.retryPending('song-request')
    const title = pendingRequest?.title ?? 'The track'
    setStatus(result.created ? `${title} was requested.` : `${title} is already in the queue.`)
    setPendingRequest(null)
    setNote('')
  })

  const retryMissingVote = () => {
    if (!pendingVote) return Promise.resolve()
    const pending = pendingVote
    return run('vote-recovery', async () => {
      await operations.retryPending(`song-vote:${pending.requestId}`)
      setPendingVote(null)
    })
  }

  const retryMissingReport = () => {
    if (!pendingReportId) return Promise.resolve()
    const requestId = pendingReportId
    return run('report-recovery', async () => {
      await operations.retryPending(`song-report:${requestId}`)
      setPendingReportId(null)
      setReportingId(null)
      setReportReason('')
      setStatus('The request was reported to the event team.')
    })
  }

  const nowPlaying = requests.find((request) => request.state === 'playing')

  return (
    <section className="synesthesia-shell">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Shared room music</p>
          <h1>Music</h1>
          <p className="lead">Request from the event catalog and vote on what fits the room.</p>
        </div>
      </div>

      {!state.eligible ? (
        <p className="notice">Music requests open for accepted teams during published event sessions.</p>
      ) : state.window === null ? (
        <p className="notice">No music window is open right now. This page will update when one begins.</p>
      ) : (
        <>
          <section className="music-window" aria-labelledby="music-window-title">
            <div>
              <p className="eyebrow">Live window</p>
              <h2 id="music-window-title">{state.window.name}</h2>
              <p>
                Until {new Date(state.window.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {' · '}{state.window.catalogSourceLabel}
              </p>
            </div>
            <div className="music-usage" role="group" aria-label="Your music activity">
              <span>{state.usage.requests}/{state.window.maxRequestsPerParticipant} requests</span>
              <span>{state.usage.votes}/{state.window.maxVotesPerParticipant} votes</span>
            </div>
          </section>

          {state.suspended ? (
            <p className="notice notice-error">Your music actions are paused. You can still follow the live queue.</p>
          ) : null}
          {state.window.playbackPaused ? (
            <p className="notice">Playback is paused by the event team.</p>
          ) : null}

          <section className="now-playing" aria-live="polite">
            <span>Now playing</span>
            {nowPlaying ? (
              <strong>{nowPlaying.title} · {nowPlaying.artist}</strong>
            ) : (
              <strong>Nothing at the moment</strong>
            )}
          </section>

          {state.window.requestsOpen && !state.suspended ? (
            <section className="music-catalog" aria-labelledby="music-catalog-title">
              <div className="subheading-row">
                <div>
                  <h2 id="music-catalog-title">Request a track</h2>
                  <p className="muted">Tracks are played by an event operator in the licensed source shown above.</p>
                </div>
              </div>
              <div className="music-search-fields">
                <label className="field">
                  <span className="field-label">Search the catalog</span>
                  <input
                    type="search"
                    disabled={operationPending || busy !== null}
                    value={search}
                    maxLength={80}
                    placeholder="Title or artist"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Note, if useful</span>
                  <input
                    value={note}
                    disabled={operationPending || busy !== null}
                    maxLength={160}
                    placeholder="Why it fits this session"
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
              </div>
              {catalog === undefined ? (
                <p className="muted" role="status">Searching…</p>
              ) : catalog.length === 0 ? (
                <p className="muted">No allowed tracks match this search.</p>
              ) : (
                <div className="music-track-list">
                  {catalog.map((track) => (
                    <div className="music-track" key={track.id}>
                      <div>
                        <strong>{track.title}</strong>
                        <span>{track.artist} · {durationLabel(track.durationSeconds)} · {track.energyTag}</span>
                      </div>
                      <button
                        type="button"
                        className="secondary compact"
                        disabled={
                          busy !== null ||
                          votePending ||
                          reportPending ||
                          (requestPending && pendingRequest?.trackId !== track.id) ||
                          (!requestPending && state.usage.requests >= state.window.maxRequestsPerParticipant)
                        }
                        onClick={() => void submitRequest(track)}
                      >
                        {busy === `request:${track.id}`
                          ? 'Requesting…'
                          : requestPending && pendingRequest?.trackId === track.id
                            ? 'Confirm earlier request'
                            : 'Request'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          <section className="music-queue" aria-labelledby="music-queue-title">
            <div className="subheading-row">
              <div>
                <h2 id="music-queue-title">Live queue</h2>
                <p className="muted">Votes guide the operator; they do not guarantee playback.</p>
              </div>
            </div>
            {requests.length === 0 ? (
              <p className="muted">No requests yet.</p>
            ) : (
              <div className="music-request-list">
                {requests.map((request) => (
                  <article className={request.state === 'playing' ? 'music-request playing' : 'music-request'} key={request.id}>
                    <div className="music-request-main">
                      <div>
                        <strong>{request.title}</strong>
                        <span>{request.artist} · {durationLabel(request.durationSeconds)}</span>
                      </div>
                      <small>{requestStateLabel(request.state)} · {request.voteCount} votes{request.isMine ? ' · Your request' : ''}</small>
                      {request.publicReason ? <p>{request.publicReason}</p> : null}
                    </div>
                    <div className="music-request-actions">
                      {request.canVote ? (
                        <button
                          type="button"
                          className="text-button"
                          disabled={
                            busy !== null ||
                            requestPending ||
                            reportPending ||
                            (votePending && pendingVote?.requestId !== request.id) ||
                            (!votePending && !request.hasVoted && state.usage.votes >= state.window.maxVotesPerParticipant)
                          }
                          onClick={() => void changeVote(request)}
                        >
                          {votePending && pendingVote?.requestId === request.id
                            ? pendingVote.adding ? 'Confirm earlier vote' : 'Confirm earlier vote removal'
                            : request.hasVoted ? 'Remove vote' : 'Vote'}
                        </button>
                      ) : null}
                      {request.canReport && !request.hasReported ? (
                        <button type="button" className="text-button" disabled={busy !== null || operationPending} onClick={() => setReportingId(request.id)}>
                          Report
                        </button>
                      ) : null}
                      {request.hasReported ? <span>Reported</span> : null}
                    </div>
                    {reportingId === request.id ? (
                      <form
                        className="music-report-form"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void submitReport(request)
                        }}
                      >
                        <label className="field">
                          <span className="field-label">What should the event team know?</span>
                          <textarea disabled={busy !== null || operationPending} value={reportReason} minLength={5} maxLength={300} required onChange={(event) => setReportReason(event.target.value)} />
                        </label>
                        <div className="form-actions">
                          <button type="button" className="text-button" disabled={busy !== null || operationPending} onClick={() => { setReportingId(null); setReportReason('') }}>Cancel</button>
                          <button
                            type="submit"
                            className="secondary compact"
                            disabled={busy !== null || requestPending || votePending || (!reportPending && reportReason.trim().length < 5)}
                          >
                            {busy === `report:${request.id}`
                              ? 'Sending…'
                              : reportPending && pendingReportId === request.id
                                ? 'Confirm earlier report'
                                : 'Send report'}
                          </button>
                        </div>
                      </form>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {status ? <p className="inline-status" role="status">{status}</p> : null}
      {requestPending && pendingRequest && (
        state.window === null ||
        !state.window.requestsOpen ||
        (catalog !== undefined && !catalog.some((track) => track.id === pendingRequest.trackId))
      ) ? (
        <button className="secondary" type="button" disabled={busy !== null} onClick={() => void retryMissingRequest()}>
          {busy === 'request-recovery' ? 'Confirming…' : `Confirm earlier request for ${pendingRequest.title}`}
        </button>
      ) : null}
      {votePending && pendingVote && !requests.some(
        (request) => request.id === pendingVote.requestId && request.canVote,
      ) ? (
        <button className="secondary" type="button" disabled={busy !== null} onClick={() => void retryMissingVote()}>
          {busy === 'vote-recovery' ? 'Confirming…' : 'Confirm earlier vote change'}
        </button>
      ) : null}
      {reportPending && pendingReportId && !requests.some((request) => request.id === pendingReportId) ? (
        <button className="secondary" type="button" disabled={busy !== null} onClick={() => void retryMissingReport()}>
          {busy === 'report-recovery' ? 'Confirming…' : 'Confirm earlier report'}
        </button>
      ) : null}
      <ErrorNotice message={error} />
    </section>
  )
}
