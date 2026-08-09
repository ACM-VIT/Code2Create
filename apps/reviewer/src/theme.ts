/**
 * The event app's own visual language.
 *
 * Deliberately not the operations dashboard's. The dashboard is a dense surface
 * for someone sitting down with a screen; this is used standing up, one-handed,
 * in a loud hall, often at three in the morning, by a volunteer briefed once.
 *
 * The shape comes from a car app's home screen: a large two-line value with a
 * segmented bar beneath it, one enormous low-contrast numeral behind everything,
 * and a seamed grid of tall tiles where the duty you are doing right now fills
 * solid. Emptiness inside a tile is what makes it readable at arm's length, so
 * the padding here is generous on purpose.
 */

export const palette = {
  /** Near-black, slightly warm so it does not look blue under hall lighting. */
  background: '#0B0B0C',
  /** Tiles sit just above the background; the 1px seam between them is this. */
  tile: '#100F12',
  seam: '#17171A',
  raised: '#17171A',
  strong: '#232327',

  text: '#EDEDEF',
  muted: '#7C7C85',
  faint: '#55555C',

  /** Duty colours. Each keeps its meaning everywhere it appears. */
  judging: '#3ED88A',
  door: '#59A6FF',
  hall: '#FF7A2F',
  setup: '#B79CFF',
  urgent: '#FF5A4E',

  /** Ink used on top of a filled tile, per duty. */
  onJudging: '#06170F',
  onDoor: '#08101C',
  onHall: '#12100E',
  onSetup: '#140D26',
  onUrgent: '#1B0705',
} as const

export const space = {
  screen: 18,
  tile: 14,
  gap: 12,
} as const

export const radius = {
  tile: 0,
  control: 16,
  pill: 999,
} as const

export const type = {
  /** The headline value. Two lines, tight, never wrapped mid-number. */
  value: { fontSize: 34, fontWeight: '500', letterSpacing: -0.8, lineHeight: 37 },
  valueUnit: { fontSize: 20, fontWeight: '500' },
  /** The numeral sitting behind everything. Identity, not information. */
  ghost: { fontSize: 168, fontWeight: '700', letterSpacing: -6, lineHeight: 150 },
  title: { fontSize: 15, fontWeight: '500' },
  tileLabel: { fontSize: 13 },
  tileStatus: { fontSize: 14, fontWeight: '500' },
  body: { fontSize: 14 },
  small: { fontSize: 12.5 },
} as const

export type DutyKey = 'judging' | 'door' | 'hall' | 'help'

/** Colour and ink for a duty, so a tile never has to choose them itself. */
export const duty: Record<DutyKey, { accent: string; ink: string }> = {
  judging: { accent: palette.judging, ink: palette.onJudging },
  door: { accent: palette.door, ink: palette.onDoor },
  hall: { accent: palette.hall, ink: palette.onHall },
  help: { accent: palette.setup, ink: palette.onSetup },
}
