import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { Action, CheckRow, QuietAction } from '@/components/ui'
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
  tokenRejected = false,
}: {
  /** Absent while this is a step in a flow rather than a screen of its own. */
  onDone?: () => void
  requestPermission: () => Promise<void>
  /** The server tried to page this phone and the push provider refused it. */
  tokenRejected?: boolean
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
      {/* The page itself, as it arrives. Every priming screen worth copying
          shows the notification rather than describing it, because what a
          reviewer is agreeing to is this arriving at three in the morning. */}
      <View accessibilityElementsHidden style={styles.preview}>
        <View style={styles.previewIcon} />
        <View style={styles.previewText}>
          <Text style={styles.previewTitle}>Substitute request</Text>
          <Text numberOfLines={2} style={styles.previewBody}>
            A reviewer seat on Panel A needs coverage.
          </Text>
        </View>
        <Text style={styles.previewWhen}>now</Text>
      </View>

      <Text style={styles.lead}>A panel short a reviewer waits on this phone.</Text>

      <View style={styles.rows}>
        {/* The phone can hold every permission and still be unreachable: only
            the server knows a page was refused, so it is a row here rather
            than a sentence somewhere else. */}
        {tokenRejected ? (
          <CheckRow
            consequence="This phone was refused by the push service — allow notifications again, or reinstall"
            met={false}
            onPress={() => void openPagingSetting('notification_settings')}
            title="Reachable"
          />
        ) : null}
        {(checks ?? []).map((check) => (
          <CheckRow
            consequence={check.consequence}
            key={check.key}
            met={check.met}
            title={check.title}
            {...(check.fix
              ? {
                  onPress: async () => {
                    await openPagingSetting(check.fix!)
                    /* The switch is thrown in another app, so the only honest
                       moment to re-read it is on the way back. */
                    refresh()
                  },
                }
              : {})}
          />
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

const styles = StyleSheet.create({
  body: { gap: 14 },
  lead: { color: palette.muted, fontSize: 17, lineHeight: 24 },
  rows: { gap: 8, paddingTop: 4 },

  /* A lock-screen notification, drawn rather than screenshotted so it stays
     right when the copy changes. */
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    backgroundColor: palette.tile,
    borderRadius: 18,
  },
  previewIcon: {
    width: 38,
    height: 38,
    borderRadius: 9,
    backgroundColor: palette.judging,
  },
  previewText: { flex: 1, gap: 2 },
  previewTitle: { color: palette.text, fontSize: 15, fontWeight: '600' },
  previewBody: { color: palette.muted, fontSize: 14, lineHeight: 19 },
  previewWhen: { color: palette.faint, fontSize: 13 },

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
