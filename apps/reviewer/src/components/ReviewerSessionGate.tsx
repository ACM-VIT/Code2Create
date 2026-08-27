import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { AcmMark, BrandBackdrop, BrandMark, BrandWordmark } from '@/components/Brand'
import { palette, radius } from '@/theme'

export function ReviewerBooting() {
  return (
    <BrandBackdrop>
      <View style={[styles.gate, styles.centred]}>
        <View>
          <BrandMark size={112} />
        </View>
        <View style={styles.bootWordmark}>
          <BrandWordmark width={252} />
        </View>
        <View style={styles.bootFoot}>
          <AcmMark size={40} />
        </View>
      </View>
    </BrandBackdrop>
  )
}

export function ReviewerGate({
  children,
  error,
  title,
  who,
}: {
  children: ReactNode
  error: string | null
  title: string
  who?: string
}) {
  return (
    <BrandBackdrop>
      <SafeAreaView edges={['top', 'bottom']} style={styles.gate}>
        <View style={styles.gateBody}>
          <BrandMark size={104} />
          <View style={styles.gateWordmark}>
            <BrandWordmark width={228} />
          </View>
          <Text style={styles.title}>{title}</Text>
          {who ? <Text style={styles.who}>{who}</Text> : null}
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.actions}>{children}</View>
      </SafeAreaView>
    </BrandBackdrop>
  )
}

export function PrimaryAction({
  disabled = false,
  label,
  onPress,
  secondary = false,
}: {
  disabled?: boolean
  label: string
  onPress: () => void | Promise<void>
  secondary?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        secondary ? styles.actionSecondary : null,
        disabled ? styles.actionDisabled : null,
        pressed ? styles.actionPressed : null,
      ]}
    >
      <Text style={[styles.actionText, secondary ? styles.actionTextSecondary : null]}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  gate: { flex: 1, paddingHorizontal: 24 },
  centred: { alignItems: 'center', justifyContent: 'center' },
  gateBody: { flex: 1, justifyContent: 'flex-end', paddingBottom: 40 },
  bootWordmark: { marginTop: 26 },
  bootFoot: { position: 'absolute', bottom: 34, alignSelf: 'center' },
  gateWordmark: { marginTop: 22 },
  title: {
    marginTop: 20,
    color: palette.text,
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: -0.5,
  },
  who: { marginTop: 8, color: palette.muted, fontSize: 16 },
  error: { color: palette.urgent, fontSize: 15, lineHeight: 21, marginBottom: 12 },
  actions: { paddingBottom: 12, gap: 10 },
  action: {
    height: 56,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.text,
  },
  actionSecondary: { backgroundColor: palette.tile },
  actionPressed: { opacity: 0.8 },
  actionDisabled: { opacity: 0.4 },
  actionText: { color: palette.background, fontSize: 17, fontWeight: '600' },
  actionTextSecondary: { color: palette.text },
})
