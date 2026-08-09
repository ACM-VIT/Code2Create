import { NativeTabs } from 'expo-router/unstable-native-tabs'

import { useReviewerSession } from '@/components/ReviewerSession'
import { useHelpStatus } from '@/lib/duty-status'
import { palette } from '@/theme'

/**
 * The platform's own tab bar — real blur, real haptics, real SF Symbols, and a
 * badge the operating system draws. A hand-built row of SVGs looks like an app
 * pretending to be native; at three in the morning that difference is the
 * difference between trusting the thing and not.
 */
export default function TabsLayout() {
  const { eventSlug, surfaces } = useReviewerSession()
  const help = useHelpStatus(eventSlug, surfaces.includes('support'))
  const openCases = Number(help.headline?.value ?? 0)

  return (
    <NativeTabs
      backgroundColor={palette.background}
      iconColor={palette.muted}
      tintColor={palette.hall}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }} />
        <NativeTabs.Trigger.Label>Duties</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger hidden={!surfaces.includes('support')} name="help">
        <NativeTabs.Trigger.Icon sf={{ default: 'lifepreserver', selected: 'lifepreserver.fill' }} />
        <NativeTabs.Trigger.Label>Help</NativeTabs.Trigger.Label>
        {openCases > 0 ? (
          <NativeTabs.Trigger.Badge>{String(openCases)}</NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="account">
        <NativeTabs.Trigger.Icon sf={{ default: 'person', selected: 'person.fill' }} />
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
