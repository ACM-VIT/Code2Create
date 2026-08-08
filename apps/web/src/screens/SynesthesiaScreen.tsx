import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'

import { ErrorNotice } from '../components/Form'
import { eventSlug } from '../lib/config'
import { operationId, readableError } from '../lib/errors'

type SynesthesiaState = FunctionReturnType<typeof api.synesthesiaParticipant.state>
type SongRequest = SynesthesiaState['requests'][number]
type CatalogTrack = FunctionReturnType<
  typeof api.synesthesiaParticipant.searchCatalog
>[number]

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

  if (state === undefined) {
    return <p className="muted" role="status">Loading music…</p>
  }

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
    const window = state.window
    if (!window) return
    const result = await requestTrack({
      eventSlug,
      windowId: window.id,
      trackId: track.id,
      ...(note.trim() ? { note } : {}),
      clientOperationId: operationId('song-request'),
    })
    setStatus(result.created ? `${track.title} was requested.` : `${track.title} is already in the queue.`)
    setNote('')
  })

  const changeVote = (request: SongRequest) => run(`vote:${request.id}`, async () => {
    const mutation = request.hasVoted ? removeVote : addVote
    await mutation({
      eventSlug,
      requestId: request.id,
      clientOperationId: operationId(request.hasVoted ? 'song-unvote' : 'song-vote'),
    })
  })

  const submitReport = (request: SongRequest) => run(`report:${request.id}`, async () => {
    await reportRequest({
      eventSlug,
      requestId: request.id,
      reason: reportReason,
      clientOperationId: operationId('song-report'),
    })
    setReportingId(null)
    setReportReason('')
    setStatus('The request was reported to the event team.')
  })

  const nowPlaying = state.requests.find((request) => request.state === 'playing')

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
            <div className="music-usage" aria-label="Your music activity">
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
                        disabled={busy !== null || state.usage.requests >= state.window.maxRequestsPerParticipant}
                        onClick={() => void submitRequest(track)}
                      >
                        {busy === `request:${track.id}` ? 'Requesting…' : 'Request'}
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
            {state.requests.length === 0 ? (
              <p className="muted">No requests yet.</p>
            ) : (
              <div className="music-request-list">
                {state.requests.map((request) => (
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
                          disabled={busy !== null || (!request.hasVoted && state.usage.votes >= state.window.maxVotesPerParticipant)}
                          onClick={() => void changeVote(request)}
                        >
                          {request.hasVoted ? 'Remove vote' : 'Vote'}
                        </button>
                      ) : null}
                      {request.canReport && !request.hasReported ? (
                        <button type="button" className="text-button" disabled={busy !== null} onClick={() => setReportingId(request.id)}>
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
                          <textarea value={reportReason} minLength={5} maxLength={300} required onChange={(event) => setReportReason(event.target.value)} />
                        </label>
                        <div className="form-actions">
                          <button type="button" className="text-button" disabled={busy !== null} onClick={() => { setReportingId(null); setReportReason('') }}>Cancel</button>
                          <button type="submit" className="secondary compact" disabled={busy !== null || reportReason.trim().length < 5}>
                            {busy === `report:${request.id}` ? 'Sending…' : 'Send report'}
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
      <ErrorNotice message={error} />
    </section>
  )
}
