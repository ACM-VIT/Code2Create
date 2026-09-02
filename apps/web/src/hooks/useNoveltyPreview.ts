import { api } from '@code2create/backend/api'
import { useAction, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useRef, useState } from 'react'
import { eventSlug } from '../lib/config'
import { noveltyRequestDelayMs, noveltyRetryDelayMs } from '../lib/noveltyPreview'

export type NoveltyBand = 'familiar' | 'developing' | 'distinct'

export type NoveltySignal = {
  score: number
  band: NoveltyBand | null
}

export type NoveltyState =
  | { status: 'idle' }
  | { status: 'checking'; previous: NoveltySignal | null }
  | { status: 'ready'; signal: NoveltySignal }

type PendingPreview = Extract<
  FunctionReturnType<typeof api.novelty.preview>,
  { state: 'pending' }
> & { key: string; attempt: number }

type Recovery = {
  key: string
  attempt: number
  retryAt: number
}

type TrackedRequest = {
  key: string
  clientRequestId: string
  attempt: number
}

function normalizeIdea(value: string) {
  // Match the backend's stored idea normalization exactly so the preview
  // fingerprint can be attached to the saved draft, including paragraphs.
  return value.trim().replace(/\r\n/g, '\n')
}

export function normalizedIdeaLength(value: string) {
  return value.trim().replace(/\s+/g, ' ').length
}

export type NoveltyConfig = Pick<
  NonNullable<FunctionReturnType<typeof api.intake.opening>['novelty']>,
  'corpusVersionId' | 'minimumIdeaLength' | 'debounceMs'
