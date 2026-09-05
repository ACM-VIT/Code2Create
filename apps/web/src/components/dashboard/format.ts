const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(style: "time" | "dayTime", timezone?: string) {
  const key = timezone === undefined ? style : `${style}:${timezone}`;
  let value = timeFormatters.get(key);
  if (!value) {
    value = new Intl.DateTimeFormat(undefined, {
      ...(timezone === undefined ? {} : { timeZone: timezone }),
      ...(style === "time"
        ? { hour: "numeric", minute: "2-digit" }
        : { weekday: "short", hour: "numeric", minute: "2-digit" }),
    });
    timeFormatters.set(key, value);
  }
  return value;
}

export function timeLabel(timestamp: number, timezone?: string) {
  return formatter("time", timezone || undefined).format(timestamp);
}

export function dayTimeLabel(timestamp: number, timezone?: string) {
  return formatter("dayTime", timezone || undefined).format(timestamp);
}
