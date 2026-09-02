import { api } from '@code2create/backend/api'
import { useAction } from 'convex/react'
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
  | { status: 'checking' }
  | { status: 'ready'; signal: NoveltySignal }
  | { status: 'unavailable' }

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
  const sequence = useRef(0)
  const corpusVersionId = config?.corpusVersionId ?? null
  const minimumIdeaLength = config?.minimumIdeaLength ?? null
  const debounceMs = config?.debounceMs ?? null
  const savedIdea = saved.idea
  const savedScore = saved.score
  const savedBand = saved.band

  useEffect(() => {
    sequence.current += 1
    const current = sequence.current
    const savedIdeaMatches =
      savedIdea !== undefined &&
      savedIdea.trim().replace(/\s+/g, ' ') === idea.trim().replace(/\s+/g, ' ')
    const hasSavedSignal = corpusVersionId !== null && savedScore !== null && savedIdeaMatches

    if (hasSavedSignal) {
      // oxlint-disable-next-line react/set-state-in-effect -- Seed the async novelty state machine from the authoritative saved signal.
      setState({ status: 'ready', signal: { score: savedScore, band: savedBand } })
    }

    if (!active) {
      if (!hasSavedSignal) setState({ status: 'idle' })
      return
    }

    if (
      corpusVersionId === null ||
      minimumIdeaLength === null ||
      debounceMs === null ||
      ideaLength < minimumIdeaLength
    ) {
      setState({ status: 'idle' })
      return
    }

    if (!hasSavedSignal) setState({ status: 'checking' })
    const check = () => {
      void previewNovelty({
        eventSlug,
        corpusVersionId,
        idea,
        clientRequestId: crypto.randomUUID(),
      })
        .then((result) => {
          if (sequence.current !== current) return
          if (result.state === 'unavailable') {
            if (!hasSavedSignal) setState({ status: 'unavailable' })
            return
          }
          setState({ status: 'ready', signal: { score: result.score, band: result.band } })
        })
        .catch(() => {
          if (sequence.current === current && !hasSavedSignal) setState({ status: 'unavailable' })
        })
    }
    const timer = window.setTimeout(check, hasSavedSignal ? 0 : debounceMs)
    return () => {
      window.clearTimeout(timer)
    }
  }, [
    active,
    corpusVersionId,
    debounceMs,
    idea,
    ideaLength,
    minimumIdeaLength,
    previewNovelty,
    savedBand,
    savedIdea,
    savedScore,
  ])

  return state
}
