import { StyleSheet, Text, View } from 'react-native'

import { Action, CheckRow } from '@/components/ui'
import { palette } from '@/theme'

export function ReviewerSetup({
  busy,
  cameraReady,
  draftsReady,
  onOpenPaging,
  onRegister,
  onRequestCamera,
  pagingReady,
  ready,
  registerLabel,
}: {
  busy: boolean
  cameraReady: boolean
  draftsReady: boolean
  onOpenPaging: () => void
  onRegister: () => void | Promise<void>
  onRequestCamera: () => void | Promise<void>
  pagingReady: boolean
  ready: boolean
  registerLabel: string
}) {
  const checks = [
    {
      title: 'Camera',
      consequence: 'You cannot scan a team to start their review',
      met: cameraReady,
      actionLabel: 'Allow',
      onPress: onRequestCamera,
    },
    {
      title: 'Getting paged',
      consequence: 'A panel short a reviewer will not reach you',
      met: pagingReady,
      actionLabel: 'Set up',
      onPress: onOpenPaging,
    },
    {
      title: 'Encrypted drafts',
      consequence: 'Scores cannot be held safely if the network drops',
      met: draftsReady,
    },
  ] as const

  const done = checks.filter((check) => check.met).length

  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <Text style={styles.title}>Set up this phone</Text>
        <Text style={styles.subtitle}>
          {done === checks.length
            ? 'Everything is ready. Register to join your panel.'
            : 'A judging phone joins a panel when all three are ready.'}
        </Text>
      </View>

      <View style={styles.meter}>
        {checks.map((check) => (
          <View
            key={check.title}
            style={[styles.meterSegment, check.met ? styles.meterDone : null]}
          />
        ))}
      </View>

      <View style={styles.rows}>
        {checks.map((check, index) => (
          <View key={check.title}>
            {index > 0 ? <View style={styles.divider} /> : null}
            <CheckRow
              consequence={check.consequence}
              met={check.met}
              title={check.title}
              {...('onPress' in check
                ? { actionLabel: check.actionLabel, onPress: check.onPress }
                : {})}
            />
          </View>
        ))}
      </View>

      {/* The spacer walks the one real action down to the thumb instead of
          leaving it wherever the checklist happened to end. */}
      <View style={styles.push} />
      <Action
        accent={palette.judging}
        disabled={busy || !ready}
        label={registerLabel}
        onPress={onRegister}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, paddingTop: 10 },
  push: { flexGrow: 1 },
  head: { gap: 8, paddingHorizontal: 4 },
  title: { color: palette.text, fontSize: 28, fontWeight: '600', letterSpacing: -0.6 },
  subtitle: { color: palette.muted, fontSize: 16, lineHeight: 22 },
  meter: { flexDirection: 'row', gap: 6, marginTop: 20, paddingHorizontal: 4 },
  meterSegment: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.ghost,
  },
  meterDone: { backgroundColor: palette.judging },
  rows: { marginTop: 18 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: palette.strong, marginLeft: 56 },
})
