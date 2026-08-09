import { Pressable, StyleSheet, Text, View } from 'react-native'

import { type DutyKey, duty, palette, space, type } from '@/theme'

export type DutyTile = {
  key: DutyKey
  /** What the duty is called, in the words a volunteer would use. */
  label: string
  /** Its live state — a fact, never an instruction. */
  status: string
  /** True for the one duty this person is part-way through right now. */
  active?: boolean
  /** Dimmed: available, but nothing is happening in it. */
  resting?: boolean
  icon: React.ReactNode
  onPress: () => void
}

export type DutyHeadline = {
  /** The number that is actually changing. Kept apart from its unit so the
      unit can sit smaller on the same baseline without wrapping. */
  value: string
  unit?: string
  /** Where the person is. */
  context: string
  /** What that adds up to, in one short clause. */
  summary: string
  /** 0–1. Drawn as three segments rather than one bar, so partial progress
      reads at a glance instead of needing to be measured. */
  progress?: number
  accent: string
  /** Sits behind everything, enormous and barely visible. Identity, not data. */
  ghost?: string
}

const segmentCount = 3

export function DutyHome({
  headline,
  tiles,
}: {
  headline: DutyHeadline
  tiles: DutyTile[]
}) {
  return (
    <View style={styles.root}>
      <View style={styles.head}>
        {headline.ghost ? (
          <Text allowFontScaling={false} numberOfLines={1} style={styles.ghost}>
            {headline.ghost}
          </Text>
        ) : null}

        <View style={styles.valueRow}>
          <Text allowFontScaling={false} style={styles.value}>
            {headline.value}
          </Text>
          {headline.unit ? (
            <Text allowFontScaling={false} style={styles.unit}>
              {headline.unit}
            </Text>
          ) : null}
        </View>

        {headline.progress === undefined ? null : (
          <Segments accent={headline.accent} progress={headline.progress} />
        )}

        <Text style={styles.context}>{headline.context}</Text>
        <Text style={styles.summary}>{headline.summary}</Text>
      </View>

      <View style={styles.grid}>
        {tiles.map((tile) => (
          <Tile key={tile.key} tile={tile} />
        ))}
      </View>
    </View>
  )
}

/**
 * Three blocks with gaps rather than one continuous bar. A fraction of the way
 * along a segmented track is legible without reading a number next to it.
 */
function Segments({ accent, progress }: { accent: string; progress: number }) {
  const filled = Math.max(0, Math.min(1, progress)) * segmentCount
  return (
    <View style={styles.segments}>
      {Array.from({ length: segmentCount }, (_, index) => {
        const share = Math.max(0, Math.min(1, filled - index))
        return (
          <View key={index} style={styles.segment}>
            {share > 0 ? (
              <View
                style={[styles.segmentFill, { backgroundColor: accent, flex: share }]}
              />
            ) : null}
            {share < 1 ? <View style={{ flex: 1 - share }} /> : null}
          </View>
        )
      })}
    </View>
  )
}

function Tile({ tile }: { tile: DutyTile }) {
  const { accent, ink } = duty[tile.key]
  const filled = tile.active === true
  return (
    <Pressable
      accessibilityLabel={`${tile.label}. ${tile.status}`}
      accessibilityRole="button"
      style={[styles.tile, filled ? { backgroundColor: accent } : null]}
      onPress={tile.onPress}
    >
      <Text style={[styles.dots, filled ? { color: ink, opacity: 0.5 } : null]}>•••</Text>
      <Text
        style={[
          styles.tileLabel,
          filled ? { color: ink, opacity: 0.72 } : null,
          tile.resting === true ? styles.restingLabel : null,
        ]}
      >
        {tile.label}
      </Text>
      <Text
        numberOfLines={2}
        style={[
          styles.tileStatus,
          { color: tile.resting === true ? palette.faint : accent },
          filled ? { color: ink, opacity: 0.86 } : null,
        ]}
      >
        {tile.status}
      </Text>
      <View
        style={[
          styles.tileIcon,
          filled ? { opacity: 0.9 } : tile.resting === true ? { opacity: 0.4 } : null,
        ]}
      >
        {tile.icon}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },

  head: {
    position: 'relative',
    paddingTop: 10,
    paddingBottom: 22,
    paddingHorizontal: space.screen,
    overflow: 'hidden',
  },
  ghost: {
    position: 'absolute',
    right: -18,
    top: -14,
    color: '#1B1B1E',
    ...type.ghost,
  },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  value: { color: palette.text, ...type.value },
  unit: { color: palette.muted, ...type.valueUnit },

  segments: { flexDirection: 'row', gap: 4, width: 156, height: 12, marginTop: 12 },
  segment: { flex: 1, flexDirection: 'row', backgroundColor: palette.strong, overflow: 'hidden' },
  segmentFill: { height: '100%' },

  context: { marginTop: 20, color: palette.muted, ...type.small },
  summary: { marginTop: 2, color: palette.text, ...type.title },

  /* Tiles share a seam rather than floating in gutters. */
  grid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 1,
    backgroundColor: palette.seam,
  },
  tile: {
    width: '50%',
    flexGrow: 1,
    flexBasis: '48%',
    minHeight: 132,
    padding: space.tile,
    backgroundColor: palette.tile,
  },
  dots: { position: 'absolute', top: 12, right: 13, color: palette.faint, fontSize: 12 },
  tileLabel: { color: palette.muted, ...type.tileLabel },
  restingLabel: { opacity: 0.6 },
  tileStatus: { marginTop: 2, ...type.tileStatus },
  /* The icon sits at the foot of the tile with empty space above it — that gap
     is what makes a tile readable from arm's length rather than cramped. */
  tileIcon: { marginTop: 'auto' },
})
