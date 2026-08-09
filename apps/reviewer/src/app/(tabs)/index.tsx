import { useRouter } from 'expo-router'

import { DutyHome, type DutyHeadline, type DutyTile } from '@/components/DutyHome'
import { DutyIcon, type DutyIconName } from '@/components/DutyIcon'
import { useReviewerSession, type Surface } from '@/components/ReviewerSession'
import {
  type DutyStatus,
  useDoorStatus,
  useHallStatus,
  useHelpStatus,
  useJudgingStatus,
} from '@/lib/duty-status'
import { duty, type DutyKey } from '@/theme'

export default function DutiesScreen() {
  const router = useRouter()
  const { eventSlug, surfaces, who } = useReviewerSession()

  const statuses: Record<Surface, DutyStatus> = {
    reviews: useJudgingStatus(eventSlug, surfaces.includes('reviews')),
    attendance: useDoorStatus(eventSlug, surfaces.includes('attendance')),
    floor: useHallStatus(eventSlug, surfaces.includes('floor')),
    support: useHelpStatus(eventSlug, surfaces.includes('support')),
  }

  return (
    <DutyHome
      headline={homeHeadline(statuses, surfaces, who)}
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
 * order only decides which of them gets the big number. Judging outranks the
 * door because a panel is waiting on a person, not on a queue.
 */
const dutyPriority: Surface[] = ['reviews', 'attendance', 'floor', 'support']

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
