import * as Sentry from '@sentry/react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { StrictMode } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { ReviewerAuthProvider } from '@/components/ReviewerAuthProvider'
import { initializeReviewerObservability } from '@/lib/observability'
import { reviewerRuntime } from '@/lib/runtime'

const observabilityEnabled = initializeReviewerObservability()

function RootLayout() {
  const content = (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0a0a09' } }} />
    </SafeAreaProvider>
  )

  if (!reviewerRuntime) return content

  return (
    <StrictMode>
      <ReviewerAuthProvider runtime={reviewerRuntime}>{content}</ReviewerAuthProvider>
    </StrictMode>
  )
}

export default observabilityEnabled ? Sentry.wrap(RootLayout) : RootLayout
