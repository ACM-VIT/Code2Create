import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'
import { useEffect, useState } from 'react'

import { loadReviewerDevice } from '@/lib/reviewer-device'
import { loadScannerDevice } from '@/lib/scanner-device'

/**
 * One live line per duty, for the home grid.
 *
 * A tile that says "Open" is a menu item; a tile that says "3 of 7 scored" is
 * the job. These read the same grant-filtered queries the duty panels use, so
 * nothing is shown that the person could not already open, and Convex dedupes
 * the subscription when they do open it.
 */
export type DutyStatus = { status: string; active: boolean }

/** Both device-scoped queries need the installation id the phone stores locally. */
function useInstallationIds(eventSlug: string) {
  const [ids, setIds] = useState<{ reviewer?: string; scanner?: string }>({})
  useEffect(() => {
    let cancelled = false
    const read = async () => {
      const [reviewer, scanner] = await Promise.all([
        loadReviewerDevice(eventSlug),
        loadScannerDevice(eventSlug),
      ])
      if (cancelled) return
      setIds({
        ...(reviewer ? { reviewer: reviewer.installationId } : {}),
        ...(scanner ? { scanner: scanner.installationId } : {}),
      })
    }
    void read()
    return () => {
      cancelled = true
    }
  }, [eventSlug])
  return ids
}

export function useJudgingStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const { reviewer } = useInstallationIds(eventSlug)
  const now = useQuery(
    api.reviewer.now,
    enabled && reviewer ? { eventSlug, installationId: reviewer } : 'skip',
  )
  const page = useQuery(
    api.reviewSubstitutions.currentPage,
    enabled ? { eventSlug } : 'skip',
  )

  if (page) return { status: 'You are needed at a table', active: true }
  if (now === undefined) return { status: '—', active: false }
  if (!now.device) return { status: 'Set this phone up first', active: false }
  if (!now.panel) return { status: 'No panel yet', active: false }
  if (now.panel.clockIn?.status !== 'present') return { status: 'Not clocked in', active: false }
  if (!now.review) return { status: 'Waiting for a team', active: false }
  const review = now.review
  if (review.assignment && !review.assignment.reviewerPresenceConfirmed) {
    return { status: 'Scan the team to start', active: true }
  }
  const scored = review.scorecard.ratings.length
  const total = review.criteria.length
  return {
    status: total > 0 ? `${scored} of ${total} scored` : 'Review under way',
    active: true,
  }
}

export function useDoorStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const { scanner } = useInstallationIds(eventSlug)
  const current = useQuery(
    api.attendanceScanner.current,
    enabled && scanner ? { eventSlug, installationId: scanner } : 'skip',
  )
  if (!enabled) return { status: '', active: false }
  if (current === undefined) return { status: '—', active: false }
  if (current === null) return { status: 'Pick a station', active: false }
  const pending = current.device.pendingReplayCount
  if (pending > 0) {
    return { status: `${pending} scan${pending === 1 ? '' : 's'} waiting to send`, active: true }
  }
  return { status: current.station.name, active: true }
}

export function useHallStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const available = useQuery(api.floorMapping.available, enabled ? { eventSlug } : 'skip')
  if (!enabled) return { status: '', active: false }
  if (available === undefined) return { status: '—', active: false }
  if (available === null) return { status: 'No hall plan yet', active: false }
  if (available.plan.mappingState === 'frozen') return { status: 'Map is frozen', active: false }
  const spots = available.zones.flatMap((zone) => zone.spots)
  const free = spots.filter((spot) => spot.occupiedBy === null).length
  return {
    status: free === 0 ? 'Every spot is filled' : `${free} spot${free === 1 ? '' : 's'} still empty`,
    active: free > 0,
  }
}

export function useHelpStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const cases = useQuery(api.support.mine, enabled ? { eventSlug } : 'skip')
  if (!enabled) return { status: '', active: false }
  if (cases === undefined) return { status: '—', active: false }
  const open = cases.filter((row) => row.state !== 'resolved' && row.state !== 'closed').length
  return {
    status: open === 0 ? 'Nothing open' : `${open} open`,
    active: false,
  }
}
