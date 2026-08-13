
export const palette = {
  background: '#0A0A0B',
  tile: '#2C2C2E',
  strong: '#4A4A4D',
  ghost: '#232325',

  text: '#F2F2F4',
  muted: '#8E8E93',
  faint: '#636367',

  judging: '#3ED88A',
  door: '#4C9BFF',
  hall: '#FF6B00',
  setup: '#B79CFF',
  pulse: '#FFD60A',
  urgent: '#FF453A',

  onJudging: '#04140C',
  onDoor: '#050D18',
  onHall: '#180A00',
  onSetup: '#120A24',
  onPulse: '#171200',
  onUrgent: '#1B0503',
} as const

export const space = {
  text: 21,
  grid: 11,
  tileGapX: 16,
  tileGapY: 13,
  tile: 16,
  breath: 80,
} as const

export const radius = {
  tile: 18,
  control: 999,
  pill: 999,
} as const

export const type = {
  value: { fontSize: 36, fontWeight: '500', letterSpacing: -0.8, lineHeight: 37 },
  ghost: { fontSize: 250, fontWeight: '500', letterSpacing: -10, lineHeight: 230 },
  context: { fontSize: 15, fontWeight: '400' },
  summary: { fontSize: 17, fontWeight: '400' },
  tileLabel: { fontSize: 17, fontWeight: '400' },
  tileStatus: { fontSize: 17, fontWeight: '400' },
  body: { fontSize: 15 },
  small: { fontSize: 13 },
} as const

export const tileAspectRatio = 176 / 213

export type DutyKey = 'judging' | 'door' | 'hall' | 'help' | 'pulse' | 'incident'

export const duty: Record<DutyKey, { accent: string; ink: string }> = {
  judging: { accent: palette.judging, ink: palette.onJudging },
  door: { accent: palette.door, ink: palette.onDoor },
  hall: { accent: palette.hall, ink: palette.onHall },
  help: { accent: palette.setup, ink: palette.onSetup },
  pulse: { accent: palette.pulse, ink: palette.onPulse },
  incident: { accent: palette.urgent, ink: palette.onUrgent },
}
