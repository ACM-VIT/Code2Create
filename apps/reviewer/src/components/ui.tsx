import { Button, Host, Text as NativeText } from '@expo/ui/swift-ui'
import {
  buttonStyle,
  controlSize,
  disabled as disabledModifier,
  font,
  frame,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import type { ReactNode } from 'react'
import { Dimensions, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import { palette } from '@/theme'

/**
 * The pieces every duty screen is built from.
 *
 * The duty screens were each carrying their own stylesheet from before the app
 * had a visual language — warm greys, a serif heading, a pink accent — so
 * opening one felt like leaving the product. These are the same square-cornered
 * surfaces and the same type as the duty grid, and the primary action on each
 * screen is a real UIKit button so it behaves like one.
 */

const screenPadding = 20
const actionWidth = Dimensions.get('window').width - screenPadding * 2

/** A titled block. The title is the only place a duty screen raises its voice. */
export function Section({
  action,
  children,
  lead,
  title,
}: {
  action?: ReactNode
  children?: ReactNode
  lead?: string
  title: string
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action}
      </View>
      {lead ? <Text style={styles.lead}>{lead}</Text> : null}
      {children}
    </View>
  )
}

/** A raised surface. Square, like the cards on the duty grid. */
export function Card({
  accent,
  children,
  onPress,
  selected = false,
}: {
  accent?: string
  children: ReactNode
  onPress?: () => void
  selected?: boolean
}) {
  const body = (
    <View
      style={[
        styles.card,
        selected && accent ? { borderLeftWidth: 3, borderLeftColor: accent } : null,
      ]}
    >
      {children}
    </View>
  )
  if (!onPress) return body
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed ? styles.pressed : null}>
      {body}
    </Pressable>
  )
}

/** Two lines with the fact on the right, for a run of stated values. */
export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.keyValue}>
      <Text style={styles.keyValueLabel}>{label}</Text>
      <Text style={styles.keyValueText}>{value}</Text>
    </View>
  )
}

export function Heading({ children }: { children: ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>
}

export function Body({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>
}

export function Meta({ children }: { children: ReactNode }) {
  return <Text style={styles.meta}>{children}</Text>
}

export function Problem({ children }: { children: ReactNode }) {
  return <Text style={styles.problem}>{children}</Text>
}

/** What to say when there is genuinely nothing here, without saying "empty". */
export function Nothing({ children }: { children: string }) {
  return (
    <View style={styles.nothing}>
      <Text style={styles.nothingText}>{children}</Text>
    </View>
  )
}

export function Field({
  label,
  multiline = false,
  onChangeText,
  placeholder,
  value,
  ...rest
}: {
  editable?: boolean
  label: string
  maxLength?: number
  multiline?: boolean
  onChangeText: (value: string) => void
  placeholder: string
  value: string
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.faint}
        style={[styles.input, multiline ? styles.inputTall : null]}
        value={value}
        {...rest}
      />
    </View>
  )
}

/** A row of one-tap choices. Selected fills solid in the duty's own colour. */
export function ChipRow<Value extends string>({
  accent = palette.text,
  onSelect,
  options,
  selected,
}: {
  accent?: string
  onSelect: (value: Value) => void
  options: readonly (readonly [Value, string])[]
  selected: Value
}) {
  return (
    <View style={styles.chipRow}>
      {options.map(([value, label]) => {
        const on = value === selected
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            key={value}
            onPress={() => onSelect(value)}
            style={[styles.chip, on ? { backgroundColor: accent } : null]}
          >
            <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>{label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * The one thing this screen is for, as a real UIKit button. Everything else on
 * a duty screen is a quiet text action, so there is never a question about
 * which control is the point.
 */
export function Action({
  accent = palette.judging,
  destructive = false,
  disabled = false,
  label,
  onPress,
}: {
  accent?: string
  destructive?: boolean
  disabled?: boolean
  label: string
  onPress: () => void | Promise<void>
}) {
  return (
    <Host style={styles.action}>
      <Button
        modifiers={[
          buttonStyle('borderedProminent'),
          controlSize('extraLarge'),
          tint(destructive ? palette.urgent : accent),
          disabledModifier(disabled),
        ]}
        {...(destructive ? { role: 'destructive' as const } : {})}
        onPress={() => void onPress()}
      >
        {/* A bordered-prominent button hugs its label, so the label is what has
            to span the screen. */}
        <NativeText
          modifiers={[frame({ width: actionWidth, height: 28 }), font({ size: 18, weight: 'semibold' })]}
        >
          {label}
        </NativeText>
      </Button>
    </Host>
  )
}

export function QuietAction({
  disabled = false,
  label,
  onPress,
}: {
  disabled?: boolean
  label: string
  onPress: () => void | Promise<void>
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      onPress={() => void onPress()}
      style={({ pressed }) => [styles.quiet, disabled ? styles.dim : null, pressed ? styles.pressed : null]}
    >
      <Text style={styles.quietText}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { color: palette.text, fontSize: 20, fontWeight: '600', letterSpacing: -0.4 },
  lead: { color: palette.muted, fontSize: 16, lineHeight: 23 },

  card: { backgroundColor: palette.tile, padding: 16, gap: 8 },
  pressed: { opacity: 0.75 },
  dim: { opacity: 0.45 },

  keyValue: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 16 },
  keyValueLabel: { color: palette.muted, fontSize: 15 },
  keyValueText: { flexShrink: 1, color: palette.text, fontSize: 15, textAlign: 'right' },

  heading: { color: palette.text, fontSize: 22, fontWeight: '600', letterSpacing: -0.4 },
  body: { color: palette.text, fontSize: 16, lineHeight: 23 },
  meta: { color: palette.muted, fontSize: 14 },
  problem: { color: palette.urgent, fontSize: 15, lineHeight: 21 },

  nothing: { paddingVertical: 34, alignItems: 'center' },
  nothingText: { color: palette.faint, fontSize: 16, textAlign: 'center' },

  field: { gap: 7 },
  fieldLabel: { color: palette.muted, fontSize: 14 },
  input: {
    height: 50,
    paddingHorizontal: 14,
    color: palette.text,
    fontSize: 17,
    backgroundColor: palette.tile,
  },
  inputTall: { height: 108, paddingTop: 13, textAlignVertical: 'top' },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, height: 40, justifyContent: 'center', backgroundColor: palette.tile },
  chipText: { color: palette.text, fontSize: 15 },
  chipTextOn: { color: palette.background, fontWeight: '600' },

  action: { alignSelf: 'stretch', height: 62 },
  quiet: { alignSelf: 'flex-start', paddingVertical: 10 },
  quietText: { color: palette.muted, fontSize: 16 },
})
