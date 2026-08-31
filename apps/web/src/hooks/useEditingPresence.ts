import { api } from '@code2create/backend/api'
import { useMutation, useQuery } from 'convex/react'
import type { FunctionArgs } from 'convex/server'
import { useCallback, useEffect, useRef } from 'react'

import { eventSlug } from '../lib/config'

export type EditingSurface = 'idea' | 'follow_up' | 'proposal_revision'
type EditingQuestionId = NonNullable<
  FunctionArgs<typeof api.intakePresence.heartbeat>['questionId']
>

const heartbeatMs = 4_000
const idleMs = 7_000

type ActiveSession = {
  generation: number
  sessionId: string
  sessionToken: string | null
  surface: EditingSurface
  questionId?: EditingQuestionId
}

export function useEditingPresence(enabled = true) {
  const editors = useQuery(api.intakePresence.list, { eventSlug })
  const heartbeatMutation = useMutation(api.intakePresence.heartbeat)
  const disconnectMutation = useMutation(api.intakePresence.disconnect)
  const heartbeatTimer = useRef<number | null>(null)
  const idleTimer = useRef<number | null>(null)
  const generation = useRef(0)
  const activeSession = useRef<ActiveSession | null>(null)

  const clearTimers = useCallback(() => {
    if (heartbeatTimer.current !== null) window.clearInterval(heartbeatTimer.current)
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
    heartbeatTimer.current = null
    idleTimer.current = null
  }, [])

  const disconnect = useCallback((session: ActiveSession | null) => {
    if (session?.sessionToken) {
      void disconnectMutation({ sessionToken: session.sessionToken }).catch(() => undefined)
    }
  }, [disconnectMutation])

  const stopEditing = useCallback(() => {
    generation.current += 1
    const prior = activeSession.current
    activeSession.current = null
    clearTimers()
    disconnect(prior)
  }, [clearTimers, disconnect])

  const sendHeartbeat = useCallback((session: ActiveSession) => {
    void heartbeatMutation({
      eventSlug,
      surface: session.surface,
      ...(session.questionId !== undefined ? { questionId: session.questionId } : {}),
      sessionId: session.sessionId,
    }).then((result) => {
      const current = activeSession.current
      if (
        current?.generation === session.generation &&
        current.sessionId === session.sessionId
      ) {
        current.sessionToken = result.sessionToken
        return
      }
      void disconnectMutation({ sessionToken: result.sessionToken }).catch(() => undefined)
    }).catch(() => undefined)
  }, [disconnectMutation, heartbeatMutation])

  const markEditing = useCallback((
    surface: EditingSurface,
    questionId?: EditingQuestionId,
  ) => {
    if (!enabled) return
    let session = activeSession.current
    if (
      !session ||
      session.surface !== surface ||
      session.questionId !== questionId
    ) {
      stopEditing()
      session = {
        generation: generation.current,
        sessionId: crypto.randomUUID(),
        sessionToken: null,
        surface,
        ...(questionId !== undefined ? { questionId } : {}),
      }
      activeSession.current = session
      sendHeartbeat(session)
      heartbeatTimer.current = window.setInterval(() => {
        const current = activeSession.current
        if (current) sendHeartbeat(current)
      }, heartbeatMs)
    }
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(stopEditing, idleMs)
  }, [enabled, sendHeartbeat, stopEditing])

  useEffect(() => {
    if (!enabled) stopEditing()
    return stopEditing
  }, [enabled, stopEditing])

  return { editors, markEditing, stopEditing }
}
