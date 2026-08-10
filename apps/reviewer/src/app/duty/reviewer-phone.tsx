import { useLocalSearchParams } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'

import { KeyValue } from '@/components/ui'
import { palette, radius } from '@/theme'

/**
 * What this phone is, for the one time somebody asks.
 *
 * A reviewer between reviews does not need to be told their app build or that
 * their encrypted drafts are ready — they need to know whether they are on
 * duty. These are the checks an operator asks about when something is wrong,
 * so they live one press away instead of on the duty screen.
 *
 * Takes what it shows as route parameters: the screen behind it already holds
 * every one of these values, and a sheet is open for seconds.
 */
export default function ReviewerPhoneSheet() {
  const params = useLocalSearchParams<{
    build?: string
    camera?: string
    drafts?: string
    notifications?: string
    panel?: string
  }>()

  const rows: readonly (readonly [string, string])[] = [
    ...(params.panel ? ([['Panel', params.panel]] as const) : []),
    ['App build', params.build ?? '—'],
    ['Camera', params.camera ?? '—'],
    ['Notifications', params.notifications ?? '—'],
    ['Encrypted drafts', params.drafts ?? '—'],
  ]

  return (
    <View style={styles.sheet}>
      <Text style={styles.title}>This phone</Text>
      <View style={styles.body}>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <KeyValue label={label} value={value} />
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: palette.background, padding: 20, gap: 16 },
  title: { color: palette.text, fontSize: 28, fontWeight: '600', letterSpacing: -0.6 },
  /* A plain view: a scroll view in a form sheet has no height to measure
     against and collapses, which renders the whole sheet empty. */
  body: { gap: 10 },
  row: {
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
})
