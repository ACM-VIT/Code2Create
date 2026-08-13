import { useCallback, useEffect, useState } from 'react'
import { AppState, StyleSheet, Text, View } from 'react-native'

import { Action, CheckRow, QuietAction } from '@/components/ui'
import { openPagingSetting } from '@/lib/paging-settings'
import { pagingReadiness, type PagingReadinessCheck } from '@/lib/push-notifications'
import { palette, radius } from '@/theme'

export function PagingSetup({
  onDone,
  requestPermission,
  tokenMissing = false,
  tokenRejected = false,
}: {
  onDone?: () => void
  requestPermission: () => Promise<void>
  tokenRejected?: boolean
  tokenMissing?: boolean
}) {
  const [checks, setChecks] = useState<PagingReadinessCheck[] | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void pagingReadiness().then(setChecks)
  }, [])

  useEffect(refresh, [refresh])

  // Refresh after returning from Settings; an immediate read is stale.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh()
    })
    return () => subscription.remove()
  }, [refresh])

  const permission = checks?.find((check) => check.key === 'permission')
  const settled = permission?.met === true

  return (
    <View style={styles.body}>
      <View accessibilityElementsHidden style={styles.preview}>
        <View style={styles.previewText}>
          <Text style={styles.previewTitle}>Substitute request</Text>
          <Text numberOfLines={2} style={styles.previewBody}>
            Panel A · Table 12 needs a reviewer.
          </Text>
        </View>
        <Text style={styles.previewWhen}>now</Text>
      </View>

      <Text style={styles.lead}>A panel short a reviewer waits on this phone.</Text>

      <View style={styles.rows}>
        {tokenRejected || tokenMissing ? (
          <CheckRow
            consequence={
              tokenRejected
                ? 'This phone was refused by the push service — allow notifications again, or reinstall'
                : 'This phone has no address to be paged at yet — reopen this after a moment online'
            }
            met={false}
            onPress={() => void openPagingSetting('notification_settings')}
            title="Reachable"
          />
        ) : null}
        {(checks ?? []).map((check, index) => (
          <View key={check.key} style={index === 0 ? undefined : styles.divider}>
          <CheckRow
            consequence={check.consequence}
            met={check.met}
            title={check.title}
            {...(check.fix
              ? {
                  onPress: async () => {
                    await openPagingSetting(check.fix!)
                  },
                }
              : {})}
          />
          </View>
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
  body: { gap: 16 },
  lead: { color: palette.muted, fontSize: 16, lineHeight: 22 },
  rows: { backgroundColor: palette.tile, borderRadius: radius.tile, overflow: 'hidden' },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.strong },

  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    backgroundColor: palette.strong,
    borderRadius: 20,
  },
  previewText: { flex: 1, gap: 2 },
  previewTitle: { color: palette.text, fontSize: 15, fontWeight: '600' },
  previewBody: { color: palette.muted, fontSize: 14, lineHeight: 19 },
  previewWhen: { color: palette.faint, fontSize: 13 },

})
