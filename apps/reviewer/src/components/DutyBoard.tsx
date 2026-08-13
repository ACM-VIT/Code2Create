import { useRouter } from 'expo-router'
import { useSyncExternalStore } from 'react'

import { DutyHome, type DutyHeadline, type DutyTile } from '@/components/DutyHome'
import { DutyIcon } from '@/components/DutyIcon'
import { useReviewerSession, type Surface } from '@/components/ReviewerSession'
import {
  localStoreWasReset,
  subscribeToLocalStoreReset,
} from '@/lib/encrypted-local-database'
import { dutyMeta, splitDuties } from '@/lib/duties'
import { dutySubscriptionPlan } from '@/lib/duty-subscriptions'
import {
  type DutyStatus,
  useDoorStatus,
  useHallStatus,
  useHelpStatus,
  useIncidentStatus,
  usePulseStatus,
} from '@/lib/duty-status'
import { duty } from '@/theme'

export function DutyBoard({ group }: { group: 'floor' | 'board' }) {
  const router = useRouter()
  const { eventSlug, judgingStatus, surfaces, who } = useReviewerSession()
  const storeReset = useSyncExternalStore(subscribeToLocalStoreReset, localStoreWasReset)
  const shown = splitDuties(surfaces)[group]
  const subscriptions = dutySubscriptionPlan(shown)

  const statuses: Record<Surface, DutyStatus> = {
    reviews: judgingStatus,
    attendance: useDoorStatus(eventSlug, subscriptions.attendance),
    floor: useHallStatus(eventSlug, subscriptions.floor),
    support: useHelpStatus(eventSlug, subscriptions.support),
    operations: usePulseStatus(eventSlug, subscriptions.operations),
    incidents: useIncidentStatus(eventSlug, subscriptions.incidents),
  }

  return (
    <DutyHome
      headline={groupHeadline(statuses, shown, who, group)}
      {...(storeReset
        ? {
            notice:
              'This phone could not read its saved work, so it started fresh. Unsent scans and unsaved score drafts are gone.',
          }
        : {})}
      tiles={shown.map((surface) =>
        dutyTile(surface, statuses[surface], () =>
          // Help lives on its own tab; the tile goes there instead of
          // pushing a second, header-squeezed copy of the same screen.
          surface === 'support'
            ? router.navigate('/(tabs)/help')
            : router.push(`/duty/${surface}`),
        ),
      )}
    />
  )
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

const dutyPriority: Surface[] = [
  'incidents',
  'reviews',
  'attendance',
  'operations',
  'floor',
  'support',
]

function collapse(value: string) {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim()
}

function groupHeadline(
  statuses: Record<Surface, DutyStatus>,
  shown: Surface[],
  who: string,
  group: 'floor' | 'board',
): DutyHeadline {
  const live = dutyPriority.find(
    (surface) => shown.includes(surface) && statuses[surface].active,
  )
  const headline = live ? statuses[live].headline : undefined
  if (live && headline) {
    const digits = headline.value.replace(/[^0-9]/gu, '').slice(0, 4)
    const status = statuses[live].status
    const restated =
      collapse(status) === collapse(`${headline.value} ${headline.unit ?? ''}`)
    return {
      primary: headline.value,
      ...(headline.unit === undefined ? {} : { secondary: headline.unit }),
      context: who,
      ...(restated ? {} : { summary: status }),
      accent: duty[dutyMeta[live].key].accent,
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
  const lead = shown[0] ?? (group === 'board' ? 'operations' : 'support')
  return {
    primary: String(shown.length),
    secondary: shown.length === 1 ? 'duty' : 'duties',
    context: who,
    summary: group === 'board' ? 'The event is quiet' : 'Nothing needs you right now',
    accent: duty[dutyMeta[lead].key].accent,
    ghost: String(shown.length),
  }
}
