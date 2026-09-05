const dateTimeOptions = {
  clock: {
    hour: "2-digit",
    minute: "2-digit",
  },
  compact: {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  },
  medium: {
    dateStyle: "medium",
    timeStyle: "short",
  },
  monthDay: {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
  time: { timeStyle: "short" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(style: keyof typeof dateTimeOptions, timeZone?: string) {
  const key = timeZone === undefined ? style : `${style}:${timeZone}`;
  let formatter = dateTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, {
      ...dateTimeOptions[style],
      ...(timeZone === undefined ? {} : { timeZone }),
    });
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatClockTime(value: number) {
  return dateTimeFormatter("clock").format(value);
}

export function formatCompactDateTime(value: number) {
  return dateTimeFormatter("compact").format(value);
}

export function formatMediumDateTime(value: number) {
  return dateTimeFormatter("medium").format(value);
}

export function formatMonthDayTime(value: number, timeZone?: string) {
  return dateTimeFormatter("monthDay", timeZone || undefined).format(value);
}

export function formatMonthDayTimeWindow(startsAt: number, endsAt: number, timeZone?: string) {
  return `${formatMonthDayTime(startsAt, timeZone)} – ${formatMonthDayTime(endsAt, timeZone)}`;
}

export function formatZonedDateTimeWindow(startsAt: number, endsAt: number, timeZone: string) {
  const formatter = dateTimeFormatter("medium", timeZone);
  return `${formatter.format(startsAt)} – ${formatter.format(endsAt)}`;
}

export function formatZonedTime(value: number, timeZone: string) {
  return dateTimeFormatter("time", timeZone).format(value);
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
