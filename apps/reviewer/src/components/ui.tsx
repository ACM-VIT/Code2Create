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
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

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

/** Grey blocks where the content will land. Never the word "Loading". */
export function Shell({ lines = 3 }: { lines?: number }) {
  return (
    <View style={styles.shell}>
      {Array.from({ length: lines }, (_, index) => (
        <View key={index} style={[styles.shellLine, index === 0 ? styles.shellLead : null]} />
      ))}
    </View>
  )
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
  wrap = true,
}: {
  accent?: string
  onSelect: (value: Value) => void
  options: readonly (readonly [Value, string])[]
  selected: Value
  /** False keeps one line and scrolls, rather than breaking into ragged rows. */
  wrap?: boolean
}) {
  const Row = wrap ? View : ScrollView
  return (
    <Row
      horizontal={!wrap}
      showsHorizontalScrollIndicator={false}
      {...(wrap ? { style: styles.chipRow } : { contentContainerStyle: styles.chipRow })}
    >
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
    </Row>
  )
}

/**
 * The one number this screen is about, set the way the duty grid sets its
 * headline. A screen that opens with a sentence reads as a document; a screen
 * that opens with a number reads as a job in progress.
 */
export function Lead({
  accent = palette.text,
  detail,
  unit,
  value,
}: {
  accent?: string
  detail?: string
  unit?: string
  value: string
}) {
  return (
    <View style={styles.lead2}>
      <Text allowFontScaling={false} numberOfLines={1} style={[styles.leadValue, { color: accent }]}>
        {value}
      </Text>
      {unit ? (
        <Text allowFontScaling={false} numberOfLines={1} style={styles.leadUnit}>
          {unit}
        </Text>
      ) : null}
      {detail ? <Text style={styles.leadDetail}>{detail}</Text> : null}
    </View>
  )
}

/**
 * The camera, given the room it needs.
 *
 * A small preview with a hairline rectangle over it asks someone to aim a phone
 * at a lanyard in a dark hall through a viewport the size of a stamp. This is
 * full width, nearly square, with brackets thick enough to find in peripheral
 * vision, in the colour of the duty being done.
 */
export function Viewfinder({
  accent,
  children,
}: {
  accent: string
  children: ReactNode
}) {
  return (
    <View style={styles.viewfinder}>
      {children}
      <View pointerEvents="none" style={styles.brackets}>
        <View style={[styles.bracket, styles.bracketTopLeft, { borderColor: accent }]} />
        <View style={[styles.bracket, styles.bracketTopRight, { borderColor: accent }]} />
        <View style={[styles.bracket, styles.bracketBottomLeft, { borderColor: accent }]} />
        <View style={[styles.bracket, styles.bracketBottomRight, { borderColor: accent }]} />
      </View>
    </View>
  )
}

/**
 * A scanner that owns the screen.
 *
 * The camera runs edge to edge behind everything, the way a ticket app's does,
 * because the job is aiming a phone at a lanyard in a dark hall. Controls float
 * over the top of it and the result rises from the bottom, so nothing pushes
 * the viewfinder around or scrolls it out of reach mid-shift.
 */
export function ScanSurface({
  camera,
  controls,
  outcome,
  result,
}: {
  camera: ReactNode
  controls?: ReactNode
  /** Colour of the floating verdict pill: absent while nothing has been read. */
  outcome?: { colour: string; ink: string; text: string }
  result?: ReactNode
}) {
  return (
    <View style={styles.scanSurface}>
      {camera}
      <View pointerEvents="none" style={styles.scanGuide} />

      <View pointerEvents="box-none" style={styles.scanTop}>
        {outcome ? (
          <View style={[styles.verdict, { backgroundColor: outcome.colour }]}>
            <Text style={[styles.verdictText, { color: outcome.ink }]}>{outcome.text}</Text>
          </View>
        ) : null}
        {controls}
      </View>

      {result ? <View style={styles.scanResult}>{result}</View> : null}
    </View>
  )
}

/**
 * A whole scale as one row of large blocks, the way a survey app sets out a
 * rating: every option visible at once, each one a target you can hit without
 * looking, and the chosen one filled solid. A slider or a stepper would ask a
 * judge to aim, at a table, standing up, at three in the morning.
 */
