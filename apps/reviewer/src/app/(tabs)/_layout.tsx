import { NativeTabs } from 'expo-router/unstable-native-tabs'

import { useReviewerSession } from '@/components/ReviewerSession'
import { splitDuties } from '@/lib/duties'
import { useHelpStatus, useIncidentStatus } from '@/lib/duty-status'
import { palette } from '@/theme'

export default function TabsLayout() {
  const { eventSlug, surfaces } = useReviewerSession()
  const help = useHelpStatus(eventSlug, surfaces.includes('support'))
  const incidents = useIncidentStatus(eventSlug, surfaces.includes('incidents'))
  const openCases = help.headline?.value
  const liveIncidents = incidents.headline?.value
  const duties = splitDuties(surfaces)

  return (
    <NativeTabs
      backgroundColor={palette.background}
      iconColor={palette.muted}
      indicatorColor={palette.tile}
      labelVisibilityMode="labeled"
      rippleColor={palette.strong}
      tintColor={palette.text}
    >
      <NativeTabs.Trigger hidden={duties.floor.length === 0} name="index">
        <NativeTabs.Trigger.Icon
          md={{ default: 'grid_view', selected: 'grid_view' }}
          sf={{ default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }}
        />
        <NativeTabs.Trigger.Label>Duties</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger hidden={duties.board.length === 0} name="board">
        <NativeTabs.Trigger.Icon
          md={{ default: 'monitor_heart', selected: 'monitor_heart' }}
          sf={{ default: 'waveform.path.ecg', selected: 'waveform.path.ecg' }}
        />
        <NativeTabs.Trigger.Label>Event</NativeTabs.Trigger.Label>
        {liveIncidents ? (
          <NativeTabs.Trigger.Badge>{liveIncidents}</NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger hidden={!surfaces.includes('support')} name="help">
        <NativeTabs.Trigger.Icon
          md={{ default: 'support_agent', selected: 'support_agent' }}
          sf={{ default: 'lifepreserver', selected: 'lifepreserver.fill' }}
        />
        <NativeTabs.Trigger.Label>Help</NativeTabs.Trigger.Label>
        {openCases ? (
          <NativeTabs.Trigger.Badge>{openCases}</NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="account">
        <NativeTabs.Trigger.Icon
          md={{ default: 'person', selected: 'person' }}
          sf={{ default: 'person', selected: 'person.fill' }}
        />
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
