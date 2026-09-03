export const palette = {
  background: "#0A0A0B",
  tile: "#1B1B1D",
  strong: "#343437",

  text: "#ECECEE",
  muted: "#A0A0A5",
  faint: "#6D6D72",

  judging: "#8FB99F",
  door: "#91AAC2",
  hall: "#C29A78",
  setup: "#AA9CBC",
  pulse: "#C3B77C",
  urgent: "#D78680",

  onJudging: "#04140C",
  onDoor: "#050D18",
  onHall: "#180A00",
  onSetup: "#120A24",
  onPulse: "#171200",
  onUrgent: "#1B0503",
} as const;

export const space = {
  text: 21,
  grid: 11,
  tileGapX: 16,
  tileGapY: 13,
  tile: 16,
  breath: 80,
} as const;

export const radius = {
  tile: 10,
  control: 10,
  pill: 999,
} as const;

export const type = {
  value: { fontSize: 36, fontWeight: "500", letterSpacing: -0.8, lineHeight: 37 },
  context: { fontSize: 15, fontWeight: "400" },
  summary: { fontSize: 17, fontWeight: "400" },
  tileLabel: { fontSize: 17, fontWeight: "400" },
  tileStatus: { fontSize: 17, fontWeight: "400" },
  body: { fontSize: 15 },
  small: { fontSize: 13 },
} as const;

export const tileAspectRatio = 176 / 213;

export type DutyKey = "judging" | "door" | "hall" | "help" | "pulse" | "incident";

export const duty: Record<DutyKey, { accent: string; ink: string }> = {
  judging: { accent: palette.judging, ink: palette.onJudging },
  door: { accent: palette.door, ink: palette.onDoor },
  hall: { accent: palette.hall, ink: palette.onHall },
  help: { accent: palette.setup, ink: palette.onSetup },
  pulse: { accent: palette.pulse, ink: palette.onPulse },
  incident: { accent: palette.urgent, ink: palette.onUrgent },
};