>
export function useNoveltyPreview({
  idea,
  ideaLength,
  active,
  config,
  saved,
}: {
  idea: string
  /** The idea's length as the policy measures it (whitespace collapsed). */
  ideaLength: number
  active: boolean
  config: NoveltyConfig | null
  saved: { idea: string | undefined; score: number | null; band: NoveltyBand | null }
}): NoveltyState {
  const previewNovelty = useAction(api.novelty.preview)
  const [state, setState] = useState<NoveltyState>({ status: 'idle' })
  const [pending, setPending] = useState<PendingPreview | null>(null)
  const [recovery, setRecovery] = useState<Recovery | null>(null)
  const [trackedRequest, setTrackedRequest] = useState<TrackedRequest | null>(null)
  const sequence = useRef(0)
  const lastSignal = useRef<NoveltySignal | null>(null)
  const requestIdentity = useRef<{ key: string; id: string } | null>(null)
  const corpusVersionId = config?.corpusVersionId ?? null
  const minimumIdeaLength = config?.minimumIdeaLength ?? null
  const debounceMs = config?.debounceMs ?? null
  const savedIdea = saved.idea
  const savedScore = saved.score
  const savedBand = saved.band
  const normalizedIdea = normalizeIdea(idea)
  const requestKey = corpusVersionId === null ? '' : `${corpusVersionId}:${normalizedIdea}`
  const matchingRecovery = recovery?.key === requestKey ? recovery : null
  const recoveryAttempt = matchingRecovery?.attempt ?? 0
  const recoveryRetryAt = matchingRecovery?.retryAt ?? null
  const pendingStatus = useQuery(
    api.novelty.previewStatus,
    pending !== null && pending.key === requestKey
      ? { eventSlug, requestId: pending.requestId }
      : 'skip',
  )
  const trackedStatus = useQuery(
    api.novelty.previewStatusByClientRequest,
    trackedRequest !== null && trackedRequest.key === requestKey
      ? { eventSlug, clientRequestId: trackedRequest.clientRequestId }
      : 'skip',
  )

  useEffect(() => {
    sequence.current += 1
    const current = sequence.current
    const savedIdeaMatches =
      savedIdea !== undefined &&
      normalizeIdea(savedIdea) === normalizedIdea
    const hasSavedSignal = corpusVersionId !== null && savedScore !== null && savedIdeaMatches

    if (hasSavedSignal) {
      const signal = { score: savedScore, band: savedBand }
      lastSignal.current = signal
      // oxlint-disable-next-line react/set-state-in-effect -- Seed the async novelty state machine from the authoritative saved signal.
      setState({ status: 'ready', signal })
      setPending(null)
      setTrackedRequest(null)
      return
    }

    if (!active) {
      setState({ status: 'idle' })
      setPending(null)
      setTrackedRequest(null)
      return
    }

    if (
      corpusVersionId === null ||
      minimumIdeaLength === null ||
      debounceMs === null ||
      ideaLength < minimumIdeaLength
    ) {
      setState({ status: 'idle' })
      setPending(null)
      setTrackedRequest(null)
      return
    }

    setState({ status: 'checking', previous: lastSignal.current })
    setPending(null)
    const priorIdentity = requestIdentity.current
    const clientRequestId = recoveryAttempt === 0 && priorIdentity?.key === requestKey
      ? priorIdentity.id
      : crypto.randomUUID()
    requestIdentity.current = { key: requestKey, id: clientRequestId }
    setTrackedRequest({ key: requestKey, clientRequestId, attempt: recoveryAttempt })
    const recover = () => {
      if (sequence.current !== current) return
      const attempt = recoveryAttempt + 1
      setState({ status: 'checking', previous: lastSignal.current })
      setPending(null)
      setTrackedRequest(null)
      setRecovery({
        key: requestKey,
        attempt,
        retryAt: Date.now() + noveltyRetryDelayMs(attempt),
      })
    }
    const check = () => {
      void previewNovelty({
        eventSlug,
        corpusVersionId,
        idea: normalizedIdea,
        clientRequestId,
      })
        .then((result) => {
          if (sequence.current !== current) return
          if (result.state === 'pending') {
            setPending({ ...result, key: requestKey, attempt: recoveryAttempt })
            return
          }
          if (result.state === 'unavailable') {
            recover()
            return
          }
          const signal = { score: result.score, band: result.band }
          lastSignal.current = signal
          setState({ status: 'ready', signal })
          setTrackedRequest(null)
        })
        .catch(() => {
          recover()
        })
    }
    const delayMs = noveltyRequestDelayMs({
      configuredDebounceMs: debounceMs,
      retryAt: recoveryRetryAt,
    })
    const timer = window.setTimeout(check, delayMs)
    return () => {
      window.clearTimeout(timer)
    }
  }, [
    active,
    corpusVersionId,
    debounceMs,
    ideaLength,
    minimumIdeaLength,
    normalizedIdea,
    previewNovelty,
    recoveryAttempt,
    recoveryRetryAt,
    requestKey,
    savedBand,
    savedIdea,
    savedScore,
  ])

  useEffect(() => {
    if (pending === null || pending.key !== requestKey || pendingStatus === undefined) return
    if (pendingStatus.state === 'ready') {
      const signal = { score: pendingStatus.score, band: pendingStatus.band }
      lastSignal.current = signal
      // oxlint-disable-next-line react/set-state-in-effect -- A reactive backend job has settled.
      setState({ status: 'ready', signal })
      setPending(null)
      setTrackedRequest(null)
      return
    }
    if (pendingStatus.state === 'unavailable') {
      const attempt = pending.attempt + 1
      setState({ status: 'checking', previous: lastSignal.current })
      setPending(null)
      setTrackedRequest(null)
      setRecovery({
        key: requestKey,
        attempt,
        retryAt: Date.now() + noveltyRetryDelayMs(attempt),
      })
    }
  }, [pending, pendingStatus, requestKey])

  useEffect(() => {
    if (
      trackedRequest === null ||
      trackedRequest.key !== requestKey ||
      trackedStatus === undefined ||
      trackedStatus.state === 'waiting' ||
      trackedStatus.state === 'pending'
    ) return
    if (trackedStatus.state === 'ready') {
      const signal = { score: trackedStatus.score, band: trackedStatus.band }
      lastSignal.current = signal
      // oxlint-disable-next-line react/set-state-in-effect -- The request result is delivered by the authoritative reactive query.
      setState({ status: 'ready', signal })
      setPending(null)
      setTrackedRequest(null)
      return
    }
    const attempt = trackedRequest.attempt + 1
    setState({ status: 'checking', previous: lastSignal.current })
    setPending(null)
    setTrackedRequest(null)
    setRecovery({
      key: requestKey,
      attempt,
      retryAt: Date.now() + noveltyRetryDelayMs(attempt),
    })
  }, [requestKey, trackedRequest, trackedStatus])

  useEffect(() => {
    if (
      pending === null ||
      pending.key !== requestKey ||
      (pendingStatus !== undefined && pendingStatus.state !== 'pending')
    ) return
    const waitMs = Math.max(0, pending.retryAt - Date.now() + 250)
    const timer = window.setTimeout(() => {
      const attempt = pending.attempt + 1
      setPending(null)
      setTrackedRequest(null)
      setRecovery({
        key: requestKey,
        attempt,
        retryAt: Date.now() + noveltyRetryDelayMs(attempt),
      })
    }, waitMs)
    return () => window.clearTimeout(timer)
  }, [pending, pendingStatus, requestKey])

  return state
}
