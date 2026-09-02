import { api } from '@code2create/backend/api'
import { useAction, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useRef, useState } from 'react'
import { eventSlug } from '../lib/config'

export type NoveltyBand = 'familiar' | 'developing' | 'distinct'

export type NoveltySignal = {
  score: number
  band: NoveltyBand | null
}

export type NoveltyState =
  | { status: 'idle' }
  | { status: 'checking'; previous: NoveltySignal | null }
  | { status: 'ready'; signal: NoveltySignal }
  | { status: 'unavailable' }

type PendingPreview = Extract<
  FunctionReturnType<typeof api.novelty.preview>,
  { state: 'pending' }
> & { key: string; recovery: 0 | 1 }

function normalizeIdea(value: string) {
  return value.trim().replace(/\s+/g, ' ')
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
  const [recovery, setRecovery] = useState<{ key: string; attempt: 1 } | null>(null)
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
  const recoveryAttempt = recovery?.key === requestKey ? recovery.attempt : 0
  const pendingStatus = useQuery(
    api.novelty.previewStatus,
    pending !== null && pending.key === requestKey
      ? { eventSlug, requestId: pending.requestId }
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
      return
    }

    if (!active) {
      setState({ status: 'idle' })
      setPending(null)
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
      return
    }

    setState({ status: 'checking', previous: lastSignal.current })
    setPending(null)
    const priorIdentity = requestIdentity.current
    const clientRequestId = priorIdentity?.key === requestKey
      ? priorIdentity.id
      : crypto.randomUUID()
    requestIdentity.current = { key: requestKey, id: clientRequestId }
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
            setPending({ ...result, key: requestKey, recovery: recoveryAttempt })
            return
          }
          if (result.state === 'unavailable') {
            setState({ status: 'unavailable' })
            return
          }
          const signal = { score: result.score, band: result.band }
          lastSignal.current = signal
          setState({ status: 'ready', signal })
        })
        .catch(() => {
          if (sequence.current === current) setState({ status: 'unavailable' })
        })
    }
    const timer = window.setTimeout(check, recoveryAttempt === 0 ? debounceMs : 0)
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
      return
    }
    if (pendingStatus.state === 'unavailable') {
      setState({ status: 'unavailable' })
      setPending(null)
    }
  }, [pending, pendingStatus, requestKey])

  useEffect(() => {
    if (
      pending === null ||
      pending.key !== requestKey ||
      (pendingStatus !== undefined && pendingStatus.state !== 'pending')
    ) return
    const waitMs = Math.max(0, pending.retryAt - Date.now() + 250)
    const timer = window.setTimeout(() => {
      if (pending.recovery === 1) {
        setState({ status: 'unavailable' })
        setPending(null)
        return
      }
      requestIdentity.current = { key: requestKey, id: crypto.randomUUID() }
      setPending(null)
      setRecovery({ key: requestKey, attempt: 1 })
    }, waitMs)
    return () => window.clearTimeout(timer)
  }, [pending, pendingStatus, requestKey])

  return state
}
