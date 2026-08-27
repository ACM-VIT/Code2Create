import { api } from '@code2create/backend/api'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState } from 'react'
import { AppState } from 'react-native'

import { useReviewerInstallationId } from '@/lib/duty-status'
import { judgingStatus } from '@/lib/judging-status'

export function useReviewerDuty(eventSlug: string, reviewEnabled: boolean) {
  const heartbeat = useMutation(api.reviewer.heartbeat)
  const page = useQuery(
    api.reviewSubstitutions.currentPage,
    reviewEnabled ? { eventSlug } : 'skip',
  )
  const installationId = useReviewerInstallationId(eventSlug)
  const duty = useQuery(
    api.reviewer.dutyStatus,
    reviewEnabled && installationId ? { eventSlug, installationId } : 'skip',
  )
  const [heartbeatIssue, setHeartbeatIssue] = useState<string | null>(null)
  const roundId = duty?.heartbeat?.roundId
  const heartbeatStatus = duty?.heartbeat?.status

  useEffect(() => {
    if (!installationId || !roundId || !heartbeatStatus) return
    let active = true
    let sending = false

    const send = async () => {
      if (AppState.currentState !== 'active' || sending) return
      sending = true
      try {
        await heartbeat({ eventSlug, roundId, installationId })
        if (active) setHeartbeatIssue(null)
      } catch {
        if (active) {
          setHeartbeatIssue(
            'Live panel updates are interrupted. Reconnect before taking an action.',
          )
        }
      } finally {
        sending = false
      }
    }

    void send()
    const timer = setInterval(() => void send(), 45_000)
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void send()
    })

    return () => {
      active = false
      clearInterval(timer)
      appStateSubscription.remove()
    }
  }, [eventSlug, heartbeat, heartbeatStatus, installationId, roundId])

  return {
    heartbeatIssue: roundId ? heartbeatIssue : null,
    installationId,
    judgingStatus: judgingStatus(duty, page !== undefined && page !== null, reviewEnabled),
    page,
  }
}
