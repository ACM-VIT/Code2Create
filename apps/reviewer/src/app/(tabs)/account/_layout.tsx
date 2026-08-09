import { Stack } from 'expo-router'

import { palette } from '@/theme'

/** Its own stack, so this tab can push a screen and keep a real iOS header. */
export default function AccountLayout() {
  return <Stack screenOptions={{ contentStyle: { backgroundColor: palette.background } }} />
}
