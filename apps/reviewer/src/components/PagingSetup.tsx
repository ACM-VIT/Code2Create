import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { Action, QuietAction } from '@/components/ui'
import { openPagingSetting } from '@/lib/paging-settings'
import { pagingReadiness, type PagingReadinessCheck } from '@/lib/push-notifications'
import { palette, radius } from '@/theme'

/**
 * The one thing a reviewer has to set up before a shift.
 *
 * Everything else this app asks for can be fixed while standing still. Paging
 * cannot: by the time a page is missed the panel has already waited. So this
 * is checked up front, states what is lost rather than what is off, and every
 * unmet row is a button that opens the exact screen with the switch on it.
 *
 * The rows that cannot be read back — Android hides full-screen and battery
 * behind switches with no query API — are offered rather than asserted, so a
 * reviewer is never told something is wrong that is already right.
 */
export function PagingSetup({
  onDone,
  requestPermission,
}: {
  /** Absent while this is a step in a flow rather than a screen of its own. */
  onDone?: () => void
  requestPermission: () => Promise<void>
}) {
  const [checks, setChecks] = useState<PagingReadinessCheck[] | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = () => {
    void pagingReadiness().then(setChecks)
  }

  useEffect(refresh, [])

  const permission = checks?.find((check) => check.key === 'permission')
  const settled = permission?.met === true

  return (
    <View style={styles.body}>
      <Text style={styles.lead}>A panel short a reviewer waits on this phone.</Text>

      <View style={styles.rows}>
        {(checks ?? []).map((check) => (
          <CheckRow key={check.key} check={check} onOpened={refresh} />
        ))}
      </View>

      {!settled ? (
        <Action
          accent={palette.judging}
          disabled={busy}
          label={busy ? 'Asking…' : 'Allow notifications'}
          onPress={async () => {
            setBusy(true)
            try {
              await requestPermission()
              refresh()
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : null}

      {onDone ? (
        <QuietAction
          label={settled ? 'Done' : 'Set this up later'}
          onPress={onDone}
        />
      ) : null}
    </View>
  )
}

function CheckRow({
  check,
  onOpened,
}: {
  check: PagingReadinessCheck
  onOpened: () => void
}) {
  const openable = check.fix !== undefined && !check.met
  return (
    <Pressable
      accessibilityHint={openable ? 'Opens this phone’s settings' : undefined}
      accessibilityRole={openable ? 'button' : undefined}
      disabled={!openable}
      onPress={async () => {
        if (!check.fix) return
        await openPagingSetting(check.fix)
        /* The switch is thrown in another app, so the only honest moment to
           re-read it is when this one is looked at again. */
        onOpened()
      }}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      <View style={styles.rowMark}>
        <View style={[styles.dot, check.met ? styles.dotOn : null]} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{check.title}</Text>
        <Text style={styles.rowConsequence}>
          {check.met ? 'Ready' : check.consequence}
        </Text>
      </View>
      {openable ? <Text style={styles.rowChevron}>›</Text> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  body: { gap: 14 },
  lead: { color: palette.muted, fontSize: 17, lineHeight: 24 },
  rows: { gap: 8, paddingTop: 4 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
  },
  pressed: { opacity: 0.75 },
  rowMark: { width: 14, alignItems: 'center' },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: palette.faint,
  },
  dotOn: { borderColor: palette.judging, backgroundColor: palette.judging },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: palette.text, fontSize: 17 },
  rowConsequence: { color: palette.muted, fontSize: 14, lineHeight: 19 },
  rowChevron: { color: palette.faint, fontSize: 22 },
})
