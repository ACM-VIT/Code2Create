import * as Sentry from '@sentry/react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { StrictMode } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { ReviewerAuthProvider } from '@/components/ReviewerAuthProvider'
import { ReviewerSessionProvider } from '@/components/ReviewerSession'
import { initializeReviewerObservability } from '@/lib/observability'
import { reviewerRuntime } from '@/lib/runtime'
import { palette } from '@/theme'

const observabilityEnabled = initializeReviewerObservability()

/**
 * Two levels of navigation, both the platform's own: a tab bar for the things
 * you hold, and a pushed stack for the duty you are in. Nothing is a modal
 * except the pager, which is supposed to interrupt.
 */
function RootLayout() {
  if (!reviewerRuntime) return <ConfigurationNeeded />

  return (
    <StrictMode>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <ReviewerAuthProvider runtime={reviewerRuntime}>
          <ReviewerSessionProvider runtime={reviewerRuntime}>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: palette.background },
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="duty/[surface]" />
            </Stack>
          </ReviewerSessionProvider>
        </ReviewerAuthProvider>
      </SafeAreaProvider>
    </StrictMode>
  )
}

function ConfigurationNeeded() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  )
}

export default observabilityEnabled ? Sentry.wrap(RootLayout) : RootLayout
