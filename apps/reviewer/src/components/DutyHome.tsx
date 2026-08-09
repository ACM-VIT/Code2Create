import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { type DutyKey, duty, palette, space, tileAspectRatio, type } from '@/theme'

export type DutyTile = {
  key: DutyKey
  /** What the duty is called, in the words a volunteer would use. */
  label: string
  /** Its live state — a fact, never an instruction. */
  status: string
  /** True while this duty is actually running. Several may be at once. */
  active?: boolean
  /** Dimmed: available, but nothing is happening in it. */
  resting?: boolean
  icon: React.ReactNode
  onPress: () => void
}

export type DutyHeadline = {
  /**
   * Two short lines, stacked, the way a car app stacks charge over range. Each
   * has to survive being set at 36px, so both are numerals or near enough.
   */
  primary: string
  secondary?: string
  /** Where the person is, then what that adds up to. */
  context: string
  summary: string
  /** 0–1. Drawn as one thick bar split at the fill point. */
  progress?: number
  accent: string
  /** Sits behind the header, enormous and barely visible. Identity, not data. */
  ghost?: string
}

export function DutyHome({
  headline,
  notice,
  tiles,
}: {
  headline: DutyHeadline
  /** Something that has already happened and cannot be undone. Rare by design. */
  notice?: string
  tiles: DutyTile[]
}) {
  const rows: DutyTile[][] = []
  for (let index = 0; index < tiles.length; index += 2) {
    rows.push(tiles.slice(index, index + 2))
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.body}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.head}>
            {headline.ghost ? (
              <Text allowFontScaling={false} numberOfLines={1} style={styles.ghost}>
                {headline.ghost}
              </Text>
            ) : null}

            <Text allowFontScaling={false} numberOfLines={1} style={styles.value}>
              {headline.primary}
            </Text>
            {headline.secondary ? (
              <Text allowFontScaling={false} numberOfLines={1} style={styles.value}>
                {headline.secondary}
              </Text>
            ) : null}

            {headline.progress === undefined ? null : (
              <ValueBar accent={headline.accent} progress={headline.progress} />
            )}

            {/* The pause below the bar is the signature. With no bar to pause
                after it is just a hole, so it closes up. */}
            <View
              style={[styles.identity, headline.progress === undefined ? styles.identityTight : null]}
            >
              <Text numberOfLines={1} style={styles.context}>
                {headline.context}
              </Text>
              <Text numberOfLines={1} style={styles.summary}>
                {headline.summary}
              </Text>
            </View>
          </View>

          {notice ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>{notice}</Text>
            </View>
          ) : null}

          <View style={styles.grid}>
            {rows.map((row, rowIndex) => (
              <View key={rowIndex} style={styles.gridRow}>
                {row.map((tile) => (
                  <Tile key={tile.key} tile={tile} />
                ))}
                {row.length === 1 ? <View style={styles.tileFiller} /> : null}
              </View>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  )
}

/**
 * One thick bar cut in two at the fill point, rather than a track with a filled
 * portion inside it. The gap is what makes the fraction legible without anyone
 * measuring the ends.
 */
function ValueBar({ accent, progress }: { accent: string; progress: number }) {
  const filled = Math.max(0, Math.min(1, progress))
  const whole = filled === 0 || filled === 1
  return (
    <View style={styles.bar}>
      {filled > 0 ? <View style={{ flex: filled, backgroundColor: accent }} /> : null}
      {whole ? null : <View style={styles.barGap} />}
      {filled < 1 ? <View style={{ flex: 1 - filled, backgroundColor: palette.strong }} /> : null}
    </View>
  )
}

function Tile({ tile }: { tile: DutyTile }) {
  const { accent, ink } = duty[tile.key]
  const filled = tile.active === true
  const statusColour = filled ? ink : tile.resting === true ? palette.muted : accent
  return (
    <Pressable
      accessibilityLabel={`${tile.label}. ${tile.status}`}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.tile,
        filled ? { backgroundColor: accent } : null,
        pressed ? styles.tilePressed : null,
      ]}
      onPress={tile.onPress}
    >
      <Text numberOfLines={1} style={[styles.tileLabel, filled ? { color: ink } : null]}>
        {tile.label}
      </Text>
      <Text numberOfLines={2} style={[styles.tileStatus, { color: statusColour }]}>
        {tile.status}
      </Text>
      {/* Empty space above the icon is what makes a card legible at arm's
          length instead of cramped. */}
      <View style={[styles.tileIcon, filled || tile.resting !== true ? null : styles.dim]}>
        {tile.icon}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  body: { flex: 1 },
  scroll: { paddingBottom: 18 },

  head: {
    position: 'relative',
    paddingTop: 22,
    paddingBottom: 27,
    paddingHorizontal: space.text,
    overflow: 'hidden',
  },
  ghost: {
    position: 'absolute',
    right: -14,
    top: -12,
    color: palette.ghost,
    ...type.ghost,
  },
  value: { color: palette.text, ...type.value },

  /* Narrow and thick: a wide thin bar reads as a progress meter, which this is
     not — it is a state at a glance. */
  bar: { flexDirection: 'row', width: 117, height: 29, marginTop: 13 },
  barGap: { width: 3 },

  identity: { marginTop: space.breath },
  identityTight: { marginTop: 42 },
  context: { color: palette.muted, ...type.context },
  summary: { marginTop: 3, color: palette.text, ...type.summary },

  notice: {
    marginHorizontal: space.grid,
    marginBottom: space.tileGapY,
    padding: 14,
    borderLeftWidth: 3,
    borderLeftColor: palette.urgent,
    backgroundColor: palette.tile,
  },
  noticeText: { color: palette.text, fontSize: 15, lineHeight: 21 },

  grid: { paddingHorizontal: space.grid, gap: space.tileGapY },
  gridRow: { flexDirection: 'row', gap: space.tileGapX },
  tile: {
    flex: 1,
    aspectRatio: tileAspectRatio,
    padding: space.tile,
    backgroundColor: palette.tile,
  },
  tilePressed: { opacity: 0.75 },
  tileFiller: { flex: 1 },

  tileLabel: { color: palette.text, ...type.tileLabel },
  tileStatus: { marginTop: 2, ...type.tileStatus },
  dim: { opacity: 0.5 },
  tileIcon: { marginTop: 'auto' },
})
