import { StyleSheet, Text, View } from 'react-native'

import { Action, CheckRow } from '@/components/ui'
import { palette } from '@/theme'

/**
 * Everything that has to be true before a reviewer can take a team.
 *
 * These were four buttons and three red sentences scattered down the duty
 * screen, each appearing only once its own condition failed — so a reviewer
 * met them one at a time, in whatever order they happened to break, and never
 * saw how much was left. They are one list now, in the order somebody would
 * work through them, with a count so the end is visible from the start.
 *
 * Each line says what is lost while it is unmet rather than naming the switch,
 * because a reviewer standing in a hall is deciding whether to care, not
 * reading a settings label back to themselves.
 */
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
  /** Whether the checks meet what this round demands, not whether all are met. */
  ready: boolean
  registerLabel: string
}) {
  const checks = [
    {
      title: 'Camera',
      consequence: 'You cannot scan a team to start their review',
      met: cameraReady,
      onPress: onRequestCamera,
    },
    {
      title: 'Getting paged',
      consequence: 'A panel short a reviewer will not reach you',
      met: pagingReady,
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
      <Text style={styles.count}>
        {done} of {checks.length} ready
      </Text>

      <View style={styles.rows}>
        {checks.map((check) => (
          <CheckRow
            consequence={check.consequence}
            key={check.title}
            met={check.met}
            title={check.title}
            {...('onPress' in check ? { onPress: check.onPress } : {})}
          />
        ))}
      </View>

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
  body: { gap: 14, paddingTop: 4 },
  count: { color: palette.muted, fontSize: 15, fontWeight: '600', letterSpacing: 0.4 },
  rows: { gap: 8 },
})
