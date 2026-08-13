import { Stack } from 'expo-router'

import { screenHeader } from '@/lib/screen-header'

export default function HelpLayout() {
  return <Stack screenOptions={screenHeader} />
}
