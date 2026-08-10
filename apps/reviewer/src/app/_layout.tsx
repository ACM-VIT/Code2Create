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
              {/* The tab group never shows this header, but a pushed duty
                  screen's back button borrows it: the long-press history menu
                  and the chevron's screen-reader label both read this title,
                  and without one they read the folder name "(tabs)". */}
              <Stack.Screen name="(tabs)" options={{ title: 'Duties' }} />
              {/* No title here: every duty renders through DutyScreen, which
                  sets its own before the header first draws. */}
              <Stack.Screen name="duty/[surface]" />
              {/* A real iOS form sheet: system grabber, a detent it rests at,
                  and the screen behind still visible. Declared here because the
                  presentation style has to be known before the route mounts. */}
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
