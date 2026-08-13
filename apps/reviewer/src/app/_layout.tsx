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
              {/* Pushed routes use this title for back-button accessibility and history. */}
              <Stack.Screen name="(tabs)" options={{ title: 'Duties' }} />
              <Stack.Screen name="duty/[surface]" />
              <Stack.Screen
                name="duty/door-tools"
                options={{
                  presentation: 'formSheet',
                  headerShown: false,
                  sheetGrabberVisible: true,
                  sheetAllowedDetents: [0.5, 0.92],
                  sheetCornerRadius: 20,
                }}
              />
              <Stack.Screen
                name="duty/reviewer-phone"
                options={{
                  presentation: 'formSheet',
                  headerShown: false,
                  sheetGrabberVisible: true,
                  sheetAllowedDetents: [0.5],
                  sheetCornerRadius: 20,
                }}
              />
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
