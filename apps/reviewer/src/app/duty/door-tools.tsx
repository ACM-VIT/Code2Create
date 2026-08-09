import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'

import { useReviewerSession } from '@/components/ReviewerSession'
import { Nothing, Row, Shell } from '@/components/ui'
import { loadScannerDevice } from '@/lib/scanner-device'
import { palette } from '@/theme'

/**
 * Everything this door can do that is not reading a badge.
 *
 * A real iOS form sheet, not a full-screen React Native modal dressed up as
 * one: it has the system grabber, it stops at a detent, the scanner stays
 * visible behind it, and dragging it down dismisses it. The scanner's state is
 * re-derived here from the same queries rather than threaded through, which
 * Convex serves from the subscription the screen behind already holds.
 */
export default function DoorToolsRoute() {
  const router = useRouter()
  const { eventSlug } = useReviewerSession()
  const [installationId, setInstallationId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void loadScannerDevice(eventSlug).then((record) => {
      if (active) setInstallationId(record ? record.installationId : null)
    })
    return () => {
      active = false
    }
  }, [eventSlug])

  const assignment = useQuery(
    api.attendanceScanner.current,
    installationId ? { eventSlug, installationId } : 'skip',
  )

  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{
          headerShown: false,
          sheetGrabberVisible: true,
          sheetAllowedDetents: [0.5, 0.92],
          sheetCornerRadius: 20,
          contentStyle: { backgroundColor: palette.background },
        }}
      />
      <ScrollView contentContainerStyle={styles.body} style={styles.scroll}>
        {assignment === undefined ? <Shell /> : null}
        {assignment === null ? <Nothing>This phone has no station yet.</Nothing> : null}
        {assignment ? (
          <>
            <Row
              detail={`${assignment.station.zoneName}${
                assignment.openSession ? ` · ${assignment.openSession.name}` : ''
              }`}
              label={assignment.station.name}
            />
            <Row
              detail={
                assignment.device.pendingReplayCount === 0
                  ? 'Everything has reached the server'
                  : `${assignment.device.pendingReplayCount} still on this phone`
              }
              label="Unsent scans"
            />
            <Row detail={`${assignment.device.lastSequence} sent from this phone`} label="Total" />
            <Row
              detail="Issue badges and enrol ID cards instead of recording presence"
              label="Arrival and credentials"
              onPress={() => router.back()}
            />
          </>
        ) : null}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  scroll: { flex: 1 },
  body: { padding: 20, paddingTop: 28, gap: 10 },
})
