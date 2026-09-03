export function timeLabel(timestamp: number, timezone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    ...(timezone ? { timeZone: timezone } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function dayTimeLabel(timestamp: number, timezone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    ...(timezone ? { timeZone: timezone } : {}),
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}
