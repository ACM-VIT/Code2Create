export function formatClockTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

export function formatCompactDateTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

export function formatMediumDateTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value)
}

export function formatMonthDayTime(value: number, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    ...(timeZone ? { timeZone } : {}),
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

export function formatMonthDayTimeWindow(
  startsAt: number,
  endsAt: number,
  timeZone?: string,
) {
  return `${formatMonthDayTime(startsAt, timeZone)} – ${formatMonthDayTime(endsAt, timeZone)}`
}

export function formatZonedDateTimeWindow(
  startsAt: number,
  endsAt: number,
  timeZone: string,
) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  return `${formatter.format(startsAt)} – ${formatter.format(endsAt)}`
}

export function formatZonedTime(value: number, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    timeStyle: 'short',
  }).format(value)
}
