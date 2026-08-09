import { Stack } from 'expo-router'

import { palette } from '@/theme'

/** Its own stack, so this tab keeps a real iOS large-title header. */
export default function AccountLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: true,
        headerBlurEffect: 'systemChromeMaterialDark',
        headerStyle: { backgroundColor: 'transparent' },
        headerTintColor: palette.text,
        headerLargeTitleStyle: { color: palette.text },
        headerTitleStyle: { color: palette.text },
        contentStyle: { backgroundColor: palette.background },
      }}
    />
  )
}
