export function formatClockTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export function formatCompactDateTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export function formatMediumDateTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export function formatMonthDayTime(value: number, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    ...(timeZone ? { timeZone } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

export function formatMonthDayTimeWindow(startsAt: number, endsAt: number, timeZone?: string) {
  return `${formatMonthDayTime(startsAt, timeZone)} – ${formatMonthDayTime(endsAt, timeZone)}`;
}

export function formatZonedDateTimeWindow(startsAt: number, endsAt: number, timeZone: string) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `${formatter.format(startsAt)} – ${formatter.format(endsAt)}`;
}

export function formatZonedTime(value: number, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    timeStyle: "short",
  }).format(value);
}

/** "in 12 min", "2 h ago" — for schedules and freshness where a clock time reads worse. */
export function formatRelativeTime(value: number, now = Date.now()) {
  const deltaMs = value - now;
  const future = deltaMs > 0;
  const minutes = Math.round(Math.abs(deltaMs) / 60_000);
  if (minutes < 1) return future ? "in under a minute" : "just now";
  const amount =
    minutes < 60
      ? `${minutes} min`
      : minutes < 24 * 60
        ? `${Math.round(minutes / 60)} h`
        : `${Math.round(minutes / (24 * 60))} d`;
  return future ? `in ${amount}` : `${amount} ago`;
}
