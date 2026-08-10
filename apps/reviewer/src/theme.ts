/**
 * The event app's own visual language.
 *
 * Deliberately not the operations dashboard's. The dashboard is a dense surface
 * for someone sitting down with a screen; this is used standing up, one-handed,
 * in a loud hall, often at three in the morning, by a volunteer briefed once.
 *
 * The shape is a car app's home screen: a two-line value with a thick split bar
 * under it, one enormous low-contrast numeral behind, then a grid of tall cards
 * where every duty that is actually running fills solid in its own colour. The
 * air inside a card is the point — it is what makes it readable at arm's length.
 */

export const palette = {
  /** Near-black. The cards have to read as raised against it. */
  background: '#0A0A0B',
  /** A real step up from the background, not a hint of one. */
  tile: '#2C2C2E',
  /** The unfilled half of the value bar. */
  strong: '#4A4A4D',
  /** The numeral behind the header. Just above the card grey. */
  ghost: '#232325',

  text: '#F2F2F4',
  muted: '#8E8E93',
  faint: '#636367',

  /** Duty colours. Each keeps its meaning everywhere it appears. */
  judging: '#3ED88A',
  door: '#4C9BFF',
  hall: '#FF6B00',
  setup: '#B79CFF',
  pulse: '#FFD60A',
  urgent: '#FF453A',

  /** Ink used on top of a filled tile, per duty. */
  onJudging: '#04140C',
  onDoor: '#050D18',
  onHall: '#180A00',
  onSetup: '#120A24',
  onPulse: '#171200',
  onUrgent: '#1B0503',
} as const

/** Measured off the Polestar home screen at a 393pt viewport. */
export const space = {
  /** Header text is inset further than the card grid, as it is there. */
  text: 21,
  /** The grid sits close to the screen edge. */
  grid: 11,
  /** Between two cards in a row, and between rows. */
  tileGapX: 16,
  tileGapY: 13,
  tile: 16,
  /** The pause between the bar and the identity line. Unusually large. */
  breath: 80,
} as const

export const radius = {
  /** Surfaces that hold content: soft enough to read as one object. */
  tile: 18,
  /** Anything you press. Every comparable app makes these a full pill. */
  control: 999,
  pill: 999,
} as const

export const type = {
  /** The headline value. Two lines, tight, never wrapped mid-number. */
  value: { fontSize: 36, fontWeight: '500', letterSpacing: -0.8, lineHeight: 37 },
  /**
   * The numeral sitting behind everything. Identity, not information — but it
   * still has to read as a digit. Past roughly this size it stops being a
   * numeral and becomes a grey shape.
   */
  ghost: { fontSize: 250, fontWeight: '500', letterSpacing: -10, lineHeight: 230 },
  /** Identity: what this is, then how it is doing. */
  context: { fontSize: 15, fontWeight: '400' },
  summary: { fontSize: 17, fontWeight: '400' },
  /** Both card lines are the same size; only their colour differs. */
  tileLabel: { fontSize: 17, fontWeight: '400' },
  tileStatus: { fontSize: 17, fontWeight: '400' },
  body: { fontSize: 15 },
  small: { fontSize: 13 },
} as const

/** Card proportions: noticeably taller than wide. */
export const tileAspectRatio = 176 / 213

export type DutyKey = 'judging' | 'door' | 'hall' | 'help' | 'pulse' | 'incident'

/** Colour and ink for a duty, so a tile never has to choose them itself. */
export const duty: Record<DutyKey, { accent: string; ink: string }> = {
  judging: { accent: palette.judging, ink: palette.onJudging },
  door: { accent: palette.door, ink: palette.onDoor },
  hall: { accent: palette.hall, ink: palette.onHall },
  help: { accent: palette.setup, ink: palette.onSetup },
  pulse: { accent: palette.pulse, ink: palette.onPulse },
  /* An incident borrows the urgent red outright: a declared emergency and the
     colour the whole app already uses for one are the same fact. */
  incident: { accent: palette.urgent, ink: palette.onUrgent },
}
