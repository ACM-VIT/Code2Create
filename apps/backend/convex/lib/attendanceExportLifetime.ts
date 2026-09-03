export const attendanceExportLifetimes = [
  "fifteen_minutes",
  "one_hour",
  "one_day",
  "three_days",
  "seven_days",
] as const;

export type AttendanceExportLifetime = (typeof attendanceExportLifetimes)[number];

const lifetimeMilliseconds: Record<AttendanceExportLifetime, number> = {
  fifteen_minutes: 15 * 60 * 1_000,
  one_hour: 60 * 60 * 1_000,
  one_day: 24 * 60 * 60 * 1_000,
  three_days: 3 * 24 * 60 * 60 * 1_000,
  seven_days: 7 * 24 * 60 * 60 * 1_000,
};

export function attendanceExportExpiresAt(lifetime: AttendanceExportLifetime, requestedAt: number) {
  return requestedAt + lifetimeMilliseconds[lifetime];
}
