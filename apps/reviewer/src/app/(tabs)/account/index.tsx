import { StyleSheet, Text, View } from 'react-native'

import { DutyScreen } from '@/components/DutyScreen'
import { PrimaryAction, useReviewerSession } from '@/components/ReviewerSession'
import { palette, radius } from '@/theme'

export default function AccountScreen() {
  const { email, runtime, signOut, surfaces, who } = useReviewerSession()
  return (
    <DutyScreen title="You">
      <View style={styles.identity}>
        <Text style={styles.name}>{who}</Text>
        <Text style={styles.email}>{email}</Text>
      </View>
      <View style={styles.rows}>
        <Row label="Event" value={runtime.configuration.eventSlug} />
        <Row
          label="Duties"
          value={`${surfaces.length} ${surfaces.length === 1 ? 'duty' : 'duties'}`}
        />
        <Row label="Build" value={String(runtime.configuration.appBuild)} />
      </View>
      <View style={styles.spacer} />
      <PrimaryAction label="Sign out" onPress={signOut} secondary />
    </DutyScreen>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  identity: { paddingBottom: 22 },
  name: { color: palette.text, fontSize: 28, fontWeight: '600', letterSpacing: -0.5 },
  email: { marginTop: 4, color: palette.muted, fontSize: 16 },
  /* Tiles rather than hairline rules, so this reads as the same app as every
     other list rather than as the settings screen it grew out of. */
  rows: { gap: 8 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 15,
    paddingHorizontal: 16,
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
  },
  rowLabel: { color: palette.muted, fontSize: 16 },
  rowValue: { color: palette.text, fontSize: 16 },
  spacer: { flex: 1, minHeight: 28 },
})
