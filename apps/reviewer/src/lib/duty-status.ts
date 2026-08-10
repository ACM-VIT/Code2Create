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
export type DutyStatus = {
  /** The tile's own line. A fact about this duty. */
  status: string
  /** True when this duty is mid-flight and wants the person's hands. */
  active: boolean
  /**
   * A short number for the screen headline, if this duty has one worth
   * enlarging. Kept separate from `status` because a headline has to be a
   * numeral — a station name set at 34px just truncates.
   */
  headline?: { value: string; unit?: string }
  /**
   * 0–1, for the bar under the headline. Only set where the duty has a real
   * denominator — an invented one would be a decorative bar, which is worse
   * than none.
   */
  progress?: number
}

/** The id this phone registered as a reviewer device, once it has one. */
export function useReviewerInstallationId(eventSlug: string) {
  return useInstallationIds(eventSlug).reviewer
}

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

  if (page) return { status: 'Needed at a table', active: true }
  if (now === undefined) return { status: '—', active: false }
  // Tile lines stay at two or three words. A sentence wraps to two lines at
  // 17px and eats the air that makes a card readable across a hall.
  if (!now.device) return { status: 'Set up phone', active: false }
  if (!now.panel) return { status: 'No panel yet', active: false }
  if (now.panel.clockIn?.status !== 'present') return { status: 'Not clocked in', active: false }
  if (!now.review) return { status: 'Waiting', active: false }
  const review = now.review
  if (review.assignment && !review.assignment.reviewerPresenceConfirmed) {
    return { status: 'Scan to start', active: true }
  }
  const scored = review.scorecard.ratings.length
  const total = review.criteria.length
  if (total === 0) return { status: 'Review under way', active: true }
  return {
    status: `${scored} of ${total} scored`,
    active: true,
    headline: { value: `${scored}/${total}`, unit: 'scored' },
    progress: scored / total,
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
  const sent = current.device.lastSequence
  const pending = current.device.pendingReplayCount
  if (pending > 0) {
    return {
      status: `${pending} to send`,
      active: true,
      headline: { value: String(pending), unit: 'to send' },
      // How much of this phone's work has actually reached the server.
      progress: sent / (sent + pending),
    }
  }
  return {
    status: current.station.name,
    active: true,
    headline: { value: String(sent), unit: sent === 1 ? 'scan sent' : 'scans sent' },
    // A full bar on a phone that has sent nothing is a lie. There is no
    // backlog to draw until there is something to compare against.
    ...(sent === 0 ? {} : { progress: 1 }),
  }
}

export function useHallStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const available = useQuery(api.floorMapping.available, enabled ? { eventSlug } : 'skip')
  if (!enabled) return { status: '', active: false }
  if (available === undefined) return { status: '—', active: false }
  if (available === null) return { status: 'No hall plan yet', active: false }
  if (available.plan.mappingState === 'frozen') return { status: 'Map is frozen', active: false }
  // There are no numbered spots any more, so there is no denominator to be a
  // fraction of: what a mapper wants to know is how many teams are down.
  const placed = available.zones.reduce((total, zone) => total + zone.teams.length, 0)
  if (placed === 0) return { status: 'Nobody placed yet', active: false }
  return {
    status: `${placed} team${placed === 1 ? '' : 's'} placed`,
    // Mapping is a background chore, not something demanding hands right now.
    active: false,
    headline: { value: String(placed), unit: placed === 1 ? 'team placed' : 'teams placed' },
  }
}

export function usePulseStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const attention = useQuery(api.operationsAttention.overview, enabled ? { eventSlug } : 'skip')
  if (!enabled) return { status: '', active: false }
  if (attention === undefined) return { status: '—', active: false }
  // What matters on the grid is the unclaimed work: an acknowledged item has a
  // person already, so it stops asking for this one.
  const unclaimed = attention.summary.rowCount - attention.summary.acknowledgedCount
  if (unclaimed > 0) {
    return {
      status: `${unclaimed} need${unclaimed === 1 ? 's' : ''} someone`,
      active: true,
      headline: { value: String(unclaimed), unit: unclaimed === 1 ? 'needs someone' : 'need someone' },
    }
  }
  if (attention.summary.rowCount > 0) return { status: 'All picked up', active: false }
  return { status: 'All clear', active: false }
}

export function useIncidentStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const live = useQuery(api.incidents.active, enabled ? { eventSlug } : 'skip')
  if (!enabled) return { status: '', active: false }
  if (live === undefined) return { status: '—', active: false }
  if (live.length === 0) return { status: 'None live', active: false }
  // A pending paper-fallback approval is a queue of people standing still, so
  // it outranks the bare count on the tile.
  const waiting = live.filter((incident) => incident.manualModeState === 'pending').length
  if (waiting > 0) {
    return {
      status: 'Awaiting approval',
      active: true,
      headline: { value: String(live.length), unit: 'live' },
    }
  }
  return {
    status: `${live.length} live`,
    active: true,
    headline: { value: String(live.length), unit: 'live' },
  }
}

export function useHelpStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const cases = useQuery(api.support.mine, enabled ? { eventSlug } : 'skip')
  if (!enabled) return { status: '', active: false }
  if (cases === undefined) return { status: '—', active: false }
  const open = cases.filter((row) => row.state !== 'resolved' && row.state !== 'closed').length
  if (open === 0) return { status: 'Nothing open', active: false }
  // An unresolved case raised by or assigned to this person is real work, not a
  // menu item, so the tile fills like any other running duty.
  return {
    status: `${open} open`,
    active: true,
    headline: { value: String(open), unit: open === 1 ? 'case open' : 'cases open' },
  }
}
