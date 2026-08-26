import { useLocalSearchParams, useRouter } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'

import { Row } from '@/components/ui'
import { palette } from '@/theme'

// ScrollView has no measurable height inside this form sheet.
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
              ? 'All scans have synced'
              : `${pendingCount} still on this phone`
          }
          label="Unsent scans"
        />
        <Row detail={`${sent ?? '0'} from this phone`} label="Scans sent" />
        <Row
          detail="Issue badges and enrol ID cards instead of recording presence"
          label="Arrival and credentials"
          onPress={() =>
            router.dismissTo({
              pathname: '/duty/[surface]',
              params: { surface: 'attendance', task: 'staffed' },
            })
          }
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
