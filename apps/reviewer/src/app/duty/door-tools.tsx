import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'

import { useReviewerSession } from '@/components/ReviewerSession'
import { Row } from '@/components/ui'
import { loadScannerDevice } from '@/lib/scanner-device'
import { palette } from '@/theme'

/**
 * Everything this door can do that is not reading a badge.
 *
 * A real iOS form sheet: system grabber, a detent it rests at, the scanner
 * still visible behind it. Every row is always present and states what it
 * knows, including that it does not know yet — a sheet that renders nothing
 * while a query settles reads as broken.
 */
export default function DoorToolsRoute() {
  const router = useRouter()
  const { eventSlug } = useReviewerSession()
  const [installationId, setInstallationId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void loadScannerDevice(eventSlug)
      .then((record) => {
        if (active) setInstallationId(record ? record.installationId : null)
      })
      .catch(() => {
        if (active) setInstallationId(null)
      })
    return () => {
      active = false
    }
  }, [eventSlug])

  const assignment = useQuery(
    api.attendanceScanner.current,
    installationId ? { eventSlug, installationId } : 'skip',
  )
  const unknown = 'Checking'

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.body} style={styles.scroll}>
        <Text style={styles.title}>This door</Text>
        <Row
          detail={
            assignment
              ? `${assignment.station.zoneName}${
                  assignment.openSession ? ` · ${assignment.openSession.name}` : ''
                }`
              : assignment === null
                ? 'No station chosen for this phone yet'
                : unknown
          }
          label={assignment ? assignment.station.name : 'Station'}
        />
        <Row
          detail={
            assignment
              ? assignment.device.pendingReplayCount === 0
                ? 'Everything has reached the server'
                : `${assignment.device.pendingReplayCount} still on this phone`
              : unknown
          }
          label="Unsent scans"
        />
        <Row
          detail={assignment ? `${assignment.device.lastSequence} from this phone` : unknown}
          label="Scans sent"
        />
        <Row
          detail="Issue badges and enrol ID cards instead of recording presence"
          label="Arrival and credentials"
          onPress={() => router.back()}
        />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  scroll: { flex: 1 },
  body: { padding: 20, paddingTop: 26, gap: 10 },
  title: {
    marginBottom: 6,
    color: palette.text,
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: -0.5,
  },
})
