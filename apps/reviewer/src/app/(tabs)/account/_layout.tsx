import { Stack } from 'expo-router'

import { screenHeader } from '@/lib/screen-header'

export default function AccountLayout() {
  return <Stack screenOptions={screenHeader} />
}
