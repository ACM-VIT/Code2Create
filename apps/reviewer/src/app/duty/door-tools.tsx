import { useLocalSearchParams, useRouter } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'

import { Row } from '@/components/ui'
import { palette } from '@/theme'

/**
 * Everything this door can do that is not reading a badge.
 *
 * A real iOS form sheet: system grabber, a detent it rests at, the scanner
 * still visible behind it, and a drag down to dismiss.
 *
 * It takes what it shows as route parameters rather than subscribing again.
 * The scanner behind it already holds every one of these values, so a second
 * subscription would only add a way for the two to disagree, and a sheet is
 * open for seconds — nothing here changes underneath it.
 *
 * Laid out with a plain view: a scroll view inside a form sheet has no height
 * to measure against and collapses, which renders the whole sheet empty.
 */
export default function DoorToolsRoute() {
  const router = useRouter()
  const { station, zone, session, pending, sent } = useLocalSearchParams<{
    station?: string
    zone?: string
    session?: string
    pending?: string
    sent?: string
  }>()
  const pendingCount = Number(pending ?? '0')

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        <Text style={styles.title}>This door</Text>
        <Row
          {...(zone === undefined ? {} : { detail: session ? `${zone} · ${session}` : zone })}
          label={station ?? 'Station'}
        />
        <Row
          detail={
            pendingCount === 0
              ? 'Everything has reached the server'
              : `${pendingCount} still on this phone`
          }
          label="Unsent scans"
        />
        <Row detail={`${sent ?? '0'} from this phone`} label="Scans sent" />
        <Row
          detail="Issue badges and enrol ID cards instead of recording presence"
          label="Arrival and credentials"
          onPress={() => router.back()}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  body: { padding: 20, paddingTop: 26, gap: 10 },
  title: {
    marginBottom: 6,
    color: palette.text,
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: -0.5,
  },
})