export function ScoreRow({
  accent = palette.judging,
  disabled = false,
  ink = palette.onJudging,
  onSelect,
  scores,
  selected,
}: {
  accent?: string
  disabled?: boolean
  ink?: string
  onSelect: (score: number) => void
  scores: readonly number[]
  selected: number | undefined
}) {
  return (
    <View style={styles.scoreRow}>
      {scores.map((score) => {
        const on = score === selected
        return (
          <Pressable
            accessibilityLabel={String(score)}
            accessibilityRole="button"
            accessibilityState={{ disabled, selected: on }}
            disabled={disabled}
            key={score}
            onPress={() => onSelect(score)}
            style={({ pressed }) => [
              styles.score,
              on ? { backgroundColor: accent } : null,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={[styles.scoreText, on ? { color: ink, fontWeight: '700' } : null]}>
              {score}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** How far through a run of work this screen is. Thick, like the duty grid's. */
export function Progress({
  accent = palette.judging,
  done,
  total,
}: {
  accent?: string
  done: number
  total: number
}) {
  const filled = total === 0 ? 0 : Math.max(0, Math.min(1, done / total))
  return (
    <View style={styles.progress}>
      {filled > 0 ? <View style={{ flex: filled, backgroundColor: accent }} /> : null}
      {filled > 0 && filled < 1 ? <View style={styles.progressGap} /> : null}
      {filled < 1 ? <View style={{ flex: 1 - filled, backgroundColor: palette.strong }} /> : null}
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

  shell: { gap: 12, paddingTop: 4 },
  shellLead: { height: 54, width: '58%' },
  shellLine: { height: 18, borderRadius: 2, backgroundColor: palette.tile },

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

  scanSurface: { flex: 1, backgroundColor: '#000' },
  /* A single rounded window rather than four brackets: at full-bleed the
     brackets read as screen furniture, the window reads as "aim here". */
  scanGuide: {
    position: 'absolute',
    top: '24%',
    right: '12%',
    bottom: '30%',
    left: '12%',
    borderWidth: 2,
    borderRadius: 22,
    borderColor: 'rgba(255,255,255,0.55)',
  },
  scanTop: { position: 'absolute', top: 12, right: 16, left: 16, gap: 12, alignItems: 'center' },
  verdict: { paddingHorizontal: 18, height: 40, borderRadius: 999, justifyContent: 'center' },
  verdictText: { fontSize: 16, fontWeight: '600' },
  scanResult: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    padding: 20,
    paddingBottom: 34,
    gap: 10,
    backgroundColor: palette.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },

  lead2: { paddingBottom: 4 },
  leadValue: { fontSize: 52, fontWeight: '600', letterSpacing: -1.6, lineHeight: 54 },
  leadUnit: { color: palette.text, fontSize: 26, fontWeight: '500', letterSpacing: -0.6 },
  leadDetail: { marginTop: 10, color: palette.muted, fontSize: 16, lineHeight: 22 },

  viewfinder: {
    width: '100%',
    aspectRatio: 1.05,
    backgroundColor: '#000',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  brackets: { position: 'absolute', top: 28, right: 28, bottom: 28, left: 28 },
  bracket: { position: 'absolute', width: 46, height: 46 },
  bracketTopLeft: { top: 0, left: 0, borderTopWidth: 5, borderLeftWidth: 5 },
  bracketTopRight: { top: 0, right: 0, borderTopWidth: 5, borderRightWidth: 5 },
  bracketBottomLeft: { bottom: 0, left: 0, borderBottomWidth: 5, borderLeftWidth: 5 },
  bracketBottomRight: { bottom: 0, right: 0, borderBottomWidth: 5, borderRightWidth: 5 },

  /* Tall enough to hit without aiming, and wide enough that a five-point
     scale still fills the row. */
  scoreRow: { flexDirection: 'row', gap: 7 },
  score: {
    flex: 1,
    height: 62,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.tile,
  },
  scoreText: { color: palette.text, fontSize: 22, fontWeight: '500' },

  progress: { flexDirection: 'row', height: 8 },
  progressGap: { width: 3 },

  action: { alignSelf: 'stretch', height: 62 },
  quiet: { alignSelf: 'flex-start', paddingVertical: 10 },
  quietText: { color: palette.muted, fontSize: 16 },
})
