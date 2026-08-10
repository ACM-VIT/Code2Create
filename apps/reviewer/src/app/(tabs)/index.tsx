import { useRouter } from 'expo-router'
import { useSyncExternalStore } from 'react'

import { DutyHome, type DutyHeadline, type DutyTile } from '@/components/DutyHome'
import {
  localStoreWasReset,
  subscribeToLocalStoreReset,
} from '@/lib/encrypted-local-database'
import { DutyIcon, type DutyIconName } from '@/components/DutyIcon'
import { useReviewerSession, type Surface } from '@/components/ReviewerSession'
import {
  type DutyStatus,
  useDoorStatus,
  useHallStatus,
  useHelpStatus,
  useIncidentStatus,
  useJudgingStatus,
  usePulseStatus,
} from '@/lib/duty-status'
import { duty, type DutyKey } from '@/theme'

export default function DutiesScreen() {
  const router = useRouter()
  const { eventSlug, surfaces, who } = useReviewerSession()
  const storeReset = useSyncExternalStore(subscribeToLocalStoreReset, localStoreWasReset)

  const statuses: Record<Surface, DutyStatus> = {
    reviews: useJudgingStatus(eventSlug, surfaces.includes('reviews')),
    attendance: useDoorStatus(eventSlug, surfaces.includes('attendance')),
    floor: useHallStatus(eventSlug, surfaces.includes('floor')),
    support: useHelpStatus(eventSlug, surfaces.includes('support')),
    operations: usePulseStatus(eventSlug, surfaces.includes('operations')),
    incidents: useIncidentStatus(eventSlug, surfaces.includes('incidents')),
  }

  return (
    <DutyHome
      headline={homeHeadline(statuses, surfaces, who)}
      {...(storeReset
        ? {
            notice:
              'This phone could not read its saved work, so it started fresh. Anything scanned but not yet sent is gone.',
          }
        : {})}
      tiles={surfaces.map((surface) =>
        // Every duty that is genuinely running fills solid; that is the whole
        // point of the grid. One filled tile is a rule, not a status.
        dutyTile(surface, statuses[surface], () => router.push(`/duty/${surface}`)),
      )}
    />
  )
}

export const dutyMeta: Record<Surface, { key: DutyKey; label: string; icon: DutyIconName }> = {
  reviews: { key: 'judging', label: 'Judging', icon: 'judging' },
  attendance: { key: 'door', label: 'Door', icon: 'door' },
  floor: { key: 'hall', label: 'Hall map', icon: 'hall' },
  support: { key: 'help', label: 'Help', icon: 'help' },
  operations: { key: 'pulse', label: 'Pulse', icon: 'pulse' },
  incidents: { key: 'incident', label: 'Incidents', icon: 'incident' },
}

function dutyTile(surface: Surface, state: DutyStatus, onPress: () => void): DutyTile {
  const meta = dutyMeta[surface]
  const filled = state.active
  return {
    key: meta.key,
    label: meta.label,
    status: state.status,
    active: filled,
    resting: !state.active,
    icon: (
      <DutyIcon
        color={filled ? duty[meta.key].ink : duty[meta.key].accent}
        name={meta.icon}
        size={35}
      />
    ),
    onPress,
  }
}

/**
 * The headline follows whichever duty is live, so the number on the screen is
 * the one that is actually moving. With nothing live it counts the duties held.
 *
 * Several duties may run at once and every one of them fills its own tile; this
 * order only decides which of them gets the big number. A live incident
 * outranks everything, because it means part of the event is broken. Judging
 * outranks the door because a panel is waiting on a person, not on a queue,
 * and the attention ledger sits behind both: its rows name work anyone with
 * the grant could pick up, not work this person is already mid-way through.
 */
const dutyPriority: Surface[] = [
  'incidents',
  'reviews',
  'attendance',
  'operations',
  'floor',
  'support',
]

function homeHeadline(
  statuses: Record<Surface, DutyStatus>,
  surfaces: Surface[],
  who: string,
): DutyHeadline {
  const live = dutyPriority.find(
    (surface) => surfaces.includes(surface) && statuses[surface].active,
  )
  const headline = live ? statuses[live].headline : undefined
  if (live && headline) {
    // The ghost is one or two digits — a third is unreadable once it is clipped
    // by the screen edge, which it always is.
    const digits = headline.value.replace(/[^0-9]/gu, '').slice(0, 2)
    const progress = statuses[live].progress
    return {
      primary: headline.value,
      ...(headline.unit === undefined ? {} : { secondary: headline.unit }),
      context: who,
      summary: statuses[live].status,
      accent: duty[dutyMeta[live].key].accent,
      ...(progress === undefined ? {} : { progress }),
      ...(digits === '' ? {} : { ghost: digits }),
    }
  }
  if (live) {
    return {
      primary: dutyMeta[live].label,
      context: who,
      summary: statuses[live].status,
      accent: duty[dutyMeta[live].key].accent,
    }
  }
  const lead = surfaces[0] ?? 'support'
  return {
    primary: String(surfaces.length),
    secondary: surfaces.length === 1 ? 'duty' : 'duties',
    context: who,
    summary: 'Nothing needs you right now',
    accent: duty[dutyMeta[lead].key].accent,
    ghost: String(surfaces.length),
  }
}
